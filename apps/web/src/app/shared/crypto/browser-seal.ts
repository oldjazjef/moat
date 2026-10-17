/**
 * Seals a secret in the browser (SEC-31, SEC-33): the value is turned into bytes, sealed to the
 * gate's box key with the gate id, the name and the version as bound context, and the bytes are
 * zeroed. The sealing is `@moat/core`'s own `sealSecret` — the one implementation the CLI and
 * Moat Desktop use — loaded only when a person seals something (libsodium is large).
 *
 * This protects the secret from everything but a Moat Cloud whose delivered code is hostile
 * (SEC-37, SEC-58, T-30): that attacker could ship a page that reads the value before sealing it.
 * For full protection use `moat secret seal` or Moat Desktop; the page says so.
 */
export interface SealTarget {
  readonly gateId: string;
  /** The gate's public box key (base64url, 32 bytes). */
  readonly boxKey: string;
}

export interface SealedJson {
  readonly v: number;
  readonly alg: string;
  readonly secretVersion: number;
  readonly epk: string;
  readonly nonce: string;
  readonly ct: string;
}

export async function sealInBrowser(
  value: string,
  target: SealTarget,
  secretName: string,
  secretVersion: number,
): Promise<SealedJson> {
  const { sealSecret, fromBase64UrlLength } = await import('@moat/core');
  const bytes = new TextEncoder().encode(value);
  try {
    return await sealSecret(bytes, fromBase64UrlLength(target.boxKey, 32), {
      gateId: target.gateId,
      secretName,
      secretVersion,
    });
  } finally {
    bytes.fill(0);
  }
}
