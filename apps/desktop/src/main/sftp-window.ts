import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { DeployResult } from '../shared/bridge';
import {
  SFTP_IPC,
  type SftpDialogInput,
  type SftpDialogView,
} from '../shared/sftp-dialog';
import { DialogSlot } from './dialog-window';
import type { SftpSession, SftpStep } from './lib/sftp';

/** The SFTP window (DT-05): target and password are typed here, never in the app's page. */
const slot = new DialogSlot<SftpSession, DeployResult>();
const fromDialog = (event: IpcMainInvokeEvent) => slot.from(event);

export function registerSftpDialogIpc(): void {
  ipcMain.handle(SFTP_IPC.view, (event): SftpDialogView | null => {
    return fromDialog(event)?.session.view() ?? null;
  });
  ipcMain.handle(
    SFTP_IPC.chooseKey,
    async (event): Promise<SftpDialogView | null> => {
      const dialog = fromDialog(event);
      return dialog === null ? null : dialog.session.chooseKey();
    },
  );
  ipcMain.handle(SFTP_IPC.forget, (event): SftpDialogView | null => {
    return fromDialog(event)?.session.forget() ?? null;
  });
  const step = async (
    event: IpcMainInvokeEvent,
    work: (session: SftpSession) => Promise<SftpStep>,
  ): Promise<SftpDialogView | null> => {
    const dialog = fromDialog(event);
    if (dialog === null) return null;
    try {
      const next = await dialog.working(work(dialog.session));
      if ('view' in next) return next.view;
      dialog.finish(next.done);
    } catch {
      // Never the error's text: it could carry the host's answer or a path (SEC-34, SEC-46).
      console.error('[desktop] SFTP upload failed');
      dialog.finish({ status: 'failed' });
    }
    return null;
  };
  ipcMain.handle(SFTP_IPC.connect, (event, input: unknown) => {
    const parsed = inputOf(input);
    if (parsed === null) return null;
    return step(event, (session) => session.connect(parsed));
  });
  ipcMain.handle(SFTP_IPC.trustHostKey, (event) =>
    step(event, (session) => session.trustHostKey()),
  );
  ipcMain.handle(SFTP_IPC.cancel, (event): void => {
    fromDialog(event)?.finish({ status: 'cancelled' });
  });
}

/** Strings of a sane length and a known auth kind; anything else is not an input. */
function inputOf(input: unknown): SftpDialogInput | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.length <= max ? value : null;
  };
  const host = text('host', 256);
  const port = text('port', 8);
  const username = text('username', 128);
  const remoteDir = text('remoteDir', 2200);
  const secret = text('secret', 1025);
  const auth = record['auth'];
  const remember = record['remember'];
  if (
    host === null ||
    port === null ||
    username === null ||
    remoteDir === null ||
    secret === null ||
    (auth !== 'password' && auth !== 'key') ||
    typeof remember !== 'boolean'
  )
    return null;
  return { host, port, username, remoteDir, secret, auth, remember };
}

export function showSftpDialog(options: {
  parent: BrowserWindow;
  appDir: string;
  title: string;
  session: SftpSession;
}): Promise<DeployResult> {
  return slot.show({
    ...options,
    preload: 'sftp-preload.js',
    page: 'dialogs/sftp-dialog.html',
    height: 760,
    cancelled: { status: 'cancelled' },
    busy: { status: 'failed' },
  });
}
