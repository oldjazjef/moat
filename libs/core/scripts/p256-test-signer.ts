/**
 * TEST ONLY. A deterministic ECDSA P-256 signer (RFC 6979, HMAC-SHA-256) for the conformance
 * vectors: Web Crypto signs with a random nonce, and `pnpm vectors` must produce the same bytes
 * every time. It runs only inside scripts and specs, never in a shipped build, and every key it
 * is used with is derived from a public label. Verification of what it signs is done by the real
 * implementations (Web Crypto in core, OpenSSL in the PHP gate).
 */
import { concatBytes } from '../src/encoding/utf8';
import type { Sodium } from '../src/crypto/sodium';

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const G: Point = {
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

type Point = { x: bigint; y: bigint } | null;

export const P256_ORDER = N;

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function invert(value: bigint, modulus: bigint): bigint {
  let [low, high] = [mod(value, modulus), modulus];
  let [lowFactor, highFactor] = [1n, 0n];
  while (low > 1n) {
    const quotient = high / low;
    [low, high] = [high - quotient * low, low];
    [lowFactor, highFactor] = [highFactor - quotient * lowFactor, lowFactor];
  }
  return mod(lowFactor, modulus);
}

function add(first: Point, second: Point): Point {
  if (first === null) return second;
  if (second === null) return first;
  let slope: bigint;
  if (first.x === second.x) {
    if (mod(first.y + second.y, P) === 0n) return null;
    slope = mod((3n * first.x * first.x + A) * invert(2n * first.y, P), P);
  } else {
    slope = mod((second.y - first.y) * invert(second.x - first.x, P), P);
  }
  const x = mod(slope * slope - first.x - second.x, P);
  return { x, y: mod(slope * (first.x - x) - first.y, P) };
}

function multiply(scalar: bigint, point: Point): Point {
  let result: Point = null;
  let addend = point;
  for (let rest = scalar; rest > 0n; rest >>= 1n) {
    if ((rest & 1n) === 1n) result = add(result, addend);
    addend = add(addend, addend);
  }
  return result;
}

export function toBigInt(bytes: Uint8Array): bigint {
  return bytes.reduce((sum, byte) => (sum << 8n) | BigInt(byte), 0n);
}

export function toBytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let index = 31, rest = value; index >= 0; index--, rest >>= 8n) {
    out[index] = Number(rest & 0xffn);
  }
  return out;
}

/** A private scalar in 1 … n − 1 from 32 arbitrary bytes. */
export function scalarFrom(seed: Uint8Array): bigint {
  return (toBigInt(seed) % (N - 1n)) + 1n;
}

/** The uncompressed public point 0x04 ‖ X ‖ Y (65 bytes). */
export function publicPoint(privateScalar: bigint): Uint8Array {
  const point = multiply(privateScalar, G);
  if (point === null) throw new Error('scalar out of range');
  return concatBytes(
    new Uint8Array([4]),
    toBytes32(point.x),
    toBytes32(point.y),
  );
}

/** RFC 6979 ECDSA over SHA-256(message): returns r ‖ s (64 bytes), low or high S as it comes. */
export function signDeterministic(
  na: Sodium,
  privateScalar: bigint,
  message: Uint8Array,
): Uint8Array {
  const hmac = (key: Uint8Array, data: Uint8Array): Uint8Array =>
    na.crypto_auth_hmacsha256(data, key);
  const x = toBytes32(privateScalar);
  const digest = na.crypto_hash_sha256(message);
  const z = toBigInt(digest);
  const h1 = toBytes32(mod(z, N));
  let v: Uint8Array = new Uint8Array(32).fill(1);
  let k: Uint8Array = new Uint8Array(32);
  k = hmac(k, concatBytes(v, new Uint8Array([0]), x, h1));
  v = hmac(k, v);
  k = hmac(k, concatBytes(v, new Uint8Array([1]), x, h1));
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const nonce = toBigInt(v);
    if (nonce >= 1n && nonce < N) {
      const point = multiply(nonce, G);
      const r = point === null ? 0n : mod(point.x, N);
      const s = mod(invert(nonce, N) * (z + r * privateScalar), N);
      if (r !== 0n && s !== 0n) return concatBytes(toBytes32(r), toBytes32(s));
    }
    k = hmac(k, concatBytes(v, new Uint8Array([0])));
    v = hmac(k, v);
  }
}
