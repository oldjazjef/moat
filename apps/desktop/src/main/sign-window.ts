import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { BundleSignResult } from '../shared/bridge';
import {
  SIGN_IPC,
  type SignDialogConfirm,
  type SignDialogView,
} from '../shared/sign-dialog';
import { DialogSlot } from './dialog-window';
import type { SigningSession } from './lib/signing';

/** The signing dialog (DT-15), see DialogSlot. */
const slot = new DialogSlot<SigningSession, BundleSignResult>();
const fromDialog = (event: IpcMainInvokeEvent) => slot.from(event);

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
        const step = await dialog.working(dialog.session.confirm(input));
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
  return slot.show({
    ...options,
    preload: 'sign-preload.js',
    page: 'dialogs/sign-dialog.html',
    height: 640,
    cancelled: { status: 'cancelled' },
    busy: { status: 'failed' },
  });
}
