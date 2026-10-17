// Renders the Helm chart in every supported configuration and checks it: `helm lint`, `helm
// template` and (when installed) kubeconform on the result, plus the cases that must be refused.
// CI installs helm and kubeconform; on a machine without helm this skips (CI=true makes it fail).
import { spawnSync } from 'node:child_process';

const CHART = 'deploy/helm/moat-cloud';
const KUBE = '1.30.0';
const run = (cmd, args, input) =>
  spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
const has = (cmd) =>
  run(cmd, ['version']).status === 0 || run(cmd, ['-v']).status === 0;

if (!has('helm')) {
  const message = 'check-helm: helm is not installed';
  if (process.env.CI === 'true') {
    console.error(`${message} (required in CI)`);
    process.exit(1);
  }
  console.log(`${message}; skipped`);
  process.exit(0);
}
const kubeconform = has('kubeconform');
if (!kubeconform && process.env.CI === 'true') {
  console.error('check-helm: kubeconform is not installed (required in CI)');
  process.exit(1);
}

const base = [
  'image.tag=1.0.0',
  'publicOrigin=https://moat.example.ch',
  'secrets.accountKey.name=account-key',
];
const postgres = [
  ...base,
  'secrets.databaseUrl.name=database-url',
  'secrets.databaseCa.name=database-ca',
  'networkPolicy.databaseTo[0].ipBlock.cidr=10.0.5.12/32',
];
const sqlite = [...base, 'database.provider=sqlite'];
const ingress = [
  'ingress.enabled=true',
  'ingress.host=moat.example.ch',
  'ingress.tlsSecretName=moat-tls',
  'podDisruptionBudget.enabled=true',
];

const valid = {
  postgresql: postgres,
  'postgresql, 2 replicas, ingress, PDB': [
    ...postgres,
    'replicaCount=2',
    ...ingress,
  ],
  sqlite: sqlite,
  'sqlite, existing claim, no network policy': [
    ...sqlite,
    'database.sqlite.existingClaim=moat-data',
    'networkPolicy.enabled=false',
  ],
};
/** Each of these must be refused, with a message that names the problem. */
const refused = {
  'no image tag': [
    ...postgres.filter((v) => !v.startsWith('image.tag')),
    'image.tag=',
  ],
  'tag latest': [...postgres, 'image.tag=latest'],
  'no public origin': [...postgres, 'publicOrigin='],
  'plain http origin': [...postgres, 'publicOrigin=http://moat.example.ch'],
  'postgresql without a database address': postgres.filter(
    (v) => !v.startsWith('networkPolicy.databaseTo'),
  ),
  'sqlite with two replicas': [...sqlite, 'replicaCount=2'],
  'ingress without TLS': [
    ...sqlite,
    'ingress.enabled=true',
    'ingress.host=moat.example.ch',
  ],
};

const sets = (values) => values.flatMap((value) => ['--set', value]);
let failed = 0;
const fail = (name, text) => {
  failed += 1;
  console.error(`FAIL ${name}\n${text.trim()}\n`);
};

for (const [name, values] of Object.entries(valid)) {
  const lint = run('helm', ['lint', CHART, ...sets(values)]);
  if (lint.status !== 0) {
    fail(`${name}: helm lint`, lint.stdout + lint.stderr);
    continue;
  }
  const rendered = run('helm', [
    'template',
    't',
    CHART,
    '--kube-version',
    KUBE,
    ...sets(values),
  ]);
  if (rendered.status !== 0) {
    fail(`${name}: helm template`, rendered.stderr);
    continue;
  }
  if (kubeconform) {
    const checked = run(
      'kubeconform',
      ['-strict', '-summary', '-kubernetes-version', KUBE, '-'],
      rendered.stdout,
    );
    if (checked.status !== 0) {
      fail(`${name}: kubeconform`, checked.stdout + checked.stderr);
      continue;
    }
  }
  console.log(`ok   ${name}`);
}
for (const [name, values] of Object.entries(refused)) {
  const rendered = run('helm', [
    'template',
    't',
    CHART,
    '--kube-version',
    KUBE,
    ...sets(values),
  ]);
  if (rendered.status === 0) fail(`${name}: rendered, but must be refused`, '');
  else console.log(`ok   refused: ${name}`);
}
process.exit(failed === 0 ? 0 : 1);
