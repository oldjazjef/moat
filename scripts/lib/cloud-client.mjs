// A small HTTP client for Moat Cloud's own API, for the scripts that exercise a running server
// (smoke-cloud-flow.mjs, smoke-gate-interop.mjs). Cookies and the CSRF token are kept like a
// browser keeps them; nothing here is used by the product itself.
import { randomBytes } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';

export function createClient(base, origin) {
  const jar = new Map();
  let csrf = '';
  async function call(method, path, body, headers = {}) {
    const all = { origin, ...headers };
    if (jar.size > 0)
      all.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (csrf !== '' && method !== 'GET') all['x-moat-csrf'] = csrf;
    if (body !== undefined) all['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers: all,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text,
      json: () => JSON.parse(text),
    };
  }
  return {
    call,
    /** Registers and signs in a fresh account. */
    async signUp() {
      const email = `smoke-${randomBytes(4).toString('hex')}@example.test`;
      const password = randomBytes(18).toString('base64url');
      const registered = await call('POST', '/api/auth/register', {
        email,
        password,
      });
      if (registered.status !== 202)
        throw new Error(`register (${registered.status})`);
      const login = await call('POST', '/api/auth/login', { email, password });
      if (login.status !== 200) throw new Error(`sign in (${login.status})`);
      csrf = login.json().csrfToken;
    },
  };
}

export function must(condition, message) {
  if (!condition) {
    console.error(`smoke: ${message}`);
    process.exit(1);
  }
}
export const step = (name) => console.log(`ok   ${name}`);

/** docs/CRYPTO.md §3: BLAKE2b-128 over "moat:kid:v1|x25519|" ‖ key, base32 in groups of four. */
export async function boxFingerprint(publicKey) {
  await sodium.ready;
  const id = sodium.crypto_generichash(
    16,
    Buffer.concat([Buffer.from('moat:kid:v1|x25519|'), publicKey]),
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
  return ['MOAT', ...out.match(/.{1,4}/g)].join('-');
}
