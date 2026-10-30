import {
  accessSync,
  constants,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
} from 'electron';
import {
  type BundleSignResult,
  type DatabaseResult,
  DEPLOY_TARGETS,
  type DeployResult,
  type DeployTarget,
  GATE_NAME,
  IMPORT_FROM,
  type ImportFrom,
  type ImportResult,
  IPC,
  PROJECT_ID,
  type PasskeyEnrollResult,
  type PasskeyStatus,
  type ProjectAddResult,
  type ProjectCreateResult,
  type RequestLogResult,
  type SecretSealResult,
  type SigningKeyInfo,
  type SigningKeyResult,
  type SigningKeyStatus,
} from '../shared/bridge';
import { type RunningApi, startApi } from './api-host';
import {
  legacyKeyMigration,
  readConfig,
  updateConfig,
  withProjectKey,
} from './lib/config';
import { previousKeyAfter } from './lib/key-rotation';
import { confirmed, passkeyGatesAfter } from './lib/state-change';
import {
  type DesktopMessages,
  MESSAGES,
  pageLocale,
  systemLocale,
} from './lib/messages';
import {
  deployFiles,
  deployRefusal,
  packageName,
  writeDeployFolder,
  writeDeployZip,
} from './lib/deploy';
import {
  importOutcome,
  listPackageFolder,
  MAX_IMPORT_FILE_BYTES,
  readImportFile,
  readPackageFile,
} from './lib/import';
import { KeyCreationSession, writeKeyFile } from './lib/key-creation';
import { logOutcome, MAX_LOG_FILES, readLogFiles } from './lib/request-log';
import { gitRunner, runGitDeploy } from './lib/git-deploy';
import { readPrivateKey, SftpSession } from './lib/sftp';
import { uploadPackage } from './lib/sftp-client';
import { FtpsSession } from './lib/ftps';
import { uploadPackage as uploadFtpsPackage } from './lib/ftps-client';
import { registerFtpsDialogIpc, showFtpsDialog } from './ftps-window';
import { registerSftpDialogIpc, showSftpDialog } from './sftp-window';
import { gateTestConfirmation } from './lib/test-confirmation';
import {
  PassphraseVault,
  type PlanSigner,
  readKeyFile,
  SigningSession,
} from './lib/signing';
import { SealingSession } from './lib/sealing';
import { gateKey, passkeyGatesOf, passkeyPlanSigner } from './lib/passkey';
import { enrollPasskey, passkeyInfo, signWithPasskey } from './passkey-flow';
import { registerPasskeyDialogIpc } from './passkey-window';
import { registerKeyDialogIpc, showKeyDialog } from './key-window';
import { registerSealDialogIpc, showSealDialog } from './seal-window';
import { registerSignDialogIpc, showSignDialog } from './sign-window';
import { APP_ORIGIN, isAppUrl } from './lib/web-protocol';
import { handleAppScheme, registerAppScheme } from './protocol';
import {
  registerDatabaseDialogIpc,
  showDatabaseDialog,
} from './database-window';
import { DatabaseSession, defaultDatabaseKey } from './lib/database';
import { DATABASE_MESSAGES } from './lib/database-messages';

// The packaged app and a dev run (`pnpm start:desktop`) must never share settings.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'moat-desktop-dev'));
}

// One instance per user: a second window would race the first on the same project.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

registerAppScheme();

/** main.js, preload.js, api/ and web/ sit next to each other (scripts/stage.mjs). */
const appDir = __dirname;

let mainWindow: BrowserWindow | null = null;
let api: RunningApi | null = null;
let shutdownDone = false;

const messages = () => MESSAGES[systemLocale(app.getLocale())];

/** A question of the main process, outside the page; a no (or closing it) is the default. */
async function askYesNo(
  title: string,
  message: string,
  detail: string,
  yes: string,
  no: string,
): Promise<boolean> {
  const options = {
    type: 'question' as const,
    title,
    message,
    detail,
    buttons: [yes, no],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } =
    mainWindow === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(mainWindow, options);
  return response === 0;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// DT-08: nothing in the window may open other windows, navigate away, or embed other content.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
  if (shutdownDone || api === null) return;
  event.preventDefault();
  const closing = api;
  api = null;
  void closing.close().finally(() => {
    shutdownDone = true;
    app.quit();
  });
});

