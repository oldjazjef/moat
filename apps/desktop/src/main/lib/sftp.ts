import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import type { DeployResult } from '../../shared/bridge';
import type {
  SftpAuth,
  SftpDialogInput,
  SftpDialogTexts,
  SftpDialogView,
  SftpNotice,
} from '../../shared/sftp-dialog';
import type { DeployFile, DeployPackage } from './deploy';
import type { SftpConnection, UploadResult } from './sftp-client';

/**
 * A gate's SFTP target (DT-05), kept in the desktop's config.json, never in the project folder.
 * The password or key passphrase only as `safeStorage` ciphertext, and only with a real keychain
 * (DT-04); the host key pinned on first use, after the person compared it (T-67).
 */
export interface SftpTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly remoteDir: string;
  readonly auth: SftpAuth;
  /** For `key`: the OpenSSH private key file the person chose. */
  readonly keyFile: string | null;
  /** `SHA256:…` */
  readonly hostKey: string | null;
  /** base64 of the keychain's ciphertext of the password or passphrase. */
  readonly secret: string | null;
}

/** A DNS name, IPv4 or IPv6 literal. */
export const SFTP_HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:.]{2,45})$/;
export const SFTP_USER = /^[A-Za-z0-9._@+-]{1,64}$/;
/** A plain POSIX path, relative to the login folder or absolute; no `.` or `..` segment. */
export const SFTP_DIR =
  /^\/?(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,127}\/?){0,16}$/;
export const SFTP_HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/;
/** Far more than a password or passphrase needs. */
export const MAX_SECRET_LENGTH = 1024;
/** An OpenSSH private key is a few KiB at most. */
export const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

export interface SftpKeychain {
  readonly available: boolean;
  seal(secret: string): string;
  /** null when the ciphertext no longer opens (another keychain, a damaged entry). */
  open(sealed: string): string | null;
}

export interface SftpDeps {
  readonly texts: SftpDialogTexts;
  readonly pkg: DeployPackage;
  readonly files: readonly DeployFile[];
  readonly keychain: SftpKeychain;
  stored(): SftpTarget | null;
  save(target: SftpTarget): void;
  forget(): void;
  /** The main process's file dialog; null when cancelled. */
  chooseKeyFile(): Promise<string | null>;
  /** The key file's bytes, null when it is not a readable regular file of a sane size. */
  readPrivateKey(path: string): Buffer | null;
  upload(
    connection: SftpConnection,
    pinned: string | null,
    remoteDir: string,
    files: readonly DeployFile[],
  ): Promise<UploadResult>;
}

export type SftpStep =
  { readonly view: SftpDialogView } | { readonly done: DeployResult };

interface Draft {
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly remoteDir: string;
  readonly auth: SftpAuth;
}

interface Attempt {
  readonly target: Omit<SftpTarget, 'hostKey' | 'secret'>;
  readonly connection: SftpConnection;
  /** What to keep in the keychain on success: the sealed secret, or null. */
  readonly remember: string | null;
  readonly hostKey: string | null;
}

/**
 * One SFTP window: the target (prefilled from the last upload), then — on first contact or after
 * «Ziel entfernen» — the server's host key to compare, then the upload of the package as a new
 * folder. Nothing is sent but the SSH handshake before the person trusted the host key.
 */
export class SftpSession {
  private draft: Draft;
  private keyFile: string | null;
  private pending: Attempt | null = null;
  private notice: SftpNotice | null = null;
  private busy = false;

  constructor(private readonly deps: SftpDeps) {
    const stored = deps.stored();
    this.keyFile = stored?.keyFile ?? null;
    this.draft = {
      host: stored?.host ?? '',
      port: String(stored?.port ?? 22),
      username: stored?.username ?? '',
      // '.' is the login folder, which the field shows as empty.
      remoteDir:
        stored === null || stored.remoteDir === '.' ? '' : stored.remoteDir,
      auth: stored?.auth ?? 'password',
    };
  }

  view(): SftpDialogView {
    const { pkg } = this.deps;
    const stored = this.deps.stored();
    const same = stored !== null && this.matches(stored, this.draft);
    return {
      texts: this.deps.texts,
      project: pkg.project,
      gate: pkg.gate,
      gateId: pkg.gateId,
      version: pkg.version,
      files: this.deps.files.map((file) => file.name),
      step: this.pending === null ? 'target' : 'hostkey',
      target: {
        ...this.draft,
        keyName: this.keyFile === null ? null : basename(this.keyFile),
        secretRemembered:
          same && stored.secret !== null && this.deps.keychain.available,
        hostKey: same ? stored.hostKey : null,
      },
      canRemember: this.deps.keychain.available,
      hostKey: this.pending?.hostKey ?? null,
      notice: this.notice,
    };
  }

  async chooseKey(): Promise<SftpDialogView> {
    const path = await this.deps.chooseKeyFile();
    if (path !== null) {
      this.keyFile = path;
      this.draft = { ...this.draft, auth: 'key' };
      this.notice = null;
    }
    return this.view();
  }

  forget(): SftpDialogView {
    this.deps.forget();
    this.pending = null;
    this.notice = 'forgotten';
    return this.view();
  }

