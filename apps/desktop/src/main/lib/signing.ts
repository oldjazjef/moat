import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import type { BundleSignResult } from '../../shared/bridge';
import type {
  SignDialogConfirm,
  SignDialogTexts,
  SignDialogView,
  SignNotice,
} from '../../shared/sign-dialog';

/** Far more than a key file needs (about 400 bytes); anything bigger is not one. */
export const MAX_KEY_FILE_BYTES = 64 * 1024;
const KID = /^[A-Za-z0-9_-]{22}$/;

/** The API's in-process answers (apps/api/src/project/application/bundle-signing.service.ts). */
export interface BundlePreview {
  readonly project: string;
  readonly gate: string;
  readonly version: number;
  readonly previousVersion: number;
  readonly locked: boolean;
  readonly changes: SignDialogView['changes'];
  readonly previous: SignDialogView['previous'];
  readonly digest: string;
}

/** The chosen key's public half, for the comparison with earlier bundles (core PlanSigner). */
export interface PlanSigner {
  readonly kid: string;
  readonly publicKey: Uint8Array;
}

export type PrepareResult =
  | { readonly status: 'ready'; readonly preview: BundlePreview }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'refused';
      readonly code: Extract<BundleSignResult, { status: 'refused' }>['code'];
      readonly secrets: readonly string[];
    };

export type SignResult =
  | {
      readonly status: 'signed';
      readonly version: number;
      readonly kid: string;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'changed' }
  | {
      readonly status: 'refused';
      readonly code: Extract<BundleSignResult, { status: 'refused' }>['code'];
    }
  | {
      readonly status: 'key_refused';
      readonly code: 'keyfile_locked' | 'keyfile_invalid';
    }
  | { readonly status: 'not_writable' };

/** Electron `safeStorage`, as far as the vault needs it. */
export interface Keychain {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(sealed: Buffer): string;
}

export interface KeyFileText {
  readonly path: string;
  readonly text: string;
  /** The kid the file names; shown and used to find a remembered passphrase, never trusted. */
  readonly kid: string | null;
  /**
   * Its public key (`kid` + `pk`): earlier bundles count for the comparison only when they
   * verify against it. A file that lies here only loses that comparison; it cannot sign.
   */
  readonly signer: PlanSigner | null;
}

/**
 * Reads a key file the person chose: a regular file of at most MAX_KEY_FILE_BYTES. Null when it
 * cannot be read. Its content is checked only when it is opened (core's openKeyFile).
 */
export function readKeyFile(path: string): KeyFileText | null {
  let fd: number | null = null;
  try {
    // Non-blocking: a FIFO in place of the key file must not hang the main process.
    fd = openSync(
      path,
      process.platform === 'win32'
        ? 'r'
        : constants.O_RDONLY | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_KEY_FILE_BYTES) return null;
    const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_KEY_FILE_BYTES) return null;
    }
    const text = buffer.subarray(0, length).toString('utf8');
    const named = namedKey(text);
    return { path, text, kid: named.kid, signer: named.signer };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function namedKey(text: string): {
  kid: string | null;
  signer: PlanSigner | null;
} {
  try {
    const value = JSON.parse(text) as unknown;
    const record =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const kid =
      typeof record['kid'] === 'string' && KID.test(record['kid'])
        ? record['kid']
        : null;
    const pk = record['pk'];
    const publicKey =
      typeof pk === 'string' && /^[A-Za-z0-9_-]{43}$/.test(pk)
        ? new Uint8Array(Buffer.from(pk, 'base64url'))
        : null;
    return {
      kid,
      signer:
        kid !== null && publicKey?.length === 32 ? { kid, publicKey } : null,
    };
  } catch {
    return { kid: null, signer: null };
  }
}

/**
 * Passphrases remembered in the OS keychain, by kid (DT-04). Only ciphertext from `safeStorage`
 * is stored; when the keychain is not available nothing is remembered.
 */
export class PassphraseVault {
  constructor(
    private readonly keychain: Keychain,
    private readonly load: () => Readonly<Record<string, string>>,
    private readonly save: (passphrases: Record<string, string>) => void,
  ) {}

  get available(): boolean {
    return this.keychain.isEncryptionAvailable();
  }

  has(kid: string | null): boolean {
    return kid !== null && this.available && Object.hasOwn(this.load(), kid);
  }

  /** The remembered passphrase; null (and forgotten) when the keychain cannot open it. */
  recall(kid: string): string | null {
    const sealed = this.load()[kid];
    if (sealed === undefined || !this.available) return null;
    try {
      return this.keychain.decryptString(Buffer.from(sealed, 'base64'));
    } catch {
      this.forget(kid);
      return null;
    }
  }

  remember(kid: string, passphrase: string): void {
    if (!KID.test(kid) || !this.available) return;
    const sealed = this.keychain.encryptString(passphrase).toString('base64');
    this.save({ ...this.load(), [kid]: sealed });
  }