void app.whenReady().then(start);

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  try {
    api = await startApi({
      appDir,
      dataDir: userData,
      packaged: app.isPackaged,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error('[desktop] start failed', error);
    dialog.showErrorBox(
      messages().startFailed.title,
      messages().startFailed.detail(reason),
    );
    shutdownDone = true;
    app.quit();
    return;
  }

  // «Testen» (T-59): each new address is confirmed here, outside the page.
  let testLocale = '';
  const confirmTest = gateTestConfirmation(async (origin, host) => {
    const text = MESSAGES[pageLocale(testLocale, app.getLocale())].testRequest;
    const options = {
      type: 'question' as const,
      title: text.title,
      message: text.message(host),
      detail: text.detail(origin),
      buttons: [text.send, text.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } =
      mainWindow === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(mainWindow, options);
    return response === 0;
  });
  api.setGateTestConfirmation((target, locale) => {
    testLocale = locale;
    return confirmTest(target);
  });

  // The first builds remembered one folder: move it into the project list once.
  const legacy = readConfig(userData).projectDir;
  if (legacy !== null) {
    if (isFolder(legacy)) await api.addProject(legacy).catch(() => undefined);
    updateConfig(userData, { projectDir: null });
  }
  // Builds before per-project keys signed every project with one key: each listed project keeps
  // it as its own, once (a gate that pins it goes on accepting what is signed).
  const keyMove = legacyKeyMigration(
    readConfig(userData),
    await api.projectIds().catch(() => []),
  );
  if (keyMove !== null) updateConfig(userData, keyMove);
  // A folder given on the command line (`--project=<dir>`) is added and opened: demos and tests.
  const projectArg = process.argv
    .find((arg) => arg.startsWith('--project='))
    ?.slice('--project='.length);
  let startPath = '/app/projects';
  if (projectArg !== undefined && projectArg !== '') {
    const dir = resolve(projectArg);
    if (isFolder(dir)) {
      try {
        const { id } = await api.addProject(dir);
        startPath = `/app/projects/${id}`;
      } catch {
        // A full list: start on the list instead.
      }
    }
  }

  handleAppScheme(join(appDir, 'web'), api);
  // The app needs no camera, microphone, notifications, … — refuse every permission request.
  session.defaultSession.setPermissionRequestHandler((_wc, _p, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  registerIpc();
  Menu.setApplicationMenu(buildMenu());
  createWindow(startPath);
}

function createWindow(startPath: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 375,
    minHeight: 500,
    title: 'Moat',
    show: false,
    webPreferences: {
      preload: join(appDir, 'preload.js'),
      // DT-08: no Node in the page, isolated preload, sandboxed renderer.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(`${APP_ORIGIN}${startPath}`);
}

/** Answers only the app's own page (DT-08); the handlers take no arguments from it. */
function fromApp(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url);
}

function registerIpc(): void {
  ipcMain.handle(IPC.projectAdd, async (event): Promise<ProjectAddResult> => {
    if (!fromApp(event) || mainWindow === null || api === null) {
      return { status: 'failed' };
    }
    const text = messages().chooseProject;
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: text.title,
      buttonLabel: text.button,
      properties: ['openDirectory'],
    });
    const dir = picked.filePaths[0];
    if (picked.canceled || dir === undefined) return { status: 'cancelled' };
    try {
      if (!isFolder(dir)) return { status: 'failed' };
      accessSync(dir, constants.R_OK);
      return { status: 'added', id: (await api.addProject(dir)).id };
    } catch {
      return { status: 'failed' };
    }
  });
  // «Neues Projekt» (FR-73): like projectAdd, plus a new moat.yaml in the chosen folder.
  ipcMain.handle(
    IPC.projectCreate,
    async (event): Promise<ProjectCreateResult> => {
      if (!fromApp(event) || mainWindow === null || api === null) {
        return { status: 'failed' };
      }
      const text = messages().createProject;
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: text.title,
        buttonLabel: text.button,
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      });
      const dir = picked.filePaths[0];
      if (picked.canceled || dir === undefined) return { status: 'cancelled' };
      try {
        if (!isFolder(dir)) return { status: 'failed' };
        accessSync(dir, constants.R_OK | constants.W_OK);
        const { id, created } = await api.createProject(dir);
        return { status: 'added', id, created };
      } catch {
        return { status: 'failed' };
      }
    },
  );
  // A project's signing key (FR-73, DT-15): the page learns only its public half, never the path.
  ipcMain.handle(
    IPC.keyStatus,
    async (event, id: unknown): Promise<SigningKeyStatus> => {
      if (!fromApp(event) || api === null) return { status: 'unreadable' };
      if (typeof id !== 'string' || !PROJECT_ID.test(id))
        return { status: 'unreadable' };
      const entry = readConfig(app.getPath('userData')).projectKeys[id];
      if (entry === undefined) return { status: 'none' };
      const key = await keyInfo(api, entry.keyFile);
      if (key === null) return { status: 'unreadable' };
      return {
        status: 'ready',
        key,
        previous:
          entry.previousKey === null
            ? null
            : await api.signingKeyInfo(entry.previousKey),
      };
    },
  );
  // SEC-08: the person says every gate of the project now pins the new key alone; the old key
  // is forgotten.
  ipcMain.handle(
    IPC.keyRotationDone,
    async (event, id: unknown, locale: unknown): Promise<boolean> => {
      if (!fromApp(event)) return false;
      if (typeof id !== 'string' || !PROJECT_ID.test(id)) return false;
      const userData = app.getPath('userData');
      if (readConfig(userData).projectKeys[id] === undefined) return false;
      const text = MESSAGES[pageLocale(locale, app.getLocale())].confirmChange;
      return confirmed(
        () =>
          askYesNo(
            text.keyRotationDone.title,
            text.keyRotationDone.message,
            text.keyRotationDone.detail,
            text.keyRotationDone.confirm,
            text.cancel,
          ),
        () => {
          const config = readConfig(userData);
          const entry = config.projectKeys[id];
          if (entry === undefined) return;
          updateConfig(userData, {
            projectKeys: withProjectKey(config, id, {
              ...entry,
              previousKey: null,
            }),
          });
        },
      );
    },
  );
  ipcMain.handle(
    IPC.keyChoose,
    async (event, id: unknown): Promise<SigningKeyResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
      if (typeof id !== 'string' || !PROJECT_ID.test(id))
        return { status: 'failed' };
      if ((await api.projectFolder(id)) === null) return { status: 'failed' };
      const text = messages().chooseKey;
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: text.title,
        buttonLabel: text.button,
        properties: ['openFile'],
        filters: [{ name: text.filter, extensions: ['moatkey'] }],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || file === undefined) return { status: 'cancelled' };
      const key = await keyInfo(api, file);
      if (key === null) return { status: 'unreadable' };
      await useProjectKey(api, app.getPath('userData'), id, file, key);
      return { status: 'chosen', key };
    },
  );
  ipcMain.handle(
    IPC.keyCreate,
    async (event, id: unknown, locale: unknown): Promise<SigningKeyResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
      if (typeof id !== 'string' || !PROJECT_ID.test(id))
        return { status: 'failed' };
      if ((await api.projectFolder(id)) === null) return { status: 'failed' };
      const text = MESSAGES[pageLocale(locale, app.getLocale())];
      const parent = mainWindow;
      const running = api;
      const userData = app.getPath('userData');
      const session = new KeyCreationSession({
        texts: text.keyDialog,
        chooseTarget: async () => {
          const owner = BrowserWindow.getFocusedWindow() ?? parent;
          const picked = await dialog.showSaveDialog(owner, {
            title: text.saveKey.title,
            buttonLabel: text.saveKey.button,
            defaultPath: join(
              app.getPath('documents'),
              text.saveKey.defaultName,
            ),
            filters: [{ name: text.saveKey.filter, extensions: ['moatkey'] }],
            // No overwrite prompt: a key file is never replaced (`wx`), the window says so.
            properties: ['createDirectory'],
          });
          return picked.canceled || picked.filePath === undefined
            ? null
            : picked.filePath;
        },
        create: (passphrase) => running.createSigningKey(passphrase),
        write: writeKeyFile,
        use: async (path) => {
          const next = await keyInfo(running, path);
          if (next !== null)
            await useProjectKey(running, userData, id, path, next);
        },
      });
      try {
        return await showKeyDialog({
          parent,
          appDir,
          title: text.keyDialog.title,
          session,
        });
      } catch {
        console.error('[desktop] creating the key failed');
        return { status: 'failed' };
      }
    },
  );
  registerKeyDialogIpc();
  // The page passes only an id; the folder comes from the API's own list.
  ipcMain.handle(
    IPC.projectReveal,
    async (event, id: unknown): Promise<void> => {
      if (!fromApp(event) || api === null) return;
      if (typeof id !== 'string' || !PROJECT_ID.test(id)) return;
      const folder = await api.projectFolder(id);
      // openPath runs a file with its default handler: open only a real folder, never a program
      // (a macOS `.app` is a folder too).
      // Check the real path: a symbolic link or a trailing `/.` must not hide an app bundle.
      const real = folder === null ? null : realFolder(folder);
      if (real === null || /\.app$/i.test(real)) return;
      await shell.openPath(real);
    },
  );
  // DT-15: the page asks for a gate's next bundle; the person checks it and confirms in the
  // main process's own dialog. The page passes only ids and learns only the outcome.
  ipcMain.handle(
    IPC.bundleSign,
    async (
      event,
      id: unknown,
      gate: unknown,
      locale: unknown,
    ): Promise<BundleSignResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
      if (typeof id !== 'string' || !PROJECT_ID.test(id))
        return { status: 'failed' };
      if (typeof gate !== 'string' || !GATE_NAME.test(gate))
        return { status: 'failed' };
      const text = MESSAGES[pageLocale(locale, app.getLocale())];
      try {
        return await signBundle(mainWindow, api, id, gate, text);
      } catch (error) {
        // Never a message to the page: it could name paths (SEC-46).
        console.error('[desktop] signing failed', error);
        return { status: 'failed' };
      }
    },
  );
  registerSignDialogIpc();
  // Trust mode 2 (docs/CRYPTO.md §7): the page learns public data and outcomes only; the
  // challenge, the credential and the assertion stay between the passkey window and this process.
  ipcMain.handle(
    IPC.passkeyStatus,
    async (event, id: unknown): Promise<PasskeyStatus> => {
      const none = { passkey: null, gates: [] };
      if (!fromApp(event) || api === null) return none;
      // No project (the settings): the device's passkey alone.
      if (id !== null && (typeof id !== 'string' || !PROJECT_ID.test(id)))
        return none;
      const config = readConfig(app.getPath('userData'));
      const info =
        config.passkey === null ? null : await passkeyInfo(api, config.passkey);
      if (info === null) return none;
      return {
        passkey: info,
        gates: id === null ? [] : passkeyGatesOf(config.passkeyGates, id),
      };
    },
  );
  ipcMain.handle(
    IPC.passkeyEnroll,
    async (event, locale: unknown): Promise<PasskeyEnrollResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
      return enrollPasskey(
        {
          parent: mainWindow,
          appDir,
          userData: app.getPath('userData'),
          running: api,
        },
        MESSAGES[pageLocale(locale, app.getLocale())],
      );
    },
  );
  ipcMain.handle(
    IPC.passkeyUse,
    async (
      event,
      id: unknown,
      gate: unknown,
      on: unknown,
      locale: unknown,
    ): Promise<boolean> => {
      if (!fromApp(event)) return false;
      if (typeof id !== 'string' || !PROJECT_ID.test(id)) return false;
      if (typeof gate !== 'string' || !GATE_NAME.test(gate)) return false;
      if (typeof on !== 'boolean') return false;
      const userData = app.getPath('userData');
      const config = readConfig(userData);
      const key = gateKey(id, gate);
      // Only with a passkey to use; turning it off is always possible.
      const after = passkeyGatesAfter(
        config.passkeyGates,
        key,
        on,
        config.passkey !== null,
      );
      if (after === null) return false;
      const text = MESSAGES[pageLocale(locale, app.getLocale())].confirmChange;
      return confirmed(
        () =>
          askYesNo(
            text.passkeyUse.title,
            on ? text.passkeyUse.on : text.passkeyUse.off,
            text.passkeyUse.detail(gate),
            text.passkeyUse.confirm,
            text.cancel,
          ),
        () => updateConfig(userData, { passkeyGates: after }),
      );
    },
  );
  registerPasskeyDialogIpc();
  // The value of a secret is typed only in the main process's seal window, never in the page.
  ipcMain.handle(
    IPC.secretSeal,
    async (
      event,
      id: unknown,
      gate: unknown,
      name: unknown,
      locale: unknown,
    ): Promise<SecretSealResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
      if (typeof id !== 'string' || !PROJECT_ID.test(id))
        return { status: 'failed' };
      if (typeof gate !== 'string' || !GATE_NAME.test(gate))
        return { status: 'failed' };
      if (typeof name !== 'string' || !GATE_NAME.test(name))
        return { status: 'failed' };
      const text = MESSAGES[pageLocale(locale, app.getLocale())];
      const running = api;
      const session = new SealingSession({
        texts: text.sealDialog,
        prepare: () => running.prepareSeal(id, gate, name),
        seal: (digest, value) =>
          running.sealSecret(id, gate, name, digest, value),
      });
      try {
        const opened = await session.open();
        if ('done' in opened) return opened.done;
        return await showSealDialog({
          parent: mainWindow,
          appDir,
          title: text.sealDialog.title,
          session,
        });
      } catch {
        console.error('[desktop] sealing failed');
        return { status: 'failed' };
      }
    },
  );
  registerSealDialogIpc();
  registerSftpDialogIpc();
  registerFtpsDialogIpc();

  // «Externe Datenbank» (DT-03): the connection string is typed only in the database window.
  ipcMain.handle(
    IPC.databaseOpen,
    async (event, id: unknown, locale: unknown): Promise<DatabaseResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
      if (typeof id !== 'string' || !PROJECT_ID.test(id))
        return { status: 'failed' };
      try {
        return await openDatabase(
          mainWindow,
          api,
          id,
          pageLocale(locale, app.getLocale()),
        );
      } catch {
        console.error('[desktop] database window failed');
        return { status: 'failed' };
      }
    },
  );
  registerDatabaseDialogIpc();
  // DT-05: the page asks for a gate's deploy package; where it goes is chosen in the main
  // process's own dialog, and the page learns only the outcome, never the path.
  ipcMain.handle(
    IPC.gateDeploy,
    async (
      event,
      id: unknown,
      gate: unknown,
      target: unknown,
      locale: unknown,
    ): Promise<DeployResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
      if (typeof id !== 'string' || !PROJECT_ID.test(id))
        return { status: 'failed' };
      if (typeof gate !== 'string' || !GATE_NAME.test(gate))
        return { status: 'failed' };
      if (!DEPLOY_TARGETS.includes(target as DeployTarget))
        return { status: 'failed' };
      const text = MESSAGES[pageLocale(locale, app.getLocale())];
      try {
        return await deployGate(
          mainWindow,
          api,
          id,
          gate,
          target as DeployTarget,
          text,
        );
      } catch (error) {
        // Never a message to the page: it could name paths (SEC-46).
        console.error('[desktop] deploy package failed', error);
        return { status: 'failed' };
      }
    },
  );
  // FR-45: the page asks to import a bundle into a gate; what is chosen in the main process's own
  // dialog, read here with limits, checked in core as the gate would (DT-17).
  ipcMain.handle(
    IPC.gateImport,
    async (
      event,
      id: unknown,
      gate: unknown,
      from: unknown,
      locale: unknown,
    ): Promise<ImportResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
      if (typeof id !== 'string' || !PROJECT_ID.test(id))
        return { status: 'failed' };
      if (typeof gate !== 'string' || !GATE_NAME.test(gate))
        return { status: 'failed' };
      if (!IMPORT_FROM.includes(from as ImportFrom))
        return { status: 'failed' };
      const text = MESSAGES[pageLocale(locale, app.getLocale())];
      try {
        return await importGate(
          mainWindow,
          api,
          id,
          gate,
          from as ImportFrom,
          text,
        );
      } catch (error) {
        // Never a message to the page: it could name paths (SEC-46).
        console.error('[desktop] import failed', error);
        return { status: 'failed' };
      }
    },
  );
  // FR-50, DT-12: the page asks to show a gate's request log; the files are chosen in the main
  // process's own dialog and read here with limits, parsed in core. The page never names a path.
  ipcMain.handle(
    IPC.gateLog,
    async (
      event,
      id: unknown,
      gate: unknown,
      locale: unknown,
    ): Promise<RequestLogResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
      if (typeof id !== 'string' || !PROJECT_ID.test(id))
        return { status: 'failed' };
      if (typeof gate !== 'string' || !GATE_NAME.test(gate))
        return { status: 'failed' };
      const text = MESSAGES[pageLocale(locale, app.getLocale())].requestLog;
      try {
        const picked = await dialog.showOpenDialog(mainWindow, {
          title: text.title,
          buttonLabel: text.button,
          defaultPath: app.getPath('downloads'),
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: text.filter, extensions: ['php', 'txt', 'log', 'jsonl'] },
          ],
        });
        if (picked.canceled || picked.filePaths.length === 0)
          return { status: 'cancelled' };
        if (picked.filePaths.length > MAX_LOG_FILES)
          return { status: 'refused', code: 'unreadable' };
        const read = readLogFiles(picked.filePaths);
        if ('refused' in read) return { status: 'refused', code: read.refused };
        return logOutcome(api.readRequestLog(read.texts));
      } catch (error) {
        // Never a message to the page: it could name paths (SEC-46).
        console.error('[desktop] reading the log failed', error);
        return { status: 'failed' };
      }
    },
  );
}

