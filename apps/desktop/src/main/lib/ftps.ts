import type { DeployResult } from '../../shared/bridge';
import type {
  FtpsCertificate,
  FtpsDialogInput,
  FtpsDialogTexts,
  FtpsDialogView,
  FtpsMode,
  FtpsNotice,
} from '../../shared/ftps-dialog';
import type { DeployFile, DeployPackage } from './deploy';
import type { FtpsConnection, FtpsUploadResult } from './ftps-client';
import { FTPS_FINGERPRINT } from './ftps-client';
import {
  isRemoteDir,
  MAX_SECRET_LENGTH,
  SFTP_HOST,
  SFTP_USER,
  type SftpKeychain,
} from './sftp';

/**
 * A gate's FTPS target (DT-05, T-69), kept in the desktop's config.json, never in the project
 * folder. The password only as `safeStorage` ciphertext, and only with a real keychain (DT-04);
 * a certificate no CA vouches for pinned on first use, after the person compared it.
 */
export interface FtpsTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly remoteDir: string;
  readonly mode: FtpsMode;
  /** `SHA256:AB:…` of the pinned certificate; null while a CA vouches for it (or none yet). */
  readonly certificate: string | null;
  /** base64 of the keychain's ciphertext of the password. */
  readonly secret: string | null;
}

export interface FtpsDeps {
  readonly texts: FtpsDialogTexts;
  readonly pkg: DeployPackage;
  readonly files: readonly DeployFile[];
  readonly keychain: SftpKeychain;
  stored(): FtpsTarget | null;
  save(target: FtpsTarget): void;
  forget(): void;
  upload(
    connection: FtpsConnection,
    pinned: string | null,
    remoteDir: string,
    files: readonly DeployFile[],
  ): Promise<FtpsUploadResult>;
}

export type FtpsStep =
  { readonly view: FtpsDialogView } | { readonly done: DeployResult };

interface Draft {
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly remoteDir: string;
  readonly mode: FtpsMode;
}

interface Attempt {
  readonly target: Omit<FtpsTarget, 'certificate' | 'secret'>;
  readonly connection: FtpsConnection;
  /** What to keep in the keychain on success: the sealed password, or null. */
  readonly remember: string | null;
  readonly certificate: FtpsCertificate | null;
}

/**
 * One FTPS window: the target (prefilled from the last upload), then — on first contact with a
 * certificate no CA vouches for, or after «Ziel entfernen» — the certificate to compare, then the
 * upload of the package as a new folder. Nothing is sent but the TLS handshake before the
 * certificate is trusted.
 */
export class FtpsSession {
  private draft: Draft;
  private pending: Attempt | null = null;
  private notice: FtpsNotice | null = null;
  private busy = false;

  constructor(private readonly deps: FtpsDeps) {
    const stored = deps.stored();
    this.draft = {
      host: stored?.host ?? '',
      port: String(stored?.port ?? 21),
      username: stored?.username ?? '',
      // '.' is the login folder, which the field shows as empty.
      remoteDir:
        stored === null || stored.remoteDir === '.' ? '' : stored.remoteDir,
      mode: stored?.mode ?? 'explicit',
    };
  }

