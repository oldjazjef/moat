import type { SecretSealResult } from '../../shared/bridge';
import type {
  SealDialogTexts,
  SealDialogView,
  SealNotice,
} from '../../shared/seal-dialog';

/** The API's in-process answers (apps/api/src/project/application/secret-sealing.service.ts). */
export interface SealPreview {
  readonly project: string;
  readonly gate: string;
  readonly gateId: string;
  readonly boxKeyFingerprint: string;
  readonly name: string;
  readonly currentVersion: number | null;
  readonly nextVersion: number;
  readonly usedBy: SealDialogView['usedBy'];
  readonly comparedBy: SealDialogView['comparedBy'];
  readonly digest: string;
}

type Refusal = Extract<SecretSealResult, { status: 'refused' }>['code'];

export type PrepareSealResult =
  | { readonly status: 'ready'; readonly preview: SealPreview }
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: Refusal };

export type SealResult =
  | { readonly status: 'sealed'; readonly secretVersion: number }
  | { readonly status: 'not_found' }
  | { readonly status: 'changed' }
  | { readonly status: 'refused'; readonly code: Refusal }
  | { readonly status: 'value_invalid' }
  | { readonly status: 'not_writable' };

/** More than any value may have (core MAX_SECRET_BYTES is 8 KiB): bigger input is not passed on. */
export const MAX_VALUE_BYTES = 8 * 1024;

export interface SealingDeps {
  readonly texts: SealDialogTexts;
  prepare(): Promise<PrepareSealResult>;
  /** The API zeroes `value` before it returns. */
  seal(digest: string, value: Uint8Array): Promise<SealResult>;
}

export type SealStep =
  { readonly view: SealDialogView } | { readonly done: SecretSealResult };

/**
 * One seal dialog: the gate (by fingerprint) and the secret the person confirms, then the value.
 * The value is bound to the gate key and version shown; when they changed meanwhile nothing is
 * written and the window shows the new state.
 */
export class SealingSession {
  private preview: SealPreview | null = null;
  private notice: SealNotice | null = null;
  private busy = false;

  constructor(private readonly deps: SealingDeps) {}

  async open(): Promise<SealStep> {
    const prepared = await this.deps.prepare();
    if (prepared.status !== 'ready') return { done: refusal(prepared) };
    this.preview = prepared.preview;
    return { view: this.view() };
  }

  view(): SealDialogView {
    const preview = this.preview;
    if (preview === null) throw new Error('seal session not open');
    return {
      texts: this.deps.texts,
      project: preview.project,
      gate: preview.gate,
      gateId: preview.gateId,
      fingerprint: preview.boxKeyFingerprint,
      name: preview.name,
      currentVersion: preview.currentVersion,
      nextVersion: preview.nextVersion,
      usedBy: preview.usedBy,
      comparedBy: preview.comparedBy,
      notice: this.notice,
    };
  }

  /** `value` is zeroed before this returns, whatever happens. */
  async confirm(value: Uint8Array): Promise<SealStep> {
    try {
      const preview = this.preview;
      if (preview === null || this.busy) return { view: this.view() };
      if (value.length === 0 || value.length > MAX_VALUE_BYTES)
        return this.show('value_invalid');
      this.busy = true;
      try {
        return await this.sealOnce(preview, value);
      } finally {
        this.busy = false;
      }
    } finally {
      value.fill(0);
    }
  }

  private async sealOnce(
    preview: SealPreview,
    value: Uint8Array,
  ): Promise<SealStep> {
    const result = await this.deps.seal(preview.digest, value);
    switch (result.status) {
      case 'sealed':
        return {
          done: { status: 'sealed', secretVersion: result.secretVersion },
        };
      case 'value_invalid':
        return this.show('value_invalid');
      case 'changed': {
        const prepared = await this.deps.prepare();
        if (prepared.status !== 'ready') return { done: refusal(prepared) };
        this.preview = prepared.preview;
        return this.show('changed');
      }
      case 'refused':
        return { done: { status: 'refused', code: result.code } };
      case 'not_writable':
        return { done: { status: 'not_writable' } };
      case 'not_found':
        return { done: { status: 'failed' } };
    }
  }

  private show(notice: SealNotice): SealStep {
    this.notice = notice;
    return { view: this.view() };
  }
}

function refusal(
  prepared: Exclude<PrepareSealResult, { status: 'ready' }>,
): SecretSealResult {
  return prepared.status === 'refused'
    ? { status: 'refused', code: prepared.code }
    : { status: 'failed' };
}
