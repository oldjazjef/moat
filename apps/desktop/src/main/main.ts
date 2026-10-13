import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  GATE_NAME,
  IPC,
  PROJECT_ID,
  type ProjectAddResult,
  type ProjectCreateResult,
  type SecretSealResult,
  type SigningKeyInfo,
  type SigningKeyResult,
  type SigningKeyStatus,
} from '../shared/bridge';
import { type RunningApi, startApi } from './api-host';
import { readConfig, updateConfig } from './lib/config';
import {
  type DesktopMessages,
  MESSAGES,
  pageLocale,
  systemLocale,
} from './lib/messages';
import { KeyCreationSession, writeKeyFile } from './lib/key-creation';
import { PassphraseVault, readKeyFile, SigningSession } from './lib/signing';
import { SealingSession } from './lib/sealing';
import { registerKeyDialogIpc, showKeyDialog } from './key-window';
import { registerSealDialogIpc, showSealDialog } from './seal-window';
import { registerSignDialogIpc, showSignDialog } from './sign-window';
import { APP_ORIGIN, isAppUrl } from './lib/web-protocol';
import { handleAppScheme, registerAppScheme } from './protocol';

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
    api = await startApi({ appDir, dataDir: userData });
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

  // The first builds remembered one folder: move it into the project list once.
  const legacy = readConfig(userData).projectDir;
  if (legacy !== null) {
    if (isFolder(legacy)) await api.addProject(legacy).catch(() => undefined);
    updateConfig(userData, { projectDir: null });
  }
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
  // The signing key (FR-73): the page learns only its public half, never the path.
  ipcMain.handle(IPC.keyStatus, async (event): Promise<SigningKeyStatus> => {
    if (!fromApp(event) || api === null) return { status: 'unreadable' };
    const path = readConfig(app.getPath('userData')).keyFile;
    if (path === null) return { status: 'none' };
    const key = await keyInfo(api, path);
    return key === null ? { status: 'unreadable' } : { status: 'ready', key };
  });
  ipcMain.handle(IPC.keyChoose, async (event): Promise<SigningKeyResult> => {
    if (!fromApp(event) || mainWindow === null || api === null)
      return { status: 'failed' };
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
    updateConfig(app.getPath('userData'), { keyFile: file });
    return { status: 'chosen', key };
  });
  ipcMain.handle(
    IPC.keyCreate,
    async (event, locale: unknown): Promise<SigningKeyResult> => {
      if (!fromApp(event) || mainWindow === null || api === null)
        return { status: 'failed' };
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
            properties: ['createDirectory', 'showOverwriteConfirmation'],
          });
          return picked.canceled || picked.filePath === undefined
            ? null
            : picked.filePath;
        },
        create: (passphrase) => running.createSigningKey(passphrase),
        write: writeKeyFile,
        use: (path) => updateConfig(userData, { keyFile: path }),
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

async function signBundle(
  parent: BrowserWindow,
  running: RunningApi,
  id: string,
  gate: string,
  text: DesktopMessages,
): Promise<BundleSignResult> {
  const userData = app.getPath('userData');
  const session = new SigningSession({
    texts: text.signDialog,
    prepare: (signer) => running.prepareBundle(id, gate, signer),
    sign: (digest, keyFile, passphrase) =>
      running.signBundle(id, gate, digest, keyFile, passphrase),
    keyFilePath: () => readConfig(userData).keyFile,
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
      updateConfig(userData, { keyFile: file });
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
