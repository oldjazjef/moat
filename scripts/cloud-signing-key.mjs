// Makes a signing key for Moat Cloud's managed gates (MOAT_SIGNING_KEY) and shows the public half,
// or shows the public half of a seed you already have.
//   node scripts/cloud-signing-key.mjs              a new seed, its public key and fingerprint
//   node scripts/cloud-signing-key.mjs <seed>       the public key and fingerprint of that seed
// The seed is a secret: put it in a Docker/Kubernetes secret, never in a repository or a ticket.
// Needs `pnpm install` once (libsodium, the library the server uses).
import sodium from 'libsodium-wrappers-sumo';

await sodium.ready;
const given = process.argv[2];
const seed = given
  ? sodium.from_base64(given, sodium.base64_variants.URLSAFE_NO_PADDING)
  : sodium.randombytes_buf(32);
if (seed.length !== 32) {
  console.error('the seed must be 32 bytes as base64url without padding');
  process.exit(1);
}
const pair = sodium.crypto_sign_seed_keypair(seed);
const b64 = (bytes) =>
  sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const id = sodium.crypto_generichash(
  16,
  Buffer.concat([Buffer.from('moat:kid:v1|ed25519|'), pair.publicKey]),
  null,
);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let out = '';
let buffer = 0;
let bits = 0;
for (const byte of id) {
  buffer = (buffer << 8) | byte;
  bits += 8;
  while (bits >= 5) {
    bits -= 5;
    out += alphabet[(buffer >> bits) & 31];
  }
  buffer &= (1 << bits) - 1;
}
if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
if (!given) console.log(`seed (secret, MOAT_SIGNING_KEY): ${b64(seed)}`);
console.log(`public key:  ${b64(pair.publicKey)}`);
console.log(`fingerprint: ${['MOAT', ...out.match(/.{1,4}/g)].join('-')}`);
