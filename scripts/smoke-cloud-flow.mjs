// A real flow against a running Moat Cloud, over HTTP only: register, sign in, organisation,
// project, configuration, a managed gate (enrolled with the fingerprint a gate would print, worked
// out independently of the server), release, and the gate's pull. CI runs it against the built
// image; a person can run it against any installation that has a signing key.
//
//   node scripts/smoke-cloud-flow.mjs http://127.0.0.1:3000 https://the-public-origin
//
// The second argument is MOAT_PUBLIC_ORIGIN of the server (the Origin the API insists on).
// Needs `pnpm install` once (libsodium, the library the server uses for key ids).
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  boxFingerprint,
  createClient,
  must,
  step,
} from './lib/cloud-client.mjs';

const base = process.argv[2];
const origin = process.argv[3] ?? base;
if (!base) {
  console.error('usage: smoke-cloud-flow.mjs <base url> [public origin]');
  process.exit(2);
}
const { call, signUp } = createClient(base, origin);

await signUp();
step('register and sign in');

const org = (await call('POST', '/api/orgs', { name: 'Smoke' })).json()
  .organisation.id;
const project = (
  await call('POST', `/api/orgs/${org}/projects`, { name: 'Site' })
).json().project.id;
const root = `/api/orgs/${org}/projects/${project}`;
step('organisation and project');

const listed = (await call('GET', `${root}/gates`)).json();
must(
  listed.signer !== null,
  'this server has no signing key (MOAT_SIGNING_KEY)',
);
step(`signing key present (${listed.signer.fingerprint})`);

const saved = await call('PUT', `${root}/config`, {
  text: 'version: 1\n\nenvironments:\n  production:\n    enabled: true\n\nupstreams: {}\n\nroutes: {}\n',
});
must(saved.status === 200, `save config (${saved.status})`);
let hash = saved.json().hash;
for (const edit of [
  {
    op: 'addUpstream',
    upstream: 'example',
    upstreamDefinition: { origin: 'https://api.example.com', timeout: '10s' },
  },
  {
    op: 'addRoute',
    route: 'hello',
    definition: {
      method: 'POST',
      path: '/hello',
      upstream: 'example',
      upstreamPath: '/v1/hello',
    },
  },
]) {
  const answer = await call('POST', `${root}/config/edits`, {
    base: hash,
    ...edit,
  });
  must(answer.status === 200, `${edit.op} (${answer.status} ${answer.text})`);
  hash = answer.json().hash;
}
step('configuration written and edited');

// The gate's box key as `php moat-gate.php install` would print it.
const { publicKey } = generateKeyPairSync('x25519');
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const gate = {
  name: 'site',
  gateId: randomBytes(16).toString('base64url'),
  boxKey: raw.toString('base64url'),
};
const fingerprint = await boxFingerprint(raw);
const wrong = await call('POST', `${root}/gates`, {
  ...gate,
  fingerprint: 'MOAT-WRONG',
});
must(
  wrong.status === 422 && wrong.json().error === 'fingerprint_mismatch',
  'a wrong fingerprint was not refused',
);
const added = await call('POST', `${root}/gates`, { ...gate, fingerprint });
must(added.status === 201, `enrol the gate (${added.status} ${added.text})`);
must(
  added.json().gate.boxKeyFingerprint === fingerprint,
  'the server shows another fingerprint',
);
step('gate enrolled with the fingerprint worked out independently');

const preview = (await call('GET', `${root}/gates/site/release`)).json()
  .preview;
must(
  preview.version === 1 &&
    preview.changes.some((c) => c.kind === 'route' && c.name === 'hello'),
  'preview',
);
const stale = await call('POST', `${root}/gates/site/releases`, {
  digest: '0'.repeat(64),
});
must(stale.status === 409, 'a wrong digest was signed');
const released = await call('POST', `${root}/gates/site/releases`, {
  digest: preview.digest,
});
must(
  released.status === 201 && released.json().version === 1,
  `release (${released.status} ${released.text})`,
);
step('released: preview, digest check, signature');

const address = (await call('POST', `${root}/gates/site/pull-address`)).json()
  .url;
const pullPath = new URL(address).pathname;
// The gate pulls without a session: a fresh request with no cookie and no Origin.
const pulled = await fetch(base + pullPath);
must(pulled.status === 200, `pull (${pulled.status})`);
const text = await pulled.text();
const envelope = JSON.parse(text);
must(
  envelope.moat === 'bundle' && envelope.sigs.length === 1,
  'the pulled file is no signed bundle',
);
const payload = JSON.parse(
  Buffer.from(envelope.payload, 'base64url').toString(),
);
must(
  payload.gateId === gate.gateId && payload.version === 1,
  'the bundle belongs to another gate or version',
);
must(
  JSON.stringify(payload.config).includes('/hello'),
  'the route is not in the bundle',
);
must(
  createHash('sha256').update(text).digest('hex') === released.json().sha256,
  'the pulled bytes are not the bytes that were signed',
);
must(
  (await fetch(base + '/api/pull/' + 'A'.repeat(43))).status === 404,
  'an unknown address was served',
);
step('the gate pulls exactly the signed bundle');

const audit = (await call('GET', `/api/orgs/${org}/audit/verify`)).json();
must(
  audit.check.status === 'intact' && audit.check.entries >= 8,
  `audit log (${JSON.stringify(audit.check)})`,
);
step(`audit log intact (${audit.check.entries} entries)`);
console.log('smoke-cloud-flow: ok');
