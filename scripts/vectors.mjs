#!/usr/bin/env node
// Rewrites conformance/vectors/crypto/ from libs/core/scripts/build-vectors.ts.
//
// The generator is TypeScript on top of libs/core, so it runs where the core's tests run: inside
// the core's Vitest project, with MOAT_WRITE_VECTORS=1 switching the conformance spec from
// "compare" to "write". A Node wrapper instead of `MOAT_WRITE_VECTORS=1 vitest …` in package.json
// keeps it working in PowerShell and cmd as well.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--project',
    'core',
    'libs/core/src/conformance.spec.ts',
  ],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, MOAT_WRITE_VECTORS: '1' },
  },
);
process.exit(result.status ?? 1);
