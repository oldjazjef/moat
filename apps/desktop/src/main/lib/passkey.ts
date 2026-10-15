import type { PlanSigner } from './signing';

/**
 * Trust mode 2 on the desktop (docs/CRYPTO.md §7). WebAuthn needs a web origin: Chromium refuses
 * it on a custom scheme such as `app://moat`, so the passkey windows load their page from the
 * HTTPS origin below, which the main process answers itself in a session of its own (no network,
 * see `passkeyRoute`). That origin is not the app's own: the app's page (`app://moat`) can
 * neither create nor use a passkey for it, and a signature made there is bound to this origin
 * and rpId by the gate (T-77).
 *
 * `.invalid` is reserved (RFC 6761): the name never resolves and belongs to nobody.
 */
export const PASSKEY_RP_ID = 'passkey.moat.invalid';
export const PASSKEY_ORIGIN = `https://${PASSKEY_RP_ID}`;
/** The in-memory session of the passkey windows. */
export const PASSKEY_PARTITION = 'moat-passkey';

const B64URL = /^[A-Za-z0-9_-]+$/;

/** A passkey as the desktop remembers it (config.json): public data only, no secret. */
export interface PasskeyRecord {
  /** The authenticator's credential id, base64url (not secret; it names which passkey to use). */
  readonly credentialId: string;
  /** base64url of the 65-byte uncompressed P-256 point, what the gate pins. */
  readonly publicKey: string;
  /** docs/CRYPTO.md §3 key id. */
  readonly kid: string;
  readonly rpId: string;
  readonly origin: string;
}

/** A stored record, or null when it is not exactly what the desktop writes. */
export function passkeyRecordOf(value: unknown): PasskeyRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const { credentialId, publicKey, kid, rpId, origin } = value as Record<
    string,
    unknown
  >;
  if (
    typeof credentialId !== 'string' ||
    credentialId.length < 22 ||
    credentialId.length > 1400 ||
    !B64URL.test(credentialId) ||
    typeof publicKey !== 'string' ||
    publicKey.length !== 87 ||
    !B64URL.test(publicKey) ||
    typeof kid !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(kid) ||
    rpId !== PASSKEY_RP_ID ||
    origin !== PASSKEY_ORIGIN
  )
    return null;
  return { credentialId, publicKey, kid, rpId, origin };
}

/** What a gate needs to pin the passkey (docs/CRYPTO.md §7.1, gates/php README). */
export function gatePinCommand(
  record: PasskeyRecord,
  command: 'trust' | 'install',
): string {
  return `php moat-gate.php ${command} --passkey=${record.publicKey} --rp-id=${record.rpId} --origin=${record.origin}`;
}

/** A planning signer that is a pinned passkey. */
export type PasskeyPlanSigner = PlanSigner & {
  passkey: { rpId: string; origins: readonly string[] };
};

/** The signer the API plans and verifies a passkey gate's bundles against. */
export function passkeyPlanSigner(record: PasskeyRecord): PasskeyPlanSigner {
  return {
    kid: record.kid,
    publicKey: new Uint8Array(Buffer.from(record.publicKey, 'base64url')),
    passkey: { rpId: record.rpId, origins: [record.origin] },
  };
}

/** `<projectId>/<gate>`: how config.json names a gate. */
export const gateKey = (projectId: string, gate: string): string =>
  `${projectId}/${gate}`;

/** The gates of a project that sign with the passkey, names only. */
export function passkeyGatesOf(
  keys: readonly string[],
  projectId: string,
): string[] {
  const prefix = `${projectId}/`;
  return keys
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort();
}

/** The pages the passkey windows may load, by file in `dialogs/`. */
const PAGES: Readonly<Record<string, { file: string; type: string }>> = {
  '/passkey-dialog.html': {
    file: 'passkey-dialog.html',
    type: 'text/html; charset=utf-8',
  },
  '/passkey-sign-dialog.html': {
    file: 'passkey-sign-dialog.html',
    type: 'text/html; charset=utf-8',
  },
  '/dialog.css': { file: 'dialog.css', type: 'text/css; charset=utf-8' },
};

export type PasskeyRoute =
  { kind: 'file'; file: string; type: string } | { kind: 'refused' };

/**
 * What a request in the passkey session is: one of the three static dialog files of the
 * passkey origin, anything else refused. The session has no network (T-77).
 */
export function passkeyRoute(requestUrl: string): PasskeyRoute {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { kind: 'refused' };
  }
  if (
    url.protocol !== 'https:' ||
    url.host !== PASSKEY_RP_ID ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== ''
  )
    return { kind: 'refused' };
  const page = Object.hasOwn(PAGES, url.pathname)
    ? PAGES[url.pathname]
    : undefined;
  return page === undefined
    ? { kind: 'refused' }
    : { kind: 'file', file: page.file, type: page.type };
}

/** Whether an IPC call comes from a page of the passkey origin (not navigated elsewhere). */
export function isPasskeyUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return new URL(url).origin === PASSKEY_ORIGIN;
  } catch {
    return false;
  }
}

/** The text of a base64url field from the window, bytes; null when it is not base64url. */
export function bytesOf(text: unknown, maxBytes: number): Uint8Array | null {
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    text.length > Math.ceil((maxBytes * 4) / 3) ||
    !B64URL.test(text)
  )
    return null;
  const bytes = new Uint8Array(Buffer.from(text, 'base64url'));
  return bytes.length > maxBytes ||
    Buffer.from(bytes).toString('base64url') !== text
    ? null
    : bytes;
}
