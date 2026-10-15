import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { DeployResult } from '../shared/bridge';
import {
  FTPS_IPC,
  type FtpsDialogInput,
  type FtpsDialogView,
} from '../shared/ftps-dialog';
import { DialogSlot } from './dialog-window';
import type { FtpsSession, FtpsStep } from './lib/ftps';

/** The FTPS window (DT-05, T-69): target and password are typed here, never in the app's page. */
const slot = new DialogSlot<FtpsSession, DeployResult>();
const fromDialog = (event: IpcMainInvokeEvent) => slot.from(event);

export function registerFtpsDialogIpc(): void {
  ipcMain.handle(FTPS_IPC.view, (event): FtpsDialogView | null => {
    return fromDialog(event)?.session.view() ?? null;
  });
  ipcMain.handle(FTPS_IPC.forget, (event): FtpsDialogView | null => {
    return fromDialog(event)?.session.forget() ?? null;
  });
  const step = async (
    event: IpcMainInvokeEvent,
    work: (session: FtpsSession) => Promise<FtpsStep>,
  ): Promise<FtpsDialogView | null> => {
    const dialog = fromDialog(event);
    if (dialog === null) return null;
    try {
      const next = await dialog.working(work(dialog.session));
      if ('view' in next) return next.view;
      dialog.finish(next.done);
    } catch {
      // Never the error's text: it could carry the host's answer or a path (SEC-34, SEC-46).
      console.error('[desktop] FTPS upload failed');
      dialog.finish({ status: 'failed' });
    }
    return null;
  };
  ipcMain.handle(FTPS_IPC.connect, (event, input: unknown) => {
    const parsed = inputOf(input);
    if (parsed === null) return null;
    return step(event, (session) => session.connect(parsed));
  });
  ipcMain.handle(FTPS_IPC.trustCertificate, (event) =>
    step(event, (session) => session.trustCertificate()),
  );
  ipcMain.handle(FTPS_IPC.cancel, (event): void => {
    fromDialog(event)?.finish({ status: 'cancelled' });
  });
}

/** Strings of a sane length and a known mode; anything else is not an input. */
function inputOf(input: unknown): FtpsDialogInput | null {
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
  const mode = record['mode'];
  const remember = record['remember'];
  if (
    host === null ||
    port === null ||
    username === null ||
    remoteDir === null ||
    secret === null ||
    (mode !== 'explicit' && mode !== 'implicit') ||
    typeof remember !== 'boolean'
  )
    return null;
  return { host, port, username, remoteDir, secret, mode, remember };
}

export function showFtpsDialog(options: {
  parent: BrowserWindow;
  appDir: string;
  title: string;
  session: FtpsSession;
}): Promise<DeployResult> {
  return slot.show({
    ...options,
    preload: 'ftps-preload.js',
    page: 'dialogs/ftps-dialog.html',
    height: 760,
    cancelled: { status: 'cancelled' },
    busy: { status: 'failed' },
  });
}
