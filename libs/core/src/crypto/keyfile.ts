import {
  fromBase64Url,
  fromBase64UrlLength,
  toBase64Url,
} from '../encoding/base64url';
import { utf8 } from '../encoding/utf8';
import { reject } from '../errors';
import { hasExactKeys, isJsonObject } from '../json/strict-json';
import { keyId } from './kid';
import { sodium } from './sodium';
import type { Ed25519Signer } from '../bundle/bundle';

/**
 * Key files for trust mode 1 (docs/CRYPTO.md §6): the Ed25519 seed, encrypted with a key derived
 * from a passphrase by Argon2id. Desktop and CLI write them; the Cloud never sees one (SEC-02).
 */
export interface KeyFile {
  readonly moat: 'keyfile';
  readonly v: 1;
  readonly alg: 'ed25519';
  readonly kid: string;
  readonly pk: string;
  readonly kdf: {
    readonly alg: 'argon2id13';
    readonly ops: number;
    readonly mem: number;
    readonly salt: string;
  };
  readonly nonce: string;
  readonly ct: string;
}

/** Floors when writing (Desktop, CLI) and when opening (protects against a file with trivial cost). */
export const KEYFILE_WRITE_MIN = { ops: 3, mem: 256 * 1024 * 1024 } as const;
export const KEYFILE_OPEN_MIN = { ops: 2, mem: 64 * 1024 * 1024 } as const;
const KEYFILE_OPEN_MAX = { ops: 10, mem: 1024 * 1024 * 1024 } as const;

function associatedData(kid: string): Uint8Array {
  return utf8(`moat:keyfile:v1|${kid}`);
}

export interface KeyFileOptions {
  readonly ops?: number;
  readonly mem?: number;
  /** Only for the conformance vectors: fixed seed, salt and nonce. */
  readonly fixed?: {
    readonly seed: Uint8Array;
    readonly salt: Uint8Array;
    readonly nonce: Uint8Array;
  };
}

/** Creates a new signing key and returns its key file. The passphrase is never stored. */
export async function createKeyFile(
  passphrase: string,
  options: KeyFileOptions = {},
): Promise<KeyFile> {
  const na = await sodium();
  const ops = options.ops ?? KEYFILE_WRITE_MIN.ops;
  const mem = options.mem ?? KEYFILE_WRITE_MIN.mem;
  if (
    options.fixed === undefined &&
    (ops < KEYFILE_WRITE_MIN.ops || mem < KEYFILE_WRITE_MIN.mem)
  ) {
    throw new RangeError('key file KDF below the write floor');
  }
  const seed =
    options.fixed?.seed ?? na.randombytes_buf(na.crypto_sign_SEEDBYTES);
  const salt =
    options.fixed?.salt ?? na.randombytes_buf(na.crypto_pwhash_SALTBYTES);
  const nonce =
    options.fixed?.nonce ??
    na.randombytes_buf(na.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const pair = na.crypto_sign_seed_keypair(seed);
  const kid = await keyId('ed25519', pair.publicKey);
  const kek = na.crypto_pwhash(
    32,
    utf8(passphrase),
    salt,
    ops,
    mem,
    na.crypto_pwhash_ALG_ARGON2ID13,
  );
  const ct = na.crypto_aead_xchacha20poly1305_ietf_encrypt(
    seed,
    associatedData(kid),
    null,
    nonce,
    kek,
  );
  na.memzero(kek);
  if (options.fixed === undefined) na.memzero(seed);
  na.memzero(pair.privateKey);
  return {
    moat: 'keyfile',
    v: 1,
    alg: 'ed25519',
    kid,
    pk: toBase64Url(pair.publicKey),
    kdf: { alg: 'argon2id13', ops, mem, salt: toBase64Url(salt) },
    nonce: toBase64Url(nonce),
    ct: toBase64Url(ct),
  };
}

/**
 * Opens a key file. `keyfile_invalid`: malformed, KDF parameters below the open floor (or absurdly
 * high), or the seed does not give `pk`/`kid`. `keyfile_locked`: wrong passphrase (or a tampered
 * ciphertext — the two cannot be told apart).
 */
export async function openKeyFile(
  file: unknown,
  passphrase: string,
): Promise<Ed25519Signer & { kid: string }> {
  const na = await sodium();
  if (
    !isJsonObject(file) ||
    !hasExactKeys(file, [
      'moat',
      'v',
      'alg',
      'kid',
      'pk',
      'kdf',
      'nonce',
      'ct',
    ]) ||
    file['moat'] !== 'keyfile' ||
    file['v'] !== 1 ||
    file['alg'] !== 'ed25519' ||
    typeof file['kid'] !== 'string' ||
    typeof file['ct'] !== 'string'
  ) {
    reject('keyfile_invalid');
  }
  const kdf = file['kdf'];
  if (
    !isJsonObject(kdf) ||
    !hasExactKeys(kdf, ['alg', 'ops', 'mem', 'salt']) ||
    kdf['alg'] !== 'argon2id13' ||
    typeof kdf['ops'] !== 'number' ||
    typeof kdf['mem'] !== 'number' ||
    kdf['ops'] < KEYFILE_OPEN_MIN.ops ||
    kdf['mem'] < KEYFILE_OPEN_MIN.mem ||
    kdf['ops'] > KEYFILE_OPEN_MAX.ops ||
    kdf['mem'] > KEYFILE_OPEN_MAX.mem
  ) {
    reject('keyfile_invalid');
  }
  let publicKey: Uint8Array;
  let salt: Uint8Array;
  let nonce: Uint8Array;
  let ct: Uint8Array;
  try {
    publicKey = fromBase64UrlLength(file['pk'], na.crypto_sign_PUBLICKEYBYTES);
    salt = fromBase64UrlLength(kdf['salt'], na.crypto_pwhash_SALTBYTES);
    nonce = fromBase64UrlLength(
      file['nonce'],
      na.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    );
    ct = fromBase64Url(file['ct']);
  } catch {
    reject('keyfile_invalid');
  }
  if ((await keyId('ed25519', publicKey)) !== file['kid'])
    reject('keyfile_invalid');

  const kek = na.crypto_pwhash(
    32,
    utf8(passphrase),
    salt,
    kdf['ops'],
    kdf['mem'],
    na.crypto_pwhash_ALG_ARGON2ID13,
  );
  let seed: Uint8Array;
  try {
    seed = na.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ct,
      associatedData(file['kid']),
      nonce,
      kek,
    );
  } catch {
    reject('keyfile_locked');
  } finally {
    na.memzero(kek);
  }
  if (seed.length !== na.crypto_sign_SEEDBYTES) reject('keyfile_invalid');
  const pair = na.crypto_sign_seed_keypair(seed);
  na.memzero(seed);
  if (!na.memcmp(pair.publicKey, publicKey)) {
    na.memzero(pair.privateKey);
    reject('keyfile_invalid');
  }
  return {
    alg: 'ed25519',
    secretKey: pair.privateKey,
    publicKey,
    kid: file['kid'],
  };
}
