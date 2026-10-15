import sodium from 'libsodium-wrappers-sumo';

/**
 * Seals a TOTP secret for the database: XChaCha20-Poly1305 under the server's `MOAT_ACCOUNT_KEY`,
 * the account id as associated data (a sealed secret copied to another account's row does not
 * open). The server must be able to read the secret to verify a code, so unlike a customer's gate
 * secret (SEC-31) this one is encrypted to the *server*; the key lives outside the database and
 * its backups. Output: base64url(nonce ‖ ciphertext).
 */
export class TotpVault {
  private readonly key: Uint8Array;

  private constructor(key: Uint8Array) {
    this.key = key;
  }

  /** `key`: 32 bytes as base64url (the MOAT_ACCOUNT_KEY value). */
  static async create(key: string): Promise<TotpVault> {
    await sodium.ready;
    const bytes = sodium.from_base64(
      key,
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
    if (bytes.length !== 32) throw new Error('account key length');
    return new TotpVault(bytes);
  }

  async seal(secret: Uint8Array, accountId: string): Promise<string> {
    await sodium.ready;
    const nonce = sodium.randombytes_buf(
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    );
    const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      secret,
      accountId,
      null,
      nonce,
      this.key,
    );
    const out = new Uint8Array(nonce.length + sealed.length);
    out.set(nonce, 0);
    out.set(sealed, nonce.length);
    return sodium.to_base64(out, sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  /** The secret, or null when the text does not open (wrong key, wrong account, tampered). */
  async open(sealed: string, accountId: string): Promise<Uint8Array | null> {
    await sodium.ready;
    try {
      const bytes = sodium.from_base64(
        sealed,
        sodium.base64_variants.URLSAFE_NO_PADDING,
      );
      const nonceLength = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
      if (bytes.length <= nonceLength) return null;
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        bytes.subarray(nonceLength),
        accountId,
        bytes.subarray(0, nonceLength),
        this.key,
      );
    } catch {
      return null;
    }
  }

  /** Zeroes the key (shutdown). */
  destroy(): void {
    this.key.fill(0);
  }
}