  async connect(input: SftpDialogInput): Promise<SftpStep> {
    if (this.busy) return { view: this.view() };
    this.pending = null;
    this.draft = {
      host: input.host.trim(),
      port: input.port.trim(),
      username: input.username.trim(),
      remoteDir: input.remoteDir.trim(),
      auth: input.auth,
    };
    const port = Number(this.draft.port);
    if (
      !SFTP_HOST.test(this.draft.host) ||
      !/^[0-9]{1,5}$/.test(this.draft.port) ||
      port < 1 ||
      port > 65535 ||
      !SFTP_USER.test(this.draft.username) ||
      !SFTP_DIR.test(this.draft.remoteDir) ||
      this.draft.remoteDir
        .split('/')
        .some((part) => part === '.' || part === '..') ||
      input.secret.length > MAX_SECRET_LENGTH
    )
      return this.show('target_invalid');

    const target = {
      host: this.draft.host,
      port,
      username: this.draft.username,
      remoteDir: this.draft.remoteDir === '' ? '.' : this.draft.remoteDir,
      auth: this.draft.auth,
      keyFile: this.draft.auth === 'key' ? this.keyFile : null,
    };
    const stored = this.deps.stored();
    const same = stored !== null && this.matches(stored, this.draft);
    const remembered =
      same && stored.secret !== null && this.deps.keychain.available
        ? this.deps.keychain.open(stored.secret)
        : null;
    const secret = input.secret !== '' ? input.secret : (remembered ?? '');

    let connection: SftpConnection;
    if (target.auth === 'key') {
      if (target.keyFile === null) return this.show('key_missing');
      const privateKey = this.deps.readPrivateKey(target.keyFile);
      if (privateKey === null) return this.show('key_unreadable');
      connection = {
        host: target.host,
        port,
        username: target.username,
        privateKey,
        ...(secret === '' ? {} : { passphrase: secret }),
      };
    } else {
      if (secret === '') return this.show('secret_missing');
      connection = {
        host: target.host,
        port,
        username: target.username,
        password: secret,
      };
    }
    const remember =
      input.remember && this.deps.keychain.available && secret !== ''
        ? input.secret === '' && same && stored.secret !== null
          ? stored.secret
          : this.deps.keychain.seal(secret)
        : null;
    const attempt: Attempt = { target, connection, remember, hostKey: null };
    const pinned = same ? stored.hostKey : null;
    return this.attempt(
      attempt,
      pinned,
      input.secret === '' && remembered !== null,
    );
  }

  /** The person compared the host key shown and trusts it: connect again with it pinned. */
  async trustHostKey(): Promise<SftpStep> {
    const pending = this.pending;
    if (pending === null || pending.hostKey === null || this.busy)
      return { view: this.view() };
    this.pending = null;
    return this.attempt(pending, pending.hostKey, false);
  }

  private async attempt(
    attempt: Attempt,
    pinned: string | null,
    usedRemembered: boolean,
  ): Promise<SftpStep> {
    this.busy = true;
    let result: UploadResult;
    try {
      result = await this.deps.upload(
        attempt.connection,
        pinned,
        attempt.target.remoteDir,
        this.deps.files,
      );
    } finally {
      this.busy = false;
    }
    switch (result.status) {
      case 'uploaded':
        this.deps.save({
          ...attempt.target,
          hostKey: pinned,
          secret: attempt.remember,
        });
        return {
          done: {
            status: 'exported',
            target: 'sftp',
            version: this.deps.pkg.version,
          },
        };
      case 'hostkey_unknown':
        if (!SFTP_HOST_KEY.test(result.hostKey))
          return this.show('connect_failed');
        this.pending = { ...attempt, hostKey: result.hostKey };
        this.notice = null;
        return { view: this.view() };
      case 'hostkey_changed':
        return this.show('hostkey_changed');
      case 'auth_failed': {
        // A remembered secret that no longer works is dropped, never tried again.
        const stored = this.deps.stored();
        if (usedRemembered && stored !== null)
          this.deps.save({ ...stored, secret: null });
        return this.show('auth_failed');
      }
      case 'connect_failed':
      case 'exists':
      case 'upload_failed':
        return this.show(result.status);
    }
  }

  private matches(stored: SftpTarget, draft: Draft): boolean {
    return (
      stored.host === draft.host &&
      String(stored.port) === draft.port &&
      stored.username === draft.username &&
      stored.auth === draft.auth
    );
  }

  private show(notice: SftpNotice): SftpStep {
    this.notice = notice;
    return { view: this.view() };
  }
}

/**
 * The private key file the person chose: a regular file of at most MAX_PRIVATE_KEY_BYTES, read
 * without blocking (a FIFO must not hang the main process). Null when it cannot be read.
 */
export function readPrivateKey(path: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      process.platform === 'win32'
        ? 'r'
        : constants.O_RDONLY | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PRIVATE_KEY_BYTES) return null;
    const buffer = Buffer.alloc(MAX_PRIVATE_KEY_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_PRIVATE_KEY_BYTES) return null;
    }
    return buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
