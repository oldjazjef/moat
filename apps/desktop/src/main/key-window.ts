import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { SigningKeyResult } from '../shared/bridge';
import {
  KEY_IPC,
  type KeyDialogConfirm,
  type KeyDialogView,
  MAX_PASSPHRASE,
} from '../shared/key-dialog';
import { DialogSlot } from './dialog-window';
import type { KeyCreationSession } from './lib/key-creation';

/** The key window: the passphrase is typed here, never in the app's page (see DialogSlot). */
const slot = new DialogSlot<KeyCreationSession, SigningKeyResult>();
const fromDialog = (event: IpcMainInvokeEvent) => slot.from(event);

export function registerKeyDialogIpc(): void {
  ipcMain.handle(KEY_IPC.view, (event): KeyDialogView | null => {
    return fromDialog(event)?.session.view() ?? null;
  });
  ipcMain.handle(
    KEY_IPC.confirm,
    async (event, input: unknown): Promise<KeyDialogView | null> => {
      const dialog = fromDialog(event);
      if (dialog === null || !isConfirm(input)) return null;
      try {
        const step = await dialog.working(dialog.session.confirm(input));
        if ('view' in step) return step.view;
        dialog.finish(step.done);
      } catch {
        // Never the error's text: it must not carry anything of the passphrase (SEC-34).
        console.error('[desktop] creating the key failed');
        dialog.finish({ status: 'failed' });
      }
      return null;
    },
  );
  ipcMain.handle(KEY_IPC.cancel, (event): void => {
    fromDialog(event)?.finish({ status: 'cancelled' });
  });
}

function isConfirm(value: unknown): value is KeyDialogConfirm {
  if (typeof value !== 'object' || value === null) return false;
  const { passphrase, repeat } = value as Record<string, unknown>;
  // Longer than any passphrase may be is passed on and refused as `too_long`, not dropped.
  return (
    typeof passphrase === 'string' &&
    typeof repeat === 'string' &&
    passphrase.length <= MAX_PASSPHRASE + 1 &&
    repeat.length <= MAX_PASSPHRASE + 1
  );
}

export function showKeyDialog(options: {
  parent: BrowserWindow;
  appDir: string;
  title: string;
  session: KeyCreationSession;
}): Promise<SigningKeyResult> {
  return slot.show({
    ...options,
    preload: 'key-preload.js',
    page: 'dialogs/key-dialog.html',
    height: 520,
    cancelled: { status: 'cancelled' },
    busy: { status: 'failed' },
  });
}
