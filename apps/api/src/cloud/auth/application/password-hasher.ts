import { randomBytes } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import { normalisePassword } from '../domain/credentials';

export type PasswordCost = 'standard' | 'fast';

/**
 * Passwords with Argon2id through libsodium's `crypto_pwhash_str` (CLAUDE.md, Crypto: libsodium
 * only). The stored string carries its own salt and parameters; `verify` compares in constant
 * time inside libsodium. `standard` is libsodium's INTERACTIVE profile (64 MiB, 2 passes, above
 * OWASP's minimum); `fast` exists for tests and is refused in production (config/env.ts).
 *
 * Hashing is synchronous WebAssembly and blocks the event loop for roughly 0.2 s; moving it to a
 * worker thread is future work (see the slice notes).
 */
export class PasswordHasher {
  private dummy: string | null = null;

  constructor(private readonly cost: PasswordCost = 'standard') {}

  async hash(password: string): Promise<string> {
    await sodium.ready;
    return sodium.crypto_pwhash_str(
      normalisePassword(password),
      this.opsLimit(sodium),
      this.memLimit(sodium),
    );
  }

  async verify(hash: string, password: string): Promise<boolean> {
    await sodium.ready;
    try {
      return sodium.crypto_pwhash_str_verify(hash, normalisePassword(password));
    } catch {
      // A malformed hash is a failed check, never an exception.
      return false;
    }
  }

  /**
   * The same work as a real check, against a hash nobody knows the password of: an unknown
   * address costs as much time as a known one (T-79).
   */
  async verifyUnknown(password: string): Promise<void> {
    this.dummy ??= await this.hash(randomBytes(16).toString('hex'));
    await this.verify(this.dummy, password);
  }

  async needsRehash(hash: string): Promise<boolean> {
    await sodium.ready;
    try {
      return sodium.crypto_pwhash_str_needs_rehash(
        hash,
        this.opsLimit(sodium),
        this.memLimit(sodium),
      );
    } catch {
      return true;
    }
  }

  private opsLimit(s: typeof sodium): number {
    return this.cost === 'fast' ? 1 : s.crypto_pwhash_OPSLIMIT_INTERACTIVE;
  }

  private memLimit(s: typeof sodium): number {
    return this.cost === 'fast' ? 8192 : s.crypto_pwhash_MEMLIMIT_INTERACTIVE;
  }
}
