import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { DatabaseResult } from '../shared/bridge';
import {
  DATABASE_IPC,
  type DatabaseDialogInput,
  type DatabaseDialogView,
} from '../shared/database-dialog';
import { DialogSlot } from './dialog-window';
import { MAX_URL_LENGTH, type DatabaseSession } from './lib/database';

/** The database window (DT-03): the connection string is typed here, never in the app's page. */
const slot = new DialogSlot<DatabaseSession, DatabaseResult>();

export function registerDatabaseDialogIpc(): void {
  ipcMain.handle(DATABASE_IPC.view, (event): DatabaseDialogView | null => {
    return slot.from(event)?.session.view() ?? null;
  });
  ipcMain.handle(DATABASE_IPC.forget, (event): DatabaseDialogView | null => {
    return slot.from(event)?.session.forget() ?? null;
  });
  ipcMain.handle(
    DATABASE_IPC.run,
    async (
      event: IpcMainInvokeEvent,
      input: unknown,
    ): Promise<DatabaseDialogView | null> => {
      const dialog = slot.from(event);
      const parsed = inputOf(input);
      if (dialog === null || parsed === null) return null;
      try {
        return await dialog.working(dialog.session.run(parsed));
      } catch {
        // Never the error's text: it could carry the server's answer (SEC-34, SEC-46).
        console.error('[desktop] database sync failed');
        dialog.finish({ status: 'failed' });
        return null;
      }
    },
  );
  ipcMain.handle(DATABASE_IPC.close, (event): void => {
    const dialog = slot.from(event);
    dialog?.finish(dialog.session.outcome());
  });
}

function inputOf(input: unknown): DatabaseDialogInput | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const { url, key, remember, direction } = record;
  if (
    typeof url !== 'string' ||
    url.length > MAX_URL_LENGTH ||
    typeof key !== 'string' ||
    key.length > 128 ||
    typeof remember !== 'boolean' ||
    (direction !== 'push' && direction !== 'pull')
  )
    return null;
  return { url, key, remember, direction };
}

export function showDatabaseDialog(options: {
  parent: BrowserWindow;
  appDir: string;
  title: string;
  session: DatabaseSession;
}): Promise<DatabaseResult> {
  return slot.show({
    ...options,
    preload: 'database-preload.js',
    page: 'dialogs/database-dialog.html',
    height: 720,
    // Closed with the window's own button: whatever ran counts.
    cancelled: options.session.outcome(),
    busy: { status: 'failed' },
  });
}
