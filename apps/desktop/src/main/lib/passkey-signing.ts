import type { BundleSignResult } from '../../shared/bridge';
import type {
  PasskeyAssertionOutcome,
  PasskeyGetRequest,
  PasskeySignBegin,
  PasskeySignNotice,
  PasskeySignTexts,
  PasskeySignView,
} from '../../shared/passkey-dialog';
import { CEREMONY_TIMEOUT_MS } from './passkey-enrollment';
import { bytesOf, type PasskeyRecord } from './passkey';
import type { BundlePreview, PrepareResult, SignResult } from './signing';

/** What the passkey signed, as the API wants it (apps/api bundle-signing.service.ts). */
export interface Assertion {
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  readonly signature: Uint8Array;
}

export interface PasskeySigningDeps {
  readonly texts: PasskeySignTexts;
  /** The passkey this desktop signs with (config.json), public data. */
  readonly passkey: PasskeyRecord;
  /** The key's fingerprint, shown to compare with the gate's. */
  readonly fingerprint: string;
  prepare(): Promise<PrepareResult>;
  /**
   * Signs the bundle of `digest`: asks `assert` for the passkey's signature over the challenge
   * and writes the bundle only when it verifies as the gate would (apps/api signWithPasskey).
   */
  sign(
    digest: string,
    assert: (challenge: Uint8Array) => Promise<Assertion | null>,
  ): Promise<SignResult>;
}

export type PasskeySignStep =
  { readonly view: PasskeySignView } | { readonly done: BundleSignResult };

type Pending = {
  readonly deliver: (assertion: Assertion | null) => void;
};

/**
 * One signing dialog for a gate in trust mode 2 (DT-15 with a passkey): the person checks the
 * preview, then the window asks the passkey. The digest they confirmed is what is signed — the
 * API turns the payload into the WebAuthn challenge (`webauthnChallenge`), the window hands it
 * to `navigator.credentials.get` with the stored credential id, and the answer is verified
 * against the pinned passkey before anything is written. A project that changed meanwhile, a
 * credential that is not the stored one, or a signature that does not verify writes nothing.
 */
export class PasskeySigningSession {
  private preview: BundlePreview | null = null;
  private notice: PasskeySignNotice | null = null;
  private signing: Promise<SignResult> | null = null;
  private pending: Pending | null = null;
  private rejected = false;

  constructor(private readonly deps: PasskeySigningDeps) {}

  async open(): Promise<PasskeySignStep> {
    return this.refresh();
  }

  private async refresh(): Promise<PasskeySignStep> {
    const prepared = await this.deps.prepare();
    if (prepared.status !== 'ready') return { done: refusal(prepared) };
    this.preview = prepared.preview;
    return { view: this.view() };
  }

  view(): PasskeySignView {
    const preview = this.preview;
    if (preview === null) throw new Error('signing session not open');
    return {
      texts: this.deps.texts,
      project: preview.project,
      gate: preview.gate,
      version: preview.version,
      previousVersion: preview.previousVersion,
      locked: preview.locked,
      changes: preview.changes,
      previous: preview.previous,
      fingerprint: this.deps.fingerprint,
      rpId: this.deps.passkey.rpId,
      notice: this.notice,
    };
  }

  /**
   * The person confirmed the preview: plans the bundle and returns the passkey request for the
   * window, or the view again when there is nothing to ask (the project changed, …).
   */
  async begin(): Promise<
    | { readonly begin: PasskeySignBegin }
    | { readonly done: BundleSignResult }
    | null
  > {
    const preview = this.preview;
    if (preview === null || this.signing !== null) return null;
    this.notice = null;
    this.rejected = false;
    let asked!: (request: PasskeyGetRequest) => void;
    const requested = new Promise<PasskeyGetRequest>((resolve) => {
      asked = resolve;
    });
    const signing = this.deps.sign(
      preview.digest,
      (challenge) =>
        new Promise<Assertion | null>((resolve) => {
          this.pending = { deliver: resolve };
          asked({
            challenge: Buffer.from(challenge).toString('base64url'),
            credentialId: this.deps.passkey.credentialId,
            rpId: this.deps.passkey.rpId,
            timeoutMs: CEREMONY_TIMEOUT_MS,
          });
        }),
    );
    this.signing = signing;
    const first = await Promise.race([
      requested.then((request) => ({ request })),
      signing.then((result) => ({ result })),
    ]);
    if ('request' in first)
      return { begin: { kind: 'request', request: first.request } };
    // Ended before the passkey was asked: the project changed, or the bundle cannot be made.
    this.signing = null;
    const step = await this.conclude(first.result);
    return 'view' in step ? { begin: { kind: 'view', view: step.view } } : step;
  }

  /** The window's answer from `navigator.credentials.get`. */
  async deliver(outcome: PasskeyAssertionOutcome): Promise<PasskeySignStep> {
    const pending = this.pending;
    const signing = this.signing;
    if (pending === null || signing === null) return { view: this.view() };
    this.pending = null;
    let assertion: Assertion | null = null;
    if (outcome.status === 'asserted') {
      const bytes = {
        authenticatorData: bytesOf(outcome.authenticatorData, 1024),
        clientDataJSON: bytesOf(outcome.clientDataJSON, 2048),
        signature: bytesOf(outcome.signature, 80),
      };
      // Only the stored passkey may answer; anything else is an invalid assertion.
      if (
        outcome.credentialId === this.deps.passkey.credentialId &&
        bytes.authenticatorData !== null &&
        bytes.clientDataJSON !== null &&
        bytes.signature !== null
      )
        assertion = {
          authenticatorData: bytes.authenticatorData,
          clientDataJSON: bytes.clientDataJSON,
          signature: bytes.signature,
        };
      else this.rejected = true;
    } else {
      this.notice = outcome.reason;
    }
    pending.deliver(assertion);
    const result = await signing;
    this.signing = null;
    return this.conclude(result);
  }

  /** The window is closed or cancelled while the passkey was asked. */
  cancel(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.deliver(null);
  }

  private async conclude(result: SignResult): Promise<PasskeySignStep> {
    switch (result.status) {
      case 'signed':
        return { done: { status: 'signed', version: result.version } };
      case 'changed': {
        const step = await this.refresh();
        if ('view' in step) this.notice = 'changed';
        return 'view' in step ? { view: this.view() } : step;
      }
      case 'passkey_refused':
        this.notice =
          result.code === 'assertion_invalid' || this.rejected
            ? 'assertion_invalid'
            : (this.notice ?? 'cancelled');
        return { view: this.view() };
      case 'refused':
        return {
          done: { status: 'refused', code: result.code, secrets: [] },
        };
      case 'not_writable':
        return { done: { status: 'not_writable' } };
      case 'not_found':
      case 'key_refused':
        return { done: { status: 'failed' } };
    }
  }
}

function refusal(
  prepared: Exclude<PrepareResult, { status: 'ready' }>,
): BundleSignResult {
  return prepared.status === 'refused'
    ? { status: 'refused', code: prepared.code, secrets: [...prepared.secrets] }
    : { status: 'failed' };
}
