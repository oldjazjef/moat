#!/usr/bin/env node
/**
 * Points git at the repo's own hooks (`.githooks/`, see CLAUDE.md, Secrets): the pre-commit hook
 * refuses staged key material, .env files and private/. Run by `pnpm install` (`prepare`).
 *
 * Never fails the install: outside a git checkout (a Docker build context has no .git) or without
 * git on the PATH there is nothing to configure, and the script says so and exits 0.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

if (!existsSync(path.join(repoRoot, '.git'))) {
  console.log('install-hooks: not a git checkout — skipped.');
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  console.log('install-hooks: core.hooksPath = .githooks');
} catch (error) {
  console.warn(
    `install-hooks: could not set core.hooksPath (${error instanceof Error ? error.message : error}) — run \`git config core.hooksPath .githooks\` by hand.`,
  );
}
