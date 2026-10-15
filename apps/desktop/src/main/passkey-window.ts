import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ipcMain, session } from 'electron';
import type { BundleSignResult } from '../shared/bridge';
import {
  PASSKEY_ENROLL_IPC,
  PASSKEY_SIGN_IPC,
  type PasskeyAssertionOutcome,
  type PasskeyCreateRequest,
  type PasskeyEnrollOutcome,
  type PasskeyEnrollView,
  type PasskeyFailure,
  type PasskeySignBegin,
  type PasskeySignView,
} from '../shared/passkey-dialog';
import { DialogSlot } from './dialog-window';
import { attachVirtualAuthenticator } from './virtual-authenticator';
import type { PasskeyEnrollmentSession } from './lib/passkey-enrollment';
import type { PasskeySigningSession } from './lib/passkey-signing';
import {
  isPasskeyUrl,
  PASSKEY_ORIGIN,
  PASSKEY_PARTITION,
  passkeyRoute,
} from './lib/passkey';

/** How the two passkey windows close: the session holds what happened. */
type Closed = { readonly closed: true };

const enrollSlot = new DialogSlot<PasskeyEnrollmentSession, Closed>();
const signSlot = new DialogSlot<PasskeySigningSession, BundleSignResult>();

const PAGE_HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

let prepared = false;

/**
 * The session the passkey windows live in (T-77): in memory, no permissions, and every request
 * answered by the main process itself — `https://passkey.moat.invalid/…` serves the three
 * static dialog files and nothing else, `http` and every other host get a 404. Nothing reaches
 * the network, so Chromium's WebAuthn check (a web origin) is met without a certificate and
 * without the app's own origin (`app://moat`), which cannot use WebAuthn at all.
 */
function preparePasskeySession(appDir: string): void {
  if (prepared) return;
  prepared = true;
  const ses = session.fromPartition(PASSKEY_PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  ses.setPermissionCheckHandler(() => false);
  const notFound = () => new Response('Not found', { status: 404 });
  ses.protocol.handle('http', notFound);
  ses.protocol.handle('https', async (request) => {
    const route = passkeyRoute(request.url);
    if (route.kind !== 'file') return notFound();
    try {
      return new Response(await readFile(join(appDir, 'dialogs', route.file)), {
        headers: { ...PAGE_HEADERS, 'content-type': route.type },
      });
    } catch {
      return notFound();
    }
  });
}

const fromEnroll = (event: IpcMainInvokeEvent) =>
  isPasskeyUrl(event.senderFrame?.url) ? enrollSlot.from(event) : null;
const fromSign = (event: IpcMainInvokeEvent) =>
  isPasskeyUrl(event.senderFrame?.url) ? signSlot.from(event) : null;

const REASONS: readonly PasskeyFailure[] = [
  'cancelled',
  'unavailable',
  'failed',
];

function enrollOutcomeOf(value: unknown): PasskeyEnrollOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  if (input['status'] === 'failed') {
    const reason = REASONS.find((known) => known === input['reason']);
    return reason === undefined ? null : { status: 'failed', reason };
  }
  if (
    input['status'] === 'created' &&
    typeof input['attestationObject'] === 'string' &&
    typeof input['clientDataJSON'] === 'string' &&
    input['attestationObject'].length <= 24_000 &&
    input['clientDataJSON'].length <= 4_000
  )
    return {
      status: 'created',
      attestationObject: input['attestationObject'],
      clientDataJSON: input['clientDataJSON'],
    };
  return null;
}

function assertionOutcomeOf(value: unknown): PasskeyAssertionOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  if (input['status'] === 'failed') {
    const reason = REASONS.find((known) => known === input['reason']);
    return reason === undefined ? null : { status: 'failed', reason };
  }
  const { credentialId, authenticatorData, clientDataJSON, signature } = input;
  if (
    input['status'] === 'asserted' &&
    typeof credentialId === 'string' &&
    credentialId.length <= 1_400 &&
    typeof authenticatorData === 'string' &&
    authenticatorData.length <= 2_000 &&
    typeof clientDataJSON === 'string' &&
    clientDataJSON.length <= 4_000 &&
    typeof signature === 'string' &&
    signature.length <= 200
  )
    return {
      status: 'asserted',
      credentialId,
      authenticatorData,
      clientDataJSON,
      signature,
    };
  return null;
}