/**
 * Imports a bundle file, a deploy package ZIP or folder into the gate (FR-45): only a bundle
 * signed with the desktop's own key, for this gate, above its latest bundle (DT-17, T-50).
 */
async function importGate(
  parent: BrowserWindow,
  running: RunningApi,
  id: string,
  gate: string,
  from: ImportFrom,
  text: DesktopMessages,
): Promise<ImportResult> {
  const signer = gateSigner(app.getPath('userData'), id, gate);
  if (signer === null) return { status: 'refused', code: 'key_missing' };
  const dialogText = text.importBundle;
  if (from === 'file') {
    const picked = await dialog.showOpenDialog(parent, {
      title: dialogText.chooseFile.title,
      buttonLabel: dialogText.chooseFile.button,
      defaultPath: app.getPath('documents'),
      properties: ['openFile'],
      filters: [
        { name: dialogText.chooseFile.filter, extensions: ['json', 'zip'] },
      ],
    });
    const file = picked.filePaths[0];
    if (picked.canceled || file === undefined) return { status: 'cancelled' };
    const bytes = readImportFile(file, MAX_IMPORT_FILE_BYTES);
    if (bytes === null) return { status: 'refused', code: 'unreadable' };
    if (bytes === 'too_large') return { status: 'refused', code: 'too_large' };
    return importOutcome(
      await running.importBundle(id, gate, signer, { kind: 'file', bytes }),
    );
  }
  const picked = await dialog.showOpenDialog(parent, {
    title: dialogText.chooseFolder.title,
    buttonLabel: dialogText.chooseFolder.button,
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory'],
  });
  const dir = picked.filePaths[0];
  if (picked.canceled || dir === undefined) return { status: 'cancelled' };
  const entries = listPackageFolder(dir);
  if (entries === null) return { status: 'refused', code: 'unreadable' };
  return importOutcome(
    await running.importBundle(id, gate, signer, {
      kind: 'folder',
      entries,
      read: (name) => readPackageFile(dir, name),
    }),
  );
}

