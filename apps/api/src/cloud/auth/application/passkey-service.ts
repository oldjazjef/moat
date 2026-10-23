import { randomBytes, createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  PasskeyAssertionError,
  PasskeyEnrollmentError,
  toBase64Url,
  verifyAssertion,
  verifyEnrollment,
} from '@moat/core';
import { Clock, iso } from '../../common/clock';
import {
  bytesOfBase64Url,
  CHALLENGE_BYTES,
  CHALLENGE_TTL_MS,
  challengeOfClientData,
  type RelyingParty,
} from '../domain/passkey';
import {
  type ChallengePurpose,
  PasskeyRepositoryPort,
} from '../ports/auth.ports';
import type { PasskeyAssertionInput } from './auth.commands';

/** The relying party of this installation (see `relyingPartyOf`), as a DI token. */
export class PasskeyRp {
  constructor(readonly value: RelyingParty) {}
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * The server side of WebAuthn for account passkeys (SEC-51, T-101 to T-103): one-time challenges
 * and the checks of a registration and of a sign-in. The ceremony checks themselves are Moat
 * Core's (`verifyEnrollment`, `verifyAssertion`); this adds what only the server knows — whose
 * challenge it was, whether it was used, and the stored key and counter.
 */
@Injectable()
export class PasskeyService {
  constructor(
    private readonly passkeys: PasskeyRepositoryPort,
    private readonly relyingParty: PasskeyRp,
    private readonly clock: Clock,
  ) {}

  get rp(): RelyingParty {
    return this.relyingParty.value;
  }

  get available(): boolean {
    return this.rp.available;
  }

  /** A fresh challenge for the account, stored by its hash. */
  async issueChallenge(
    accountId: string,
    purpose: ChallengePurpose,
  ): Promise<string> {
    const challenge = new Uint8Array(randomBytes(CHALLENGE_BYTES));
    const now = this.clock.now();
    await this.passkeys.issueChallenge({
      id: sha256Hex(challenge),
      accountId,
      purpose,
      createdAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + CHALLENGE_TTL_MS)),
    });
    return toBase64Url(challenge);
  }

  /** The challenge the client's `clientDataJSON` carries, used up if it is ours (single use). */
  private async takeChallenge(
    accountId: string,
    purpose: ChallengePurpose,
    clientData: Uint8Array,
  ): Promise<Uint8Array | null> {
    const challenge = challengeOfClientData(clientData);
    if (challenge === null) return null;
    const used = await this.passkeys.consumeChallenge(
      sha256Hex(challenge),
      accountId,
      purpose,
      iso(this.clock.now()),
    );
    return used ? challenge : null;
  }

  /**
   * True when the assertion is a valid sign-in of one of this account's passkeys for a challenge
   * this server made for it, and the counter did not go backwards. The challenge is used up first:
   * a failed attempt cannot be tried again with the same assertion.
   */
  async verifyLogin(
    accountId: string,
    input: PasskeyAssertionInput,
  ): Promise<boolean> {
    if (!this.available) return false;
    const credentialId = bytesOfBase64Url(input.credentialId, 16, 1023);
    const authenticatorData = bytesOfBase64Url(
      input.authenticatorData,
      37,
      1024,
    );
    const clientDataJSON = bytesOfBase64Url(input.clientDataJSON, 1, 2048);
    const signature = bytesOfBase64Url(input.signature, 8, 80);
    const point =
      credentialId === null
        ? null
        : await this.passkeys.findByCredential(toBase64Url(credentialId));
    if (
      credentialId === null ||
      authenticatorData === null ||
      clientDataJSON === null ||
      signature === null
    )
      return false;
    const challenge = await this.takeChallenge(
      accountId,
      'login',
      clientDataJSON,
    );
    if (challenge === null || point === null || point.accountId !== accountId)
      return false;
    const key = bytesOfBase64Url(point.publicKey, 65, 65);
    if (key === null) return false;
    try {
      const verified = await verifyAssertion({
        point: key,
        challenge,
        rpId: this.rp.rpId,
        origin: this.rp.origin,
        authenticatorData,
        clientDataJSON,
        signature,
      });
      return await this.passkeys.recordUse(
        point.id,
        verified.signCount,
        iso(this.clock.now()),
      );
    } catch (error) {
      if (error instanceof PasskeyAssertionError) return false;
      throw error;
    }
  }

  /**
   * The credential a registration ceremony made, once its challenge is ours and unused and the
   * attestation checks out for this relying party. `challenge_invalid`: not ours, used or expired.
   */
  async verifyRegistration(
    accountId: string,
    attestationObjectText: string,
    clientDataText: string,
  ): Promise<
    | { readonly credentialId: string; readonly publicKey: string }
    | 'challenge_invalid'
    | 'passkey_invalid'
  > {
    const attestationObject = bytesOfBase64Url(
      attestationObjectText,
      1,
      16 * 1024,
    );
    const clientDataJSON = bytesOfBase64Url(clientDataText, 1, 2048);
    if (attestationObject === null || clientDataJSON === null)
      return 'passkey_invalid';
    const challenge = await this.takeChallenge(
      accountId,
      'register',
      clientDataJSON,
    );
    if (challenge === null) return 'challenge_invalid';
    try {
      const made = await verifyEnrollment({
        attestationObject,
        clientDataJSON,
        challenge,
        rpId: this.rp.rpId,
        origin: this.rp.origin,
      });
      return {
        credentialId: toBase64Url(made.credentialId),
        publicKey: toBase64Url(made.point),
      };
    } catch (error) {
      if (error instanceof PasskeyEnrollmentError) return 'passkey_invalid';
      throw error;
    }
  }
}
