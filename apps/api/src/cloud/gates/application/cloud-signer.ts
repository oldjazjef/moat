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

export interface PublicKeyInfo {
  readonly kid: string;
  /** Ed25519 public key, base64url: what a gate pins (`php moat-gate.php trust`). */
  readonly publicKey: string;
  /** `MOAT-…`: what the person compares with the gate's own display. */
  readonly fingerprint: string;
}

/**
 * The key Moat Cloud signs with, and the two it names during a rotation: `next` (announced, not
 * signing yet: pin it at every gate first) and `previous` (retired: gates may drop it once all
 * their bundles are new).
 */
export interface SignerInfo extends PublicKeyInfo {
  readonly next: PublicKeyInfo | null;
  readonly previous: PublicKeyInfo | null;
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
      readonly previousPublicKey: Uint8Array | null;
    } | null,
  ) {}

  /**
   * `nextPublic` / `previousPublic`: public keys (base64url) of a rotation in progress. They only
   * change what is shown and which earlier bundles count for a comparison — never what signs.
   * Anything malformed, equal to another key, or given without a signing key refuses to start,
   * naming the variable only.
   */
  static async create(
    seedText: string | undefined,
    rotation: { nextPublic?: string; previousPublic?: string } = {},
  ): Promise<CloudSigner> {
    const given = (value: string | undefined) =>
      value !== undefined && value !== '' ? value : undefined;
    const nextText = given(rotation.nextPublic);
    const previousText = given(rotation.previousPublic);
    if (seedText === undefined || seedText === '') {
      if (nextText !== undefined)
        throw new Error(
          'Invalid signing key environment: MOAT_SIGNING_KEY_NEXT_PUBLIC',
        );
      if (previousText !== undefined)
        throw new Error(
          'Invalid signing key environment: MOAT_SIGNING_KEY_PREVIOUS_PUBLIC',
        );
      return new CloudSigner(null, null);
    }
    const seed = fromBase64UrlLength(seedText, 32);
    await sodiumLibrary.ready;
    const pair = sodiumLibrary.crypto_sign_seed_keypair(seed);
    const describe = async (publicKey: Uint8Array): Promise<PublicKeyInfo> => ({
      kid: await keyId('ed25519', publicKey),
      publicKey: toBase64Url(publicKey),
      fingerprint: await fingerprint('ed25519', publicKey),
    });
    const parse = (
      text: string | undefined,
      name: string,
    ): Uint8Array | null => {
      if (text === undefined) return null;
      try {
        return fromBase64UrlLength(text, 32);
      } catch {
        throw new Error(`Invalid signing key environment: ${name}`);
      }
    };
    const next = parse(nextText, 'MOAT_SIGNING_KEY_NEXT_PUBLIC');
    const previous = parse(previousText, 'MOAT_SIGNING_KEY_PREVIOUS_PUBLIC');
    const same = (a: Uint8Array | null, b: Uint8Array | null) =>
      a !== null && b !== null && toBase64Url(a) === toBase64Url(b);
    if (same(next, pair.publicKey))
      throw new Error(
        'Invalid signing key environment: MOAT_SIGNING_KEY_NEXT_PUBLIC',
      );
    if (same(previous, pair.publicKey) || same(previous, next))
      throw new Error(
        'Invalid signing key environment: MOAT_SIGNING_KEY_PREVIOUS_PUBLIC',
      );
    const info: SignerInfo = {
      ...(await describe(pair.publicKey)),
      next: next === null ? null : await describe(next),
      previous: previous === null ? null : await describe(previous),
    };
    const publicKey = pair.publicKey;
    pair.privateKey.fill(0);
    return new CloudSigner(seed, {
      info,
      publicKey,
      previousPublicKey: previous,
    });
  }

  static fromConfig(config: ConfigService<Env, true>): Promise<CloudSigner> {
    return CloudSigner.create(config.get('MOAT_SIGNING_KEY', { infer: true }), {
      nextPublic: config.get('MOAT_SIGNING_KEY_NEXT_PUBLIC', { infer: true }),
      previousPublic: config.get('MOAT_SIGNING_KEY_PREVIOUS_PUBLIC', {
        infer: true,
      }),
    });
  }

  get available(): boolean {
    return this.seed !== null;
  }

  info(): SignerInfo | null {
    return this.cached?.info ?? null;
  }

  /**
   * The keys whose earlier bundles count when the next one is compared with the last (the current
   * key first, then the retired one): after a rotation the last bundle was signed by the old key.
   */
  planSigners(): PlanSigner[] {
    if (this.cached === null) return [];
    const { info, previousPublicKey } = this.cached;
    const signers: PlanSigner[] = [this.planSigner() as PlanSigner];
    if (previousPublicKey !== null && info.previous !== null)
      signers.push({ kid: info.previous.kid, publicKey: previousPublicKey });
    return signers;
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
