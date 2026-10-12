#!/usr/bin/env node
// Enforces the per-workspace warning ceilings in .eslint-budget.json.
//
// Why this exists rather than relying on `pnpm lint` alone: `nx run-many -t lint`
// fails only on eslint *errors*. Warnings — which this repo's config uses for
// tracked debt (`@typescript-eslint/no-unused-vars`, `no-non-null-assertion`) —
// pass silently, so the count could only ever drift upward, and did: apps/api
// stood at 49 when this gate was written, with nothing recording that number or
// noticing it grow. A ceiling per workspace turns that into a ratchet: errors
// always fail, warnings fail once they exceed the recorded number, and the number
// may only be lowered.
//
// Keeping the ceilings in one small dedicated JSON file (rather than as inline
// `--max-warnings N` flags spread across project.json files and CI YAML) is the
// point: raising one is then an obvious, single-purpose diff in review instead of
// a one-line change buried in a large config file.
//
// Adapted from kafikultur/management-app. The one substantive difference is how
// eslint is invoked — see RESOLVING THE CONFIG below. That project has a single
// flat config at its root and can pass `--config`; doing the same here would break
// on our per-project configs.
//
// Usage:
//   node scripts/check-lint-budget.mjs                 # every workspace in the budget
//   node scripts/check-lint-budget.mjs apps/api        # one workspace

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const budget = JSON.parse(
  readFileSync(path.join(repoRoot, '.eslint-budget.json'), 'utf8'),
);

// The `$comment*` keys carry the rationale for the numbers; they are not workspaces.
const allWorkspaces = Object.keys(budget).filter((key) => !key.startsWith('$'));

const requested = process.argv.slice(2);
const workspaces = requested.length > 0 ? requested : allWorkspaces;

let failed = false;

for (const workspace of workspaces) {
  const ceiling = budget[workspace];
  if (typeof ceiling !== 'number') {
    console.error(
      `No budget entry for workspace "${workspace}" in .eslint-budget.json ` +
        `(have: ${allWorkspaces.join(', ')}).`,
    );
    process.exit(1);
  }

  const workspaceDir = path.join(repoRoot, workspace);
  if (!existsSync(workspaceDir)) {
    console.error(`${workspace}: directory does not exist.`);
    process.exit(1);
  }

  // RESOLVING THE CONFIG
  //
  // eslint's flat config is NOT resolved per file — it comes from the working
  // directory. This repo has the Nx layout: each project owns an
  // `eslint.config.mjs` that imports the root one and adds the Angular rules on
  // top. Linting such a project from the repo root with the root config would
  // leave those rules unregistered, and every
  // `eslint-disable-next-line @angular-eslint/...` in the code would then be
  // reported as an *error* ("Definition for rule ... was not found") — a config
  // artefact, not a defect, and one that would point at vendored spartan code
  // CLAUDE.md forbids touching.
  //
  // So: a workspace with its own config is linted from inside it. A plain source
  // directory that is not an Nx project (the root `scripts/`) has no config of its
  // own and is linted from the root against the root config — which is also the
  // only reason it is covered at all, since Nx has no target for it.
  const hasOwnConfig = existsSync(path.join(workspaceDir, 'eslint.config.mjs'));
  const cwd = hasOwnConfig ? workspaceDir : repoRoot;
  const args = hasOwnConfig
    ? ['eslint', '.', '-f', 'json']
    : ['eslint', '--config', 'eslint.config.mjs', workspace, '-f', 'json'];

  let stdout;
  try {
    stdout = execFileSync('npx', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      shell: true,
    });
  } catch (error) {
    // eslint exits non-zero whenever it reports an error (not for warnings alone),
    // but `-f json` still writes the full report to stdout either way.
    stdout = error.stdout ?? '';
    if (!stdout) {
      console.error(`${workspace}: eslint failed to run.`);
      console.error(error.stderr || error.message);
      process.exit(1);
    }
  }

  let errorCount = 0;
  let warningCount = 0;
  for (const file of JSON.parse(stdout)) {
    errorCount += file.errorCount;
    warningCount += file.warningCount;
  }

  if (errorCount > 0) {
    console.error(
      `${workspace}: ${errorCount} lint error(s) — fix before merging.`,
    );
    failed = true;
    continue;
  }

  console.log(`${workspace}: ${warningCount} warning(s), budget ${ceiling}.`);

  if (warningCount > ceiling) {
    console.error(
      `${workspace}: warning count ${warningCount} exceeds the budget of ${ceiling} in ` +
        `.eslint-budget.json. Fix the warnings your change introduced. If they are ` +
        `genuinely pre-existing debt unrelated to this change, that is a sign hygiene ` +
        `has slipped elsewhere — raising the ceiling is not the fix.`,
    );
    failed = true;
  } else if (warningCount < ceiling) {
    console.log(
      `${workspace}: warning count dropped below budget (${warningCount} < ${ceiling}). ` +
        `Lower .eslint-budget.json's "${workspace}" to ${warningCount} in this MR so the ` +
        `ratchet holds.`,
    );
  }
}

process.exit(failed ? 1 : 0);
