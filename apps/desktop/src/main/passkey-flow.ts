import { randomBytes } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type {
  BundleSignResult,
  PasskeyEnrollResult,
  PasskeyInfo,
} from '../shared/bridge';
import type { RunningApi } from './api-host';
import { readConfig, updateConfig } from './lib/config';
import type { DesktopMessages } from './lib/messages';
import {
  gatePinCommand,
  passkeyPlanSigner,
  type PasskeyRecord,
} from './lib/passkey';
import { PasskeyEnrollmentSession } from './lib/passkey-enrollment';
import { PasskeySigningSession } from './lib/passkey-signing';
import {
  showPasskeyEnrollDialog,
  showPasskeySignDialog,
} from './passkey-window';

/** What the passkey flows need of the running app (kept out of main.ts so a script can drive them). */
export interface PasskeyFlowEnv {
  readonly parent: BrowserWindow;
  readonly appDir: string;
  readonly userData: string;
  readonly running: RunningApi;
}

/** The passkey's public data for the page; null when the stored record is not consistent. */
export async function passkeyInfo(
  running: RunningApi,
  record: PasskeyRecord,
): Promise<PasskeyInfo | null> {
  const info = await running.passkeyKeyInfo(record.publicKey);
  if (info === null || info.kid !== record.kid) return null;
  return {
    kid: info.kid,
    publicKey: info.publicKey,
    fingerprint: info.fingerprint,
    rpId: record.rpId,
    origin: record.origin,
    trustCommand: gatePinCommand(record, 'trust'),
    installCommand: gatePinCommand(record, 'install'),
  };
}

/** «Passkey anlegen»: the main process's passkey window; the page learns public data only. */
export async function enrollPasskey(
  env: PasskeyFlowEnv,
  text: DesktopMessages,
): Promise<PasskeyEnrollResult> {
  const { running, userData } = env;
  const session = new PasskeyEnrollmentSession({
    texts: text.passkeyDialog,
    random: (length) => randomBytes(length),
    existing: () => readConfig(userData).passkey,
    keyInfo: (point) => running.passkeyKeyInfo(point),
    store: (record) => updateConfig(userData, { passkey: record }),
  });
  try {
    await showPasskeyEnrollDialog({
      parent: env.parent,
      appDir: env.appDir,
      title: text.passkeyDialog.title,
      session,
    });
  } catch {
    console.error('[desktop] creating the passkey failed');
    return { status: 'failed' };
  }
  // The window may be closed with the corner button after the passkey was stored.
  const stored = session.stored;
  if (stored !== null) return { status: 'created', passkey: stored };
  return { status: session.unavailable ? 'unavailable' : 'cancelled' };
}

/** DT-15 with a passkey (trust mode 2): the same preview, confirmed at the passkey. */
export async function signWithPasskey(
  env: PasskeyFlowEnv,
  id: string,
  gate: string,
  text: DesktopMessages,
): Promise<BundleSignResult> {
  const { running } = env;
  const record = readConfig(env.userData).passkey;
  if (record === null) return { status: 'failed' };
  const info = await running.passkeyKeyInfo(record.publicKey);
  if (info === null || info.kid !== record.kid) return { status: 'failed' };
  const signer = passkeyPlanSigner(record);
  const session = new PasskeySigningSession({
    texts: text.passkeySignDialog,
    passkey: record,
    fingerprint: info.fingerprint,
    prepare: () => running.prepareBundle(id, gate, signer),
    sign: (digest, assert) =>
      running.signBundleWithPasskey(id, gate, digest, signer, assert),
  });
  const opened = await session.open();
  if ('done' in opened) return opened.done;
  return showPasskeySignDialog({
    parent: env.parent,
    appDir: env.appDir,
    title: text.passkeySignDialog.title,
    session,
  });
}