  forget(kid: string): void {
    const passphrases = { ...this.load() };
    if (!Object.hasOwn(passphrases, kid)) return;
    delete passphrases[kid];
    this.save(passphrases);
  }
}

export interface SigningDeps {
  readonly texts: SignDialogTexts;
  /** The preview, compared with earlier bundles of `signer` (the chosen key; null: none). */
  prepare(signer: PlanSigner | null): Promise<PrepareResult>;
  sign(
    digest: string,
    keyFile: string,
    passphrase: string,
  ): Promise<SignResult>;
  /** The key file remembered from last time (config.json), or null. */
  keyFilePath(): string | null;
  /** The main process's file dialog; remembers and returns the chosen path, null on cancel. */
  chooseKeyFile(): Promise<string | null>;
  readonly vault: PassphraseVault;
}

export type Step =
  { readonly view: SignDialogView } | { readonly done: BundleSignResult };

/**
 * One signing dialog (DT-15): the preview the person confirms, the key file, the passphrase.
 * Signs only the digest of the preview shown; when the project changed meanwhile it shows the
 * new preview instead and signs nothing.
 */
export class SigningSession {
  private preview: BundlePreview | null = null;
  private notice: SignNotice | null = null;
  private busy = false;

  constructor(private readonly deps: SigningDeps) {}

  /** The first preview, or the outcome when there is nothing to sign. */
  async open(): Promise<Step> {
    const prepared = await this.deps.prepare(this.key()?.signer ?? null);
    if (prepared.status !== 'ready') return { done: refusal(prepared) };
    this.preview = prepared.preview;
    return { view: this.view() };
  }

  view(): SignDialogView {
    const preview = this.preview;
    if (preview === null) throw new Error('signing session not open');
    const key = this.key();
    return {
      texts: this.deps.texts,
      project: preview.project,
      gate: preview.gate,
      version: preview.version,
      previousVersion: preview.previousVersion,
      locked: preview.locked,
      changes: preview.changes,
      previous: preview.previous,
      keyFile: key === null ? null : { name: basename(key.path), kid: key.kid },
      remembered: this.deps.vault.has(key?.kid ?? null),
      canRemember: this.deps.vault.available,
      notice: this.notice,
    };
  }

  /** Another key file: the changes are compared with that key's bundles from now on. */
  async chooseKey(): Promise<Step> {
    if (this.busy || (await this.deps.chooseKeyFile()) === null)
      return { view: this.view() };
    this.notice = null;
    const prepared = await this.deps.prepare(this.key()?.signer ?? null);
    if (prepared.status !== 'ready') return { done: refusal(prepared) };
    this.preview = prepared.preview;
    return { view: this.view() };
  }

  async confirm(input: SignDialogConfirm): Promise<Step> {
    const preview = this.preview;
    if (preview === null || this.busy) return { view: this.view() };
    this.busy = true;
    try {
      return await this.signOnce(preview, input);
    } finally {
      this.busy = false;
    }
  }

  private async signOnce(
    preview: BundlePreview,
    input: SignDialogConfirm,
  ): Promise<Step> {
    const path = this.deps.keyFilePath();
    if (path === null) return this.show('key_missing');
    const key = readKeyFile(path);
    if (key === null) return this.show('key_unreadable');
    const fromKeychain = input.passphrase === '';
    const passphrase = fromKeychain
      ? key.kid === null
        ? null
        : this.deps.vault.recall(key.kid)
      : input.passphrase;
    if (passphrase === null || passphrase === '')
      return this.show('passphrase_missing');

    const result = await this.deps.sign(preview.digest, key.text, passphrase);
    switch (result.status) {
      case 'signed':
        if (input.remember) {
          if (!fromKeychain) this.deps.vault.remember(result.kid, passphrase);
        } else {
          this.deps.vault.forget(result.kid);
        }
        return { done: { status: 'signed', version: result.version } };
      case 'key_refused':
        if (
          result.code === 'keyfile_locked' &&
          fromKeychain &&
          key.kid !== null
        ) {
          this.deps.vault.forget(key.kid);
          return this.show('remembered_failed');
        }
        return this.show(result.code);
      case 'changed': {
        const prepared = await this.deps.prepare(key.signer);
        if (prepared.status !== 'ready') return { done: refusal(prepared) };
        this.preview = prepared.preview;
        return this.show('changed');
      }
      case 'refused':
        return {
          done: { status: 'refused', code: result.code, secrets: [] },
        };
      case 'not_writable':
        return { done: { status: 'not_writable' } };
      case 'not_found':
        return { done: { status: 'failed' } };
    }
  }

  private show(notice: SignNotice): Step {
    this.notice = notice;
    return { view: this.view() };
  }

  private key(): KeyFileText | null {
    const path = this.deps.keyFilePath();
    return path === null ? null : readKeyFile(path);
  }
}

function refusal(
  prepared: Exclude<PrepareResult, { status: 'ready' }>,
): BundleSignResult {
  return prepared.status === 'refused'
    ? { status: 'refused', code: prepared.code, secrets: [...prepared.secrets] }
    : { status: 'failed' };
}
