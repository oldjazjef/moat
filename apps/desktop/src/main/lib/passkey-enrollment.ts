import type {
  PasskeyCreateRequest,
  PasskeyEnrollDone,
  PasskeyEnrollNotice,
  PasskeyEnrollOutcome,
  PasskeyEnrollTexts,
  PasskeyEnrollView,
} from '../../shared/passkey-dialog';
import {
  PasskeyEnrollmentError,
  MAX_ATTESTATION_BYTES,
  MAX_CLIENT_DATA_BYTES,
  verifyEnrollment,
} from './passkey-attestation';
import {
  bytesOf,
  gatePinCommand,
  PASSKEY_ORIGIN,
  PASSKEY_RP_ID,
  type PasskeyRecord,
} from './passkey';

/** How long the system gets to answer one ceremony. */
export const CEREMONY_TIMEOUT_MS = 120_000;

export interface EnrollmentDeps {
  readonly texts: PasskeyEnrollTexts;
  /** CSPRNG (node:crypto randomBytes). */
  random(length: number): Uint8Array;
  /** The passkey remembered now (a new one replaces it). */
  existing(): PasskeyRecord | null;
  /** The key id and fingerprint of a point (the API's core, `passkeyKeyInfo`); null: not a point. */
  keyInfo(
    point: string,
  ): Promise<{ kid: string; publicKey: string; fingerprint: string } | null>;
  /** config.json; throws when it cannot be written. */
  store(record: PasskeyRecord): void;
}

/**
 * «Passkey anlegen» (trust mode 2): one ceremony in the passkey window. The main process makes
 * the challenge, the window calls `navigator.credentials.create` with it, and what comes back is
 * checked in full (passkey-attestation.ts) before the public key and the credential id are
 * stored. A challenge is good for one answer. Nothing secret exists here: the private key never
 * leaves the authenticator.
 */
export class PasskeyEnrollmentSession {
  private challenge: Uint8Array | null = null;
  private notice: PasskeyEnrollNotice | null = null;
  private done: PasskeyEnrollDone | null = null;
  private busy = false;

  constructor(private readonly deps: EnrollmentDeps) {}

  view(): PasskeyEnrollView {
    return {
      texts: this.deps.texts,
      rpId: PASSKEY_RP_ID,
      origin: PASSKEY_ORIGIN,
      replaces: this.deps.existing() !== null && this.done === null,
      notice: this.notice,
      done: this.done,
    };
  }

  /** A fresh challenge for one ceremony; null once a passkey is stored or while one is checked. */
  begin(): PasskeyCreateRequest | null {
    if (this.busy || this.done !== null) return null;
    this.notice = null;
    this.challenge = this.deps.random(32);
    return {
      challenge: Buffer.from(this.challenge).toString('base64url'),
      rpId: PASSKEY_RP_ID,
      rpName: 'Moat Desktop',
      userId: Buffer.from(this.deps.random(16)).toString('base64url'),
      userName: 'moat-desktop',
      timeoutMs: CEREMONY_TIMEOUT_MS,
    };
  }

  async finish(outcome: PasskeyEnrollOutcome): Promise<PasskeyEnrollView> {
    // The challenge is spent by the first answer, right or wrong.
    const challenge = this.challenge;
    this.challenge = null;
    if (this.busy || this.done !== null) return this.view();
    if (outcome.status === 'failed') {
      this.notice = outcome.reason;
      return this.view();
    }
    this.busy = true;
    try {
      return await this.store(challenge, outcome);
    } finally {
      this.busy = false;
    }
  }

  private async store(
    challenge: Uint8Array | null,
    outcome: Extract<PasskeyEnrollOutcome, { status: 'created' }>,
  ): Promise<PasskeyEnrollView> {
    const attestationObject = bytesOf(
      outcome.attestationObject,
      MAX_ATTESTATION_BYTES,
    );
    const clientDataJSON = bytesOf(
      outcome.clientDataJSON,
      MAX_CLIENT_DATA_BYTES,
    );
    if (
      challenge === null ||
      attestationObject === null ||
      clientDataJSON === null
    )
      return this.invalid();
    let enrolled;
    try {
      enrolled = await verifyEnrollment({
        attestationObject,
        clientDataJSON,
        challenge,
        rpId: PASSKEY_RP_ID,
        origin: PASSKEY_ORIGIN,
      });
    } catch (error) {
      if (error instanceof PasskeyEnrollmentError) return this.invalid();
      throw error;
    }
    const point = Buffer.from(enrolled.point).toString('base64url');
    const info = await this.deps.keyInfo(point);
    if (info === null || info.publicKey !== point) return this.invalid();
    const record: PasskeyRecord = {
      credentialId: Buffer.from(enrolled.credentialId).toString('base64url'),
      publicKey: point,
      kid: info.kid,
      rpId: PASSKEY_RP_ID,
      origin: PASSKEY_ORIGIN,
    };
    try {
      this.deps.store(record);
    } catch {
      this.notice = 'not_writable';
      return this.view();
    }
    this.notice = null;
    this.done = {
      kid: info.kid,
      fingerprint: info.fingerprint,
      publicKey: point,
      rpId: record.rpId,
      origin: record.origin,
      trustCommand: gatePinCommand(record, 'trust'),
      installCommand: gatePinCommand(record, 'install'),
    };
    return this.view();
  }

  private invalid(): PasskeyEnrollView {
    this.notice = 'invalid';
    return this.view();
  }

  /** The stored passkey's public data once the ceremony succeeded. */
  get stored(): PasskeyEnrollDone | null {
    return this.done;
  }

  /** The last answer was "no passkey on this system" — the page says so plainly. */
  get unavailable(): boolean {
    return this.notice === 'unavailable';
  }
}
