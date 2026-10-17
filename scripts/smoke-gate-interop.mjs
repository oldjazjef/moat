// Moat Cloud and the real PHP gate, against each other: a gate is installed with the Cloud's
// signing key pinned, enrolled in the Cloud with the fingerprint it printed itself, gets a
// bundle from the Cloud's pull address and ACCEPTS it with its own verification (steps 1–10) —
// and refuses a replay of the old version. Needs php (>= 8.2 with sodium), a built gate file
// (`pnpm build:gate-php`) and a server with a signing key.
//
//   node scripts/smoke-gate-interop.mjs http://127.0.0.1:3000 https://the-public-origin
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, must, step } from './lib/cloud-client.mjs';

const base = process.argv[2];
const origin = process.argv[3] ?? base;
if (!base) {
  console.error('usage: smoke-gate-interop.mjs <base url> [public origin]');
  process.exit(2);
}
const gateFile = join(
  import.meta.dirname,
  '..',
  'gates',
  'php',
  'dist',
  'moat-gate.php',
);
const dir = mkdtempSync(join(tmpdir(), 'moat-interop-'));
copyFileSync(gateFile, join(dir, 'moat-gate.php'));
const php = (...args) =>
  spawnSync('php', ['moat-gate.php', ...args], { cwd: dir, encoding: 'utf8' });

const { call, signUp } = createClient(base, origin);
await signUp();
const org = (await call('POST', '/api/orgs', { name: 'Interop' })).json()
  .organisation.id;
const project = (
  await call('POST', `/api/orgs/${org}/projects`, { name: 'Site' })
).json().project.id;
const root = `/api/orgs/${org}/projects/${project}`;
const signer = (await call('GET', `${root}/gates`)).json().signer;
must(signer !== null, 'this server has no signing key (MOAT_SIGNING_KEY)');

// 1. The gate: installed with the Cloud's public key pinned (what the dashboard tells the person).
const installed = php('install', `--signer=${signer.publicKey}`);
must(installed.status === 0, `install: ${installed.stderr}${installed.stdout}`);
const out = installed.stdout;
const gateId = /Gate id:\s+(\S+)/.exec(out)?.[1];
const fingerprint = /Box key:\s+(MOAT-\S+)/.exec(out)?.[1];
const boxKey = /--box-key=(\S+)/.exec(out)?.[1];
must(gateId && fingerprint && boxKey, "could not read the gate's identity");
must(
  out.includes(signer.fingerprint),
  'the gate shows another fingerprint for the Cloud key',
);
step('gate installed, the Cloud key pinned, fingerprints agree');

// 2. A policy that allows the upstream the config uses (the local limit, SEC-10).
const policy = join(dir, 'policy.json');
writeFileSync(
  policy,
  JSON.stringify({
    v: 1,
    upstreams: {
      'api.example.com': {
        pathPrefixes: ['/v1'],
        methods: ['POST'],
        secrets: [],
      },
    },
    maxBodyBytes: 65536,
    maxResponseBytes: 65536,
    maxTimeoutMs: 10000,
    limits: {
      perIp: { requests: 100, windowSeconds: 60 },
      total: { requests: 1000, windowSeconds: 60 },
      maxClients: 5000,
    },
  }),
);
const policed = php('policy', policy);
must(policed.status === 0, `policy: ${policed.stderr}${policed.stdout}`);

// 3. The Cloud: enrol the gate with the fingerprint IT printed, write the config, release, pull.
const saved = (
  await call('PUT', `${root}/config`, {
    text: 'version: 1\n\nenvironments:\n  production:\n    enabled: true\n\nupstreams: {}\n\nroutes: {}\n',
  })
).json();
let hash = saved.hash;
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
  must(answer.status === 200, `${edit.op} (${answer.status})`);
  hash = answer.json().hash;
}
const enrolled = await call('POST', `${root}/gates`, {
  name: 'site',
  gateId,
  boxKey,
  fingerprint,
});
must(enrolled.status === 201, `enrol (${enrolled.status} ${enrolled.text})`);
step('the Cloud took the gate with the fingerprint the gate printed');

async function release() {
  const preview = (await call('GET', `${root}/gates/site/release`)).json()
    .preview;
  const done = await call('POST', `${root}/gates/site/releases`, {
    digest: preview.digest,
  });
  must(done.status === 201, `release (${done.status} ${done.text})`);
  return done.json().version;
}
const pullUrl = new URL(
  (await call('POST', `${root}/gates/site/pull-address`)).json().url,
);
async function fetchBundle(name) {
  const res = await fetch(base + pullUrl.pathname);
  must(res.status === 200, `pull (${res.status})`);
  const file = join(dir, name);
  writeFileSync(file, await res.text());
  return file;
}

must((await release()) === 1, 'first release');
const first = await fetchBundle('bundle-1.json');
const accepted = php('accept', first);
must(
  accepted.status === 0,
  `the gate REFUSED the Cloud's bundle: ${accepted.stderr}${accepted.stdout}`,
);
step(
  "the real gate accepted the Cloud's version 1 (signature, gate id, version, config, policy)",
);

// 4. Version 2 comes by the gate's own lazy pull address… here by accept, the same check.
await call('POST', `${root}/config/edits`, {
  base: hash,
  op: 'disableRoute',
  route: 'hello',
});
must((await release()) === 2, 'second release');
const second = await fetchBundle('bundle-2.json');
must(php('accept', second).status === 0, 'the gate refused version 2');
// 5. A replay of version 1 is a rollback: the gate refuses it (SEC-04).
const replay = php('accept', first);
must(replay.status !== 0, 'the gate accepted a rollback to version 1');
step('version 2 accepted, a replay of version 1 refused by the gate');

const status = execFileSync('php', ['moat-gate.php', 'status'], {
  cwd: dir,
  encoding: 'utf8',
});
must(
  /version\s*:?\s*2/i.test(status) || status.includes('2'),
  'the gate does not report version 2',
);
console.log('smoke-gate-interop: ok');
