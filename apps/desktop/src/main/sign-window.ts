import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import type { BundleSignResult } from '../shared/bridge';
import {
  SIGN_IPC,
  type SignDialogConfirm,
  type SignDialogView,
} from '../shared/sign-dialog';
import type { SigningSession } from './lib/signing';

/**
 * The signing dialog (DT-15): a modal window of its own, rendered by the main process from a
 * local file with its own preload. The app's page cannot reach it: its IPC answers only this
 * window's main frame, and the page only ever learns the outcome.
 */
interface OpenDialog {
  readonly window: BrowserWindow;
  readonly session: SigningSession;
  finish(result: BundleSignResult): void;
}

let current: OpenDialog | null = null;

/** Main frame of the open dialog, loaded from our own file — nothing else. */
function fromDialog(event: IpcMainInvokeEvent): OpenDialog | null {
  const dialog = current;
  if (dialog === null || dialog.window.isDestroyed()) return null;
  const contents = dialog.window.webContents;
  if (event.sender !== contents || event.senderFrame !== contents.mainFrame)
    return null;
  return dialog;
}

export function registerSignDialogIpc(): void {
  ipcMain.handle(SIGN_IPC.view, (event): SignDialogView | null => {
    return fromDialog(event)?.session.view() ?? null;
  });
  ipcMain.handle(
    SIGN_IPC.chooseKey,
    async (event): Promise<SignDialogView | null> => {
      const dialog = fromDialog(event);
      if (dialog === null) return null;
      try {
        const step = await dialog.session.chooseKey();
        if ('view' in step) return step.view;
        dialog.finish(step.done);
        return null;
      } catch (error) {
        console.error('[desktop] choosing the key file failed', error);
        return dialog.session.view();
      }
    },
  );
  ipcMain.handle(
    SIGN_IPC.confirm,
    async (event, input: unknown): Promise<SignDialogView | null> => {
      const dialog = fromDialog(event);
      if (dialog === null || !isConfirm(input)) return null;
      try {
        const step = await dialog.session.confirm(input);
        if ('view' in step) return step.view;
        dialog.finish(step.done);
      } catch (error) {
        console.error('[desktop] signing failed', error);
        dialog.finish({ status: 'failed' });
      }
      return null;
    },
  );
  ipcMain.handle(SIGN_IPC.cancel, (event): void => {
    fromDialog(event)?.finish({ status: 'cancelled' });
  });
}

function isConfirm(value: unknown): value is SignDialogConfirm {
  if (typeof value !== 'object' || value === null) return false;
  const { passphrase, remember } = value as Record<string, unknown>;
  // A passphrase is short text; anything else is not one.
  return (
    typeof passphrase === 'string' &&
    passphrase.length <= 1024 &&
    typeof remember === 'boolean'
  );
}

/** Shows the dialog for an opened session; resolves when signed, cancelled or closed. */
export function showSignDialog(options: {
  parent: BrowserWindow;
  appDir: string;
  title: string;
  session: SigningSession;
}): Promise<BundleSignResult> {
  if (current !== null && !current.window.isDestroyed()) {
    current.window.focus();
    return Promise.resolve({ status: 'failed' });
  }
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      parent: options.parent,
      modal: true,
      width: 560,
      height: 640,
      minWidth: 360,
      minHeight: 420,
      title: options.title,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(options.appDir, 'sign-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: false,
      },
    });
    window.setMenu(null);
    let done = false;
    const dialog: OpenDialog = {
      window,
      session: options.session,
      finish: (result) => {
        if (done) return;
        done = true;
        if (current === dialog) current = null;
        resolve(result);
        if (!window.isDestroyed()) window.close();
      },
    };
    current = dialog;
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => dialog.finish({ status: 'cancelled' }));
    void window.loadURL(
      pathToFileURL(join(options.appDir, 'sign', 'sign-dialog.html')).href,
    );
  });
}
