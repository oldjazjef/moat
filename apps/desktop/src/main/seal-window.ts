import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { SecretSealResult } from '../shared/bridge';
import { SEAL_IPC, type SealDialogView } from '../shared/seal-dialog';
import { DialogSlot } from './dialog-window';
import type { SealingSession } from './lib/sealing';

/** The seal dialog: the value is typed here, never in the app's page (see DialogSlot). */
const slot = new DialogSlot<SealingSession, SecretSealResult>();
const fromDialog = (event: IpcMainInvokeEvent) => slot.from(event);

export function registerSealDialogIpc(): void {
  ipcMain.handle(SEAL_IPC.view, (event): SealDialogView | null => {
    return fromDialog(event)?.session.view() ?? null;
  });
  ipcMain.handle(
    SEAL_IPC.confirm,
    async (event, input: unknown): Promise<SealDialogView | null> => {
      const value = valueOf(input);
      const dialog = fromDialog(event);
      if (dialog === null || value === null) {
        value?.fill(0);
        return null;
      }
      try {
        const step = await dialog.working(dialog.session.confirm(value));
        if ('view' in step) return step.view;
        dialog.finish(step.done);
      } catch {
        // Never the error's text: it must not carry anything of the value (SEC-34).
        console.error('[desktop] sealing failed');
        dialog.finish({ status: 'failed' });
      } finally {
        value.fill(0);
      }
      return null;
    },
  );
  ipcMain.handle(SEAL_IPC.cancel, (event): void => {
    fromDialog(event)?.finish({ status: 'cancelled' });
  });
}

/** The value bytes; anything else is not a value. */
function valueOf(input: unknown): Uint8Array | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)['value'];
  // Too long a value is refused by the session (value_invalid) and zeroed like any other.
  return value instanceof Uint8Array ? value : null;
}

export function showSealDialog(options: {
  parent: BrowserWindow;
  appDir: string;
  title: string;
  session: SealingSession;
}): Promise<SecretSealResult> {
  return slot.show({
    ...options,
    preload: 'seal-preload.js',
    page: 'dialogs/seal-dialog.html',
    height: 600,
    cancelled: { status: 'cancelled' },
    busy: { status: 'failed' },
  });
}
