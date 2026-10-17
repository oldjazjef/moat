import { Injectable } from '@nestjs/common';
import {
  type Ed25519Signer,
  fingerprint,
  fromBase64UrlLength,
  keyId,
  toBase64Url,
  type PlanSigner,
} from '@moat/core';
import { ConfigService } from '@nestjs/config';
import sodiumLibrary from 'libsodium-wrappers-sumo';
import type { Env } from '../../../config/env';

export interface SignerInfo {
  readonly kid: string;
  /** Ed25519 public key, base64url: what a gate pins (`php moat-gate.php trust`). */
  readonly publicKey: string;
  /** `MOAT-…`: what the person compares with the gate's own display. */
  readonly fingerprint: string;
}

/**
 * The installation's signing key for trust mode 0 (ANFORDERUNGEN.md §2.1): `MOAT_SIGNING_KEY`, a
 * 32-byte Ed25519 seed. The Cloud signs managed gates' bundles with it and nothing else — never a
 * gate whose customer pinned its own key (SEC-02). Without the variable no gate can be managed.
 * The seed is kept as bytes and zeroed after each signing; the derived secret key is built per
 * signature.
 */
@Injectable()
export class CloudSigner {
  private constructor(
    private readonly seed: Uint8Array | null,
    private readonly cached: {
      readonly info: SignerInfo;
      readonly publicKey: Uint8Array;
    } | null,
  ) {}

  static async create(seedText: string | undefined): Promise<CloudSigner> {
    if (seedText === undefined || seedText === '')
      return new CloudSigner(null, null);
    const seed = fromBase64UrlLength(seedText, 32);
    await sodiumLibrary.ready;
    const pair = sodiumLibrary.crypto_sign_seed_keypair(seed);
    const info: SignerInfo = {
      kid: await keyId('ed25519', pair.publicKey),
      publicKey: toBase64Url(pair.publicKey),
      fingerprint: await fingerprint('ed25519', pair.publicKey),
    };
    pair.privateKey.fill(0);
    return new CloudSigner(seed, { info, publicKey: pair.publicKey });
  }

  static fromConfig(config: ConfigService<Env, true>): Promise<CloudSigner> {
    return CloudSigner.create(config.get('MOAT_SIGNING_KEY', { infer: true }));
  }

  get available(): boolean {
    return this.seed !== null;
  }

  info(): SignerInfo | null {
    return this.cached?.info ?? null;
  }

  /** What the bundle plan compares against: the public half only. */
  planSigner(): PlanSigner | null {
    return this.cached === null
      ? null
      : { kid: this.cached.info.kid, publicKey: this.cached.publicKey };
  }

  /**
   * Runs `use` with the signing key and zeroes it afterwards. Null when there is no key.
   */
  async withSigner<T>(
    use: (signer: Ed25519Signer) => Promise<T>,
  ): Promise<T | null> {
    if (this.seed === null || this.cached === null) return null;
    await sodiumLibrary.ready;
    const pair = sodiumLibrary.crypto_sign_seed_keypair(this.seed);
    try {
      return await use({
        alg: 'ed25519',
        secretKey: pair.privateKey,
        publicKey: pair.publicKey,
      });
    } finally {
      pair.privateKey.fill(0);
    }
  }
}
