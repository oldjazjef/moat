import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type { DeployFile } from './deploy';

/** Where and as whom (DT-05). The secret is the password, or the passphrase of `privateKey`. */
export interface SftpConnection {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password?: string;
  readonly privateKey?: Buffer;
  readonly passphrase?: string;
}

export type UploadResult =
  /** First contact: nothing sent but the handshake; the person compares `hostKey` first. */
  | { readonly status: 'hostkey_unknown'; readonly hostKey: string }
  /** The server shows another key than the one pinned: refused before authenticating. */
  | { readonly status: 'hostkey_changed'; readonly hostKey: string }
  | { readonly status: 'auth_failed' }
  | { readonly status: 'connect_failed' }
  /** The package's folder is on the server already; nothing was written. */
  | { readonly status: 'exists' }
  /** The remote folder is missing or not writable; nothing was written. */
  | { readonly status: 'upload_failed' }
  /** The package folder was created, then a write failed or timed out: it is incomplete. */
  | { readonly status: 'partial' }
  | { readonly status: 'uploaded' };

/** Enough for a slow shared host; the handshake and every step after it. */
export const SFTP_TIMEOUT_MS = 20_000;

/**
 * `<key type> SHA256:…` as `ssh-keygen -lf` and most hosters print it. The type is the name at
 * the start of the key blob (uint32 length + name); `unknown` when it does not look like one.
 */
export function hostKeyFingerprint(key: Buffer): string {
  const digest = createHash('sha256')
    .update(key)
    .digest('base64')
    .replace(/=+$/, '');
  return `${hostKeyType(key)} SHA256:${digest}`;
}

function hostKeyType(key: Buffer): string {
  if (key.length < 4) return 'unknown';
  const length = key.readUInt32BE(0);
  if (length < 3 || length > 64 || key.length < 4 + length) return 'unknown';
  const name = key.subarray(4, 4 + length).toString('latin1');
  return /^[a-z0-9@.-]+$/.test(name) ? name : 'unknown';
}

/**
 * Connects, checks the server's host key against `pinned` (null: only learn it), and writes the
 * package as a new folder `<remoteDir>/<folder>/`: mkdir fails when it exists, and every file is
 * opened with create + exclusive, so nothing on the server is ever replaced. No shell, no command:
 * SFTP only.
 */
export function uploadPackage(
  connection: SftpConnection,
  pinned: string | null,
  remoteDir: string,
  files: readonly DeployFile[],
): Promise<UploadResult> {
  return new Promise((resolve) => {
    const client = new Client();
    let seen: string | null = null;
    let settled = false;
    // Set once the package folder exists on the server: any failure after it leaves it partial.
    const progress = { made: false };
    const finish = (result: UploadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      client.destroy();
      resolve(
        progress.made && result.status !== 'uploaded'
          ? { status: 'partial' }
          : result,
      );
    };
    const timer = setTimeout(
      () => finish({ status: 'connect_failed' }),
      SFTP_TIMEOUT_MS * 3,
    );
    client.on('ready', () => {
      client.sftp((error, sftp) => {
        if (error) return finish({ status: 'upload_failed' });
        void writeAll(sftp, remoteDir, files, progress).then(finish);
      });
    });
    client.on('error', (error: Error & { level?: string }) => {
      if (seen !== null && pinned === null)
        return finish({ status: 'hostkey_unknown', hostKey: seen });
      if (seen !== null && seen !== pinned)
        return finish({ status: 'hostkey_changed', hostKey: seen });
      finish({
        status:
          error.level === 'client-authentication'
            ? 'auth_failed'
            : 'connect_failed',
      });
    });
    client.on('close', () => finish({ status: 'connect_failed' }));
    const config: ConnectConfig = {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      readyTimeout: SFTP_TIMEOUT_MS,
      // Only what the person gave: no agent, no keyboard-interactive prompts.
      agent: undefined,
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        seen = hostKeyFingerprint(key);
        return pinned !== null && seen === pinned;
      },
    };
    if (connection.privateKey !== undefined) {
      config.privateKey = connection.privateKey;
      if (connection.passphrase !== undefined)
        config.passphrase = connection.passphrase;
    } else if (connection.password !== undefined) {
      config.password = connection.password;
    }
    try {
      client.connect(config);
    } catch {
      // A key file ssh2 cannot parse (or a wrong passphrase for it).
      finish({ status: 'auth_failed' });
    }
  });
}

async function writeAll(
  sftp: SFTPWrapper,
  remoteDir: string,
  files: readonly DeployFile[],
  progress: { made: boolean },
): Promise<UploadResult> {
  const folder = files[0]?.name.split('/')[0];
  if (folder === undefined) return { status: 'upload_failed' };
  const target = posix.join(remoteDir, folder);
  const made = await new Promise<'made' | 'exists' | 'failed'>((resolve) => {
    sftp.mkdir(target, (error) => {
      if (!error) return resolve('made');
      // SFTP has no "exists" code for mkdir: look whether something is there.
      sftp.stat(target, (missing) => resolve(missing ? 'failed' : 'exists'));
    });
  });
  if (made !== 'made')
    return { status: made === 'exists' ? 'exists' : 'upload_failed' };
  progress.made = true;
  for (const file of files) {
    const written = await new Promise<boolean>((resolve) => {
      sftp.open(posix.join(remoteDir, file.name), 'wx', (error, handle) => {
        if (error) return resolve(false);
        const data = Buffer.from(file.data);
        sftp.write(handle, data, 0, data.length, 0, (writeError) => {
          sftp.close(handle, (closeError) =>
            resolve(!writeError && !closeError),
          );
        });
      });
    });
    if (!written) return { status: 'upload_failed' };
  }
  return { status: 'uploaded' };
}
