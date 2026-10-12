#!/usr/bin/env node
// Rewrites a generated, committed file from libs/core: `vectors` (conformance/vectors/) or
// `schema` (schema/moat.schema.json).
//
// The generators are TypeScript on top of libs/core, so they run where the core's tests run:
// inside the core's Vitest project, with an environment variable switching the spec from
// "compare" to "write". A Node wrapper instead of `VAR=1 vitest …` in package.json keeps it
// working in PowerShell and cmd as well.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const TARGETS = {
  vectors: {
    spec: 'libs/core/src/conformance.spec.ts',
    env: 'MOAT_WRITE_VECTORS',
  },
  schema: {
    spec: 'libs/core/src/config/schema.spec.ts',
    env: 'MOAT_WRITE_SCHEMA',
  },
};
const target = TARGETS[process.argv[2] ?? ''];
if (target === undefined) {
  console.error(
    `usage: node scripts/regenerate.mjs <${Object.keys(TARGETS).join('|')}>`,
  );
  process.exit(2);
}

const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--project', 'core', target.spec],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, [target.env]: '1' },
  },
);
process.exit(result.status ?? 1);
