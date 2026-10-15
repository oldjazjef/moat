import { rmSync, writeFileSync } from 'node:fs';
import type { SigningKeyInfo, SigningKeyResult } from '../../shared/bridge';
import {
  type KeyDialogConfirm,
  type KeyDialogTexts,
  type KeyDialogView,
  type KeyNotice,
  MAX_PASSPHRASE,
  MIN_PASSPHRASE,
} from '../../shared/key-dialog';

export type WriteOutcome = 'written' | 'exists' | 'failed';

/**
 * Writes a new key file: never over an existing file (`wx`, which also refuses a symbolic link
 * at that place), readable by the owner only (0600, as `moat keygen`).
 */
export function writeKeyFile(path: string, text: string): WriteOutcome {
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
    return 'written';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    // `wx` created it, so it is ours: never leave half a key file behind (disk full, I/O error).
    rmSync(path, { force: true });
    return 'failed';
  }
}

export interface KeyCreationDeps {
  readonly texts: KeyDialogTexts;
  /** The main process's save dialog; null when the person cancelled it. */
  chooseTarget(): Promise<string | null>;
  /** core createKeyFile through the API bundle (Argon2id, in-process). */
  create(passphrase: string): Promise<{ text: string; key: SigningKeyInfo }>;
  write(path: string, text: string): WriteOutcome;
  /** The new file becomes the desktop's signing key (config.json `keyFile`). */
  use(path: string): void | Promise<void>;
}

export type KeyStep =
  { readonly view: KeyDialogView } | { readonly done: SigningKeyResult };

/**
 * One key window: the passphrase twice, then where to save. Checks the passphrase before anything
 * is asked or written; the key is created only once a place was chosen.
 */
export class KeyCreationSession {
  private notice: KeyNotice | null = null;
  private busy = false;

  constructor(private readonly deps: KeyCreationDeps) {}

  view(): KeyDialogView {
    return { texts: this.deps.texts, notice: this.notice };
  }

  async confirm(input: KeyDialogConfirm): Promise<KeyStep> {
    if (this.busy) return { view: this.view() };
    if (input.passphrase.length < MIN_PASSPHRASE) return this.show('too_short');
    if (input.passphrase.length > MAX_PASSPHRASE) return this.show('too_long');
    if (input.passphrase !== input.repeat) return this.show('mismatch');
    this.busy = true;
    try {
      const target = await this.deps.chooseTarget();
      if (target === null) return this.show(null);
      const { text, key } = await this.deps.create(input.passphrase);
      switch (this.deps.write(target, text)) {
        case 'exists':
          return this.show('exists');
        case 'failed':
          return this.show('not_writable');
        case 'written':
          await this.deps.use(target);
          return { done: { status: 'created', key } };
      }
    } finally {
      this.busy = false;
    }
  }

  private show(notice: KeyNotice | null): KeyStep {
    this.notice = notice;
    return { view: this.view() };
  }
}