export function registerPasskeyDialogIpc(): void {
  ipcMain.handle(
    PASSKEY_ENROLL_IPC.view,
    (event): PasskeyEnrollView | null =>
      fromEnroll(event)?.session.view() ?? null,
  );
  ipcMain.handle(
    PASSKEY_ENROLL_IPC.begin,
    (event): PasskeyCreateRequest | null =>
      fromEnroll(event)?.session.begin() ?? null,
  );
  ipcMain.handle(
    PASSKEY_ENROLL_IPC.finish,
    async (event, input: unknown): Promise<PasskeyEnrollView | null> => {
      const dialog = fromEnroll(event);
      const outcome = enrollOutcomeOf(input);
      if (dialog === null || outcome === null) return null;
      try {
        return await dialog.working(dialog.session.finish(outcome));
      } catch {
        // Never the error's text (SEC-34).
        console.error('[desktop] creating the passkey failed');
        dialog.finish({ closed: true });
        return null;
      }
    },
  );
  ipcMain.handle(PASSKEY_ENROLL_IPC.cancel, (event): void => {
    fromEnroll(event)?.finish({ closed: true });
  });

  ipcMain.handle(
    PASSKEY_SIGN_IPC.view,
    (event): PasskeySignView | null => fromSign(event)?.session.view() ?? null,
  );
  ipcMain.handle(
    PASSKEY_SIGN_IPC.begin,
    async (event): Promise<PasskeySignBegin | null> => {
      const dialog = fromSign(event);
      if (dialog === null) return null;
      try {
        const step = await dialog.working(dialog.session.begin());
        if (step === null) return null;
        if ('begin' in step) return step.begin;
        dialog.finish(step.done);
      } catch (error) {
        console.error('[desktop] signing with the passkey failed', error);
        dialog.finish({ status: 'failed' });
      }
      return null;
    },
  );
  ipcMain.handle(
    PASSKEY_SIGN_IPC.deliver,
    async (event, input: unknown): Promise<PasskeySignView | null> => {
      const dialog = fromSign(event);
      const outcome = assertionOutcomeOf(input);
      if (dialog === null || outcome === null) return null;
      try {
        const step = await dialog.working(dialog.session.deliver(outcome));
        if ('view' in step) return step.view;
        dialog.finish(step.done);
      } catch (error) {
        console.error('[desktop] signing with the passkey failed', error);
        dialog.finish({ status: 'failed' });
      }
      return null;
    },
  );
  ipcMain.handle(PASSKEY_SIGN_IPC.cancel, (event): void => {
    const dialog = fromSign(event);
    dialog?.session.cancel();
    dialog?.finish({ status: 'cancelled' });
  });
}

/** «Passkey anlegen»: resolves when the window closes; the session says what was stored. */
export async function showPasskeyEnrollDialog(options: {
  parent: BrowserWindow;
  appDir: string;
  title: string;
  session: PasskeyEnrollmentSession;
}): Promise<void> {
  preparePasskeySession(options.appDir);
  await enrollSlot.show({
    ...options,
    preload: 'passkey-preload.js',
    page: 'dialogs/passkey-dialog.html',
    web: {
      url: `${PASSKEY_ORIGIN}/passkey-dialog.html`,
      partition: PASSKEY_PARTITION,
    },
    onCreated: attachVirtualAuthenticator,
    height: 720,
    cancelled: { closed: true },
    busy: { closed: true },
  });
}

/** The signing dialog of a gate in trust mode 2; resolves when signed, cancelled or closed. */
export async function showPasskeySignDialog(options: {
  parent: BrowserWindow;
  appDir: string;
  title: string;
  session: PasskeySigningSession;
}): Promise<BundleSignResult> {
  preparePasskeySession(options.appDir);
  try {
    return await signSlot.show({
      ...options,
      preload: 'passkey-sign-preload.js',
      page: 'dialogs/passkey-sign-dialog.html',
      web: {
        url: `${PASSKEY_ORIGIN}/passkey-sign-dialog.html`,
        partition: PASSKEY_PARTITION,
      },
      onCreated: attachVirtualAuthenticator,
      height: 700,
      cancelled: { status: 'cancelled' },
      busy: { status: 'failed' },
    });
  } finally {
    // A window closed while the passkey was asked must not leave the signing waiting.
    options.session.cancel();
  }
}