/**
 * The deploy package (DT-05) of the gate's latest bundle, signed with the desktop's own key (only
 * such a bundle shapes the policy in it, T-66), saved where the person chooses.
 */
async function deployGate(
  parent: BrowserWindow,
  running: RunningApi,
  id: string,
  gate: string,
  target: DeployTarget,
  text: DesktopMessages,
): Promise<DeployResult> {
  const userData = app.getPath('userData');
  const signer = gateSigner(userData, id, gate);
  if (signer === null) return { status: 'refused', code: 'key_missing' };
  const prepared = await running.prepareDeploy(id, gate, signer);
  if (prepared.status === 'not_found') return { status: 'failed' };
  if (prepared.status === 'refused')
    return { status: 'refused', code: prepared.code };
  const pkg = prepared.package;
  const key = `${id}/${gate}`;
  const refused = deployRefusal(pkg, readConfig(userData).deployed[key]);
  if (refused !== null) return refused;
  const files = deployFiles(pkg, text.deploy);
  const remember = () => {
    updateConfig(userData, {
      deployed: {
        ...readConfig(userData).deployed,
        [key]: { gateId: pkg.gateId, version: pkg.version },
      },
    });
    // «Verlauf» (DT-03): the deploy with its target kind, never the target itself.
    void running
      .recordDeploy(id, {
        gate: pkg.gate,
        version: pkg.version,
        target,
        sha256: pkg.bundleSha256,
      })
      .catch(() => undefined);
  };
  if (target === 'sftp') {
    const result = await showSftpDialog({
      parent,
      appDir,
      title: text.sftpDialog.title,
      session: new SftpSession({
        texts: text.sftpDialog,
        pkg,
        files,
        keychain: {
          available: keychain.isEncryptionAvailable(),
          seal: (secret) => keychain.encryptString(secret).toString('base64'),
          open: (sealed) => {
            try {
              return keychain.decryptString(Buffer.from(sealed, 'base64'));
            } catch {
              return null;
            }
          },
        },
        stored: () => readConfig(userData).sftpTargets[key] ?? null,
        save: (stored) =>
          updateConfig(userData, {
            sftpTargets: {
              ...readConfig(userData).sftpTargets,
              [key]: stored,
            },
          }),
        forget: () => {
          const { [key]: _dropped, ...rest } = readConfig(userData).sftpTargets;
          updateConfig(userData, { sftpTargets: rest });
        },
        chooseKeyFile: async () => {
          const owner = BrowserWindow.getFocusedWindow() ?? parent;
          const picked = await dialog.showOpenDialog(owner, {
            title: text.sftpKey.title,
            buttonLabel: text.sftpKey.button,
            defaultPath: join(app.getPath('home'), '.ssh'),
            properties: ['openFile', 'showHiddenFiles'],
          });
          const file = picked.filePaths[0];
          return picked.canceled || file === undefined ? null : file;
        },
        readPrivateKey,
        upload: uploadPackage,
      }),
    });
    if (result.status === 'exported') remember();
    return result;
  }
  if (target === 'ftps') {
    const result = await showFtpsDialog({
      parent,
      appDir,
      title: text.ftpsDialog.title,
      session: new FtpsSession({
        texts: text.ftpsDialog,
        pkg,
        files,
        keychain: deployKeychain(),
        stored: () => readConfig(userData).ftpsTargets[key] ?? null,
        save: (stored) =>
          updateConfig(userData, {
            ftpsTargets: { ...readConfig(userData).ftpsTargets, [key]: stored },
          }),
        forget: () => {
          const { [key]: _dropped, ...rest } = readConfig(userData).ftpsTargets;
          updateConfig(userData, { ftpsTargets: rest });
        },
        upload: (connection, pinned, remoteDir, packageFiles) =>
          uploadFtpsPackage(connection, pinned, remoteDir, packageFiles),
      }),
    });
    if (result.status === 'exported') remember();
    return result;
  }
  if (target === 'git') {
    const git = text.deploy.git;
    const fill = (template: string, values: Record<string, string>) =>
      template.replace(
        /\{(\w+)\}/g,
        (all, name: string) => values[name] ?? all,
      );
    const result = await runGitDeploy({
      // An empty folder of Moat's own: no hook of the repository ever runs (T-68).
      git: gitRunner(emptyHooksDir(userData)),
      pkg,
      files,
      stored: () => readConfig(userData).gitTargets[key] ?? null,
      save: (dir) =>
        updateConfig(userData, {
          gitTargets: { ...readConfig(userData).gitTargets, [key]: dir },
        }),
      forget: () => {
        const { [key]: _dropped, ...rest } = readConfig(userData).gitTargets;
        updateConfig(userData, { gitTargets: rest });
      },
      isFolder,
      chooseFolder: async () => {
        const picked = await dialog.showOpenDialog(parent, {
          title: git.chooseFolder.title,
          buttonLabel: git.chooseFolder.button,
          defaultPath: app.getPath('documents'),
          properties: ['openDirectory'],
        });
        const dir = picked.filePaths[0];
        return picked.canceled || dir === undefined ? null : dir;
      },
      confirm: async (dir, found) => {
        const answer = await dialog.showMessageBox(parent, {
          type: 'question',
          title: git.confirm.title,
          message: fill(git.confirm.message, {
            package: packageName(pkg),
            folder: dir,
          }),
          detail: fill(git.confirm.detail, {
            branch: found.branch,
            remote: found.remote,
            remoteBranch: found.merge.slice('refs/heads/'.length),
            url: found.url,
          }),
          buttons: [git.confirm.push, git.confirm.other, git.confirm.cancel],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        return answer.response === 0
          ? 'push'
          : answer.response === 1
            ? 'other'
            : 'cancel';
      },
    });
    if (result.status === 'exported' || result.status === 'committed')
      remember();
    return result;
  }
  let written;
  if (target === 'zip') {
    const picked = await dialog.showSaveDialog(parent, {
      title: text.deploy.saveZip.title,
      buttonLabel: text.deploy.saveZip.button,
      defaultPath: join(app.getPath('documents'), `${packageName(pkg)}.zip`),
      filters: [{ name: text.deploy.saveZip.filter, extensions: ['zip'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (picked.canceled || picked.filePath === undefined)
      return { status: 'cancelled' };
    written = writeDeployZip(picked.filePath, running.zipFiles(files));
  } else {
    const picked = await dialog.showOpenDialog(parent, {
      title: text.deploy.chooseFolder.title,
      buttonLabel: text.deploy.chooseFolder.button,
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    const dir = picked.filePaths[0];
    if (picked.canceled || dir === undefined) return { status: 'cancelled' };
    if (!isFolder(dir)) return { status: 'not_writable' };
    written = writeDeployFolder(dir, files);
  }
  if (written !== null) return written;
  remember();
  return { status: 'exported', target, version: pkg.version };
}

/** The database window of a project (DT-03, DT-13). */
async function openDatabase(
  parent: BrowserWindow,
  running: RunningApi,
  id: string,
  locale: 'de-CH' | 'en',
): Promise<DatabaseResult> {
  const folder = await running.projectFolder(id);
  if (folder === null) return { status: 'failed' };
  const userData = app.getPath('userData');
  const texts = DATABASE_MESSAGES[locale];
  const name = basename(folder);
  const session = new DatabaseSession({
    texts,
    project: name,
    defaultKey: defaultDatabaseKey(name),
    keychain: {
      available: keychain.isEncryptionAvailable(),
      seal: (secret) => keychain.encryptString(secret).toString('base64'),
      open: (sealed) => {
        try {
          return keychain.decryptString(Buffer.from(sealed, 'base64'));
        } catch {
          return null;
        }
      },
    },
    stored: () => readConfig(userData).databaseTargets[id] ?? null,
    save: (target) =>
      updateConfig(userData, {
        databaseTargets: {
          ...readConfig(userData).databaseTargets,
          [id]: target,
        },
      }),
    forget: () => {
      const { [id]: _dropped, ...rest } = readConfig(userData).databaseTargets;
      updateConfig(userData, { databaseTargets: rest });
    },
    label: (url) => running.databaseLabel(url),
    signer: () => {
      const keyPath = readConfig(userData).projectKeys[id]?.keyFile ?? null;
      return (keyPath === null ? null : readKeyFile(keyPath)?.signer) ?? null;
    },
    sync: (url, key, direction, signer) =>
      running.syncDatabase(id, url, key, direction, signer),
  });
  return showDatabaseDialog({ parent, appDir, title: texts.title, session });
}

/** `<userData>/no-git-hooks`, created empty: git's hooks path for every Git deploy (T-68). */
function emptyHooksDir(userData: string): string {
  const dir = join(userData, 'no-git-hooks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Electron safeStorage, but only with a real keychain behind it: on Linux without a secret
 * service it falls back to a fixed key (`basic_text`), which is no protection — then the
 * passphrase is not remembered at all (DT-04, §1.5: never a stronger claim).
 */
const keychain = {
  isEncryptionAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' ||
      !['basic_text', 'unknown'].includes(
        safeStorage.getSelectedStorageBackend(),
      )),
  encryptString: (text: string) => safeStorage.encryptString(text),
  decryptString: (sealed: Buffer) => safeStorage.decryptString(sealed),
};

/** A deploy target's password in the keychain (DT-04), base64 ciphertext; null when it no longer opens. */
function deployKeychain() {
  return {
    available: keychain.isEncryptionAvailable(),
    seal: (secret: string) => keychain.encryptString(secret).toString('base64'),
    open: (sealed: string) => {
      try {
        return keychain.decryptString(Buffer.from(sealed, 'base64'));
      } catch {
        return null;
      }
    },
  };
}

async function signBundle(
  parent: BrowserWindow,
  running: RunningApi,
  id: string,
  gate: string,
  text: DesktopMessages,
): Promise<BundleSignResult> {
  const userData = app.getPath('userData');
  // Trust mode 2: a gate the person set to sign with the passkey never asks for the key file.
  if (readConfig(userData).passkeyGates.includes(gateKey(id, gate)))
    return signWithPasskey(
      { parent, appDir, userData, running },
      id,
      gate,
      text,
    );
  const session = new SigningSession({
    texts: text.signDialog,
    prepare: (signer) => running.prepareBundle(id, gate, signer),
    sign: (digest, keyFile, passphrase) =>
      running.signBundle(id, gate, digest, keyFile, passphrase),
    keyFilePath: () => readConfig(userData).projectKeys[id]?.keyFile ?? null,
    chooseKeyFile: async () => {
      const owner = BrowserWindow.getFocusedWindow() ?? parent;
      const picked = await dialog.showOpenDialog(owner, {
        title: text.chooseKey.title,
        buttonLabel: text.chooseKey.button,
        properties: ['openFile'],
        filters: [{ name: text.chooseKey.filter, extensions: ['moatkey'] }],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || file === undefined) return null;
      const key = await keyInfo(running, file);
      if (key === null) return null;
      await useProjectKey(running, userData, id, file, key);
      return file;
    },
    vault: new PassphraseVault(
      keychain,
      () => readConfig(userData).passphrases,
      (passphrases) => updateConfig(userData, { passphrases }),
    ),
  });
  const opened = await session.open();
  if ('done' in opened) return opened.done;
  return showSignDialog({
    parent,
    appDir,
    title: text.signDialog.title,
    session,
  });
}

/** The signer a gate's bundles are made and checked against: its passkey, or the key file. */
function gateSigner(
  userData: string,
  id: string,
  gate: string,
): PlanSigner | null {
  const config = readConfig(userData);
  if (config.passkeyGates.includes(gateKey(id, gate)))
    return config.passkey === null ? null : passkeyPlanSigner(config.passkey);
  return keySigner(config.projectKeys[id]?.keyFile ?? null);
}

function keySigner(keyPath: string | null) {
  return keyPath === null ? null : (readKeyFile(keyPath)?.signer ?? null);
}

/**
 * The public half of a key file, as the API computes it from `pk`; null when the file cannot be
 * read or names another key id than its `pk` gives. Read for display: whether the file really
 * holds that key shows only when it is opened to sign.
 */
async function keyInfo(
  running: RunningApi,
  path: string,
): Promise<SigningKeyInfo | null> {
  const file = readKeyFile(path);
  if (file === null || file.signer === null) return null;
  const info = await running.signingKeyInfo(
    Buffer.from(file.signer.publicKey).toString('base64url'),
  );
  return info !== null && info.kid === file.kid ? info : null;
}

/**
 * Makes `path` the project's signing key. Replacing a key that still opens starts a rotation
 * (SEC-08): its public key is kept until the person says every gate pins the new one.
 */
async function useProjectKey(
  running: RunningApi,
  userData: string,
  id: string,
  path: string,
  key: SigningKeyInfo,
): Promise<void> {
  const before = readConfig(userData).projectKeys[id];
  const current =
    before === undefined
      ? null
      : ((await keyInfo(running, before.keyFile))?.publicKey ?? null);
  const config = readConfig(userData);
  updateConfig(userData, {
    projectKeys: withProjectKey(config, id, {
      keyFile: path,
      previousKey: previousKeyAfter(
        current,
        config.projectKeys[id]?.previousKey ?? null,
        key.publicKey,
      ),
    }),
  });
}

/** The resolved path when it is a directory, otherwise null. */
function realFolder(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function buildMenu(): Menu {
  const text = messages().menu;
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: text.file,
      submenu: [{ role: 'quit', label: text.quit }],
    },
    { label: text.edit, role: 'editMenu' },
    {
      label: text.view,
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Developer tools only in a dev run, never in the packaged app.
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
  ]);
}
