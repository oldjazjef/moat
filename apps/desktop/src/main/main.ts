import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  session,
  shell,
} from 'electron';
import { IPC, PROJECT_ID, type ProjectAddResult } from '../shared/bridge';
import { type RunningApi, startApi } from './api-host';
import { readConfig, writeConfig } from './lib/config';
import { MESSAGES, systemLocale } from './lib/messages';
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
    writeConfig(userData, { projectDir: null });
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