  view(): FtpsDialogView {
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
      step: this.pending === null ? 'target' : 'certificate',
      target: {
        ...this.draft,
        secretRemembered:
          same && stored.secret !== null && this.deps.keychain.available,
        certificate:
          stored !== null && this.sameServer(stored, this.draft)
            ? stored.certificate
            : null,
      },
      canRemember: this.deps.keychain.available,
      certificate: this.pending?.certificate ?? null,
      notice: this.notice,
    };
  }

  forget(): FtpsDialogView {
    this.deps.forget();
    this.pending = null;
    this.notice = 'forgotten';
    return this.view();
  }

  async connect(input: FtpsDialogInput): Promise<FtpsStep> {
    if (this.busy) return { view: this.view() };
    this.pending = null;
    this.draft = {
      host: input.host.trim(),
      port: input.port.trim(),
      username: input.username.trim(),
      remoteDir: input.remoteDir.trim(),
      mode: input.mode,
    };
    const port = Number(this.draft.port);
    if (
      !SFTP_HOST.test(this.draft.host) ||
      !/^[0-9]{1,5}$/.test(this.draft.port) ||
      port < 1 ||
      port > 65535 ||
      !SFTP_USER.test(this.draft.username) ||
      !isRemoteDir(this.draft.remoteDir) ||
      input.secret.length > MAX_SECRET_LENGTH
    )
      return this.show('target_invalid');

    const target = {
      host: this.draft.host,
      port,
      username: this.draft.username,
      remoteDir: this.draft.remoteDir === '' ? '.' : this.draft.remoteDir,
      mode: this.draft.mode,
    };
    const stored = this.deps.stored();
    const same = stored !== null && this.matches(stored, this.draft);
    const remembered =
      same && stored.secret !== null && this.deps.keychain.available
        ? this.deps.keychain.open(stored.secret)
        : null;
    const secret = input.secret !== '' ? input.secret : (remembered ?? '');
    if (secret === '') return this.show('secret_missing');
    const remember =
      input.remember && this.deps.keychain.available
        ? input.secret === '' && same && stored.secret !== null
          ? stored.secret
          : this.deps.keychain.seal(secret)
        : null;
    const attempt: Attempt = {
      target,
      connection: {
        host: target.host,
        port,
        username: target.username,
        password: secret,
        mode: target.mode,
      },
      remember,
      certificate: null,
    };
    // The pin belongs to the server (host and port), whoever logs in there.
    const pinned =
      stored !== null && this.sameServer(stored, this.draft)
        ? stored.certificate
        : null;
    return this.attempt(
      attempt,
      pinned,
      input.secret === '' && remembered !== null,
    );
  }

  /** The person compared the certificate shown and trusts it: connect again with it pinned. */
  async trustCertificate(): Promise<FtpsStep> {
    const pending = this.pending;
    if (pending === null || pending.certificate === null || this.busy)
      return { view: this.view() };
    this.pending = null;
    return this.attempt(pending, pending.certificate.fingerprint, false);
  }

  private async attempt(
    attempt: Attempt,
    pinned: string | null,
    usedRemembered: boolean,
  ): Promise<FtpsStep> {
    this.busy = true;
    let result: FtpsUploadResult;
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
          certificate: pinned,
          secret: attempt.remember,
        });
        return {
          done: {
            status: 'exported',
            target: 'ftps',
            version: this.deps.pkg.version,
          },
        };
      case 'certificate_unknown':
        if (!FTPS_FINGERPRINT.test(result.certificate.fingerprint))
          return this.show('tls_failed');
        this.pending = { ...attempt, certificate: result.certificate };
        this.notice = null;
        return { view: this.view() };
      case 'certificate_changed':
        return this.show('certificate_changed');
      case 'auth_failed': {
        // A remembered password that no longer works is dropped, never tried again.
        const stored = this.deps.stored();
        if (usedRemembered && stored !== null)
          this.deps.save({ ...stored, secret: null });
        return this.show('auth_failed');
      }
      case 'connect_failed':
      case 'tls_failed':
      case 'exists':
      case 'partial':
      case 'upload_failed':
        return this.show(result.status);
    }
  }

  private sameServer(stored: FtpsTarget, draft: Draft): boolean {
    return stored.host === draft.host && String(stored.port) === draft.port;
  }

  private matches(stored: FtpsTarget, draft: Draft): boolean {
    return (
      this.sameServer(stored, draft) &&
      stored.username === draft.username &&
      stored.mode === draft.mode
    );
  }

  private show(notice: FtpsNotice): FtpsStep {
    this.notice = notice;
    return { view: this.view() };
  }
}
