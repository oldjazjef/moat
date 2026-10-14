import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployResult } from '../../shared/bridge';
import type { DeployFile, DeployPackage } from './deploy';
import { writeDeployFolder } from './deploy';

/** The outcome of one `git` call: its exit code (null when it was killed) and stdout. */
export interface GitOutput {
  readonly code: number | null;
  readonly stdout: string;
}

/** Runs `git <args>` in `cwd`. Injected so the logic is tested against a real repository. */
export type GitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<GitOutput>;

/** Enough for a push to a slow remote; a prompt that nobody answers ends here too. */
export const GIT_TIMEOUT_MS = 60_000;

/**
 * `git` as the person would run it in that folder, with their own config and credentials, but
 * never running code from the repository: hooks and the fsmonitor are switched off on the
 * command line (which wins over the repository's config), and git never prompts on a terminal.
 */
export function gitRunner(noHooksDir: string): GitRunner {
  return (cwd, args) =>
    new Promise((resolve) => {
      execFile(
        'git',
        [
          '-c',
          `core.hooksPath=${noHooksDir}`,
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (error, stdout) => {
          const code =
            error === null
              ? 0
              : typeof error.code === 'number'
                ? error.code
                : null;
          resolve({ code, stdout: String(stdout) });
        },
      );
    });
}

/** Why a folder cannot take the package. */
export type GitRefusal =
  /** Not inside a Git working copy (or git is not installed). */
  | 'not_a_repo'
  /** No branch checked out. */
  | 'detached'
  /** The branch has no upstream on a remote to push to. */
  | 'no_upstream'
  /** `.gitignore` would keep the package out of the commit. */
  | 'ignored';

/** Where the package goes: the branch and the remote branch it is pushed to. */
export interface GitTarget {
  readonly branch: string;
  readonly remote: string;
  /** `refs/heads/…` on the remote. */
  readonly merge: string;
}

/** Remote names as `git remote add` takes them; never one that reads as an option. */
const REMOTE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/;
const MERGE = /^refs\/heads\/[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

/** The package's folder name, as `deployFiles` writes it. */
function folderOf(files: readonly DeployFile[]): string | null {
  return files[0]?.name.split('/')[0] ?? null;
}

/** A pathspec git takes literally (no glob, no magic), relative to the folder. */
const literal = (path: string) => `:(literal)${path}`;

/**
 * Checks, without writing anything, that `dir` is in a Git working copy on a branch with an
 * upstream, and that the package's files would not be ignored there.
 */
export async function inspectGitTarget(
  git: GitRunner,
  dir: string,
  files: readonly DeployFile[],
): Promise<GitTarget | { refused: GitRefusal }> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true')
    return { refused: 'not_a_repo' };
  const head = await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const branch = head.stdout.trim();
  if (head.code !== 0 || branch === '') return { refused: 'detached' };
  const remote = (
    await git(dir, ['config', '--get', `branch.${branch}.remote`])
  ).stdout.trim();
  const merge = (
    await git(dir, ['config', '--get', `branch.${branch}.merge`])
  ).stdout.trim();
  // '.' is a local branch as upstream: nothing would reach a server.
  if (!REMOTE.test(remote) || remote === '.' || !MERGE.test(merge))
    return { refused: 'no_upstream' };
  const folder = folderOf(files);
  if (folder === null) return { refused: 'not_a_repo' };
  for (const file of files) {
    const ignored = await git(dir, [
      'check-ignore',
      '-q',
      '--no-index',
      '--',
      file.name,
    ]);
    if (ignored.code === 0) return { refused: 'ignored' };
  }
  return { branch, remote, merge };
}

export type GitDeployResult =
  | { readonly status: 'pushed' }
  /** Committed, but the push failed: the commit is there to push by hand. */
  | { readonly status: 'committed' }
  /** A folder of the package's name is there already; nothing was written. */
  | { readonly status: 'exists' }
  | { readonly status: 'not_writable' }
  /** `git add` or `git commit` failed; the folder was removed again. */
  | { readonly status: 'git_failed' };

/** The commit message: what, and how to check it against the package's README. */
export function commitMessage(pkg: DeployPackage): string {
  return [
    `moat: deploy package ${pkg.gate} v${pkg.version}`,
    '',
    `Project: ${pkg.project}`,
    `Gate-Id: ${pkg.gateId}`,
    `Bundle-SHA256: ${pkg.bundleSha256}`,
  ].join('\n');
}

/**
 * Writes the package as a new folder in `dir` (never replacing anything), commits only that
 * folder — whatever else is staged stays as it was — and pushes the commit to the branch's
 * upstream. A failed add or commit removes the folder again; a failed push keeps the commit.
 */
export async function deployToGit(
  git: GitRunner,
  dir: string,
  target: GitTarget,
  pkg: DeployPackage,
  files: readonly DeployFile[],
): Promise<GitDeployResult> {
  const folder = folderOf(files);
  if (folder === null) return { status: 'not_writable' };
  const written = writeDeployFolder(dir, files);
  if (written !== null) return written;
  const added = await git(dir, ['add', '--', literal(folder)]);
  const committed =
    added.code === 0
      ? await git(dir, [
          'commit',
          '--quiet',
          '--only',
          '-m',
          commitMessage(pkg),
          '--',
          literal(folder),
        ])
      : added;
  if (committed.code !== 0) {
    await git(dir, [
      'rm',
      '-r',
      '-q',
      '--cached',
      '--ignore-unmatch',
      '--',
      literal(folder),
    ]);
    // Created by writeDeployFolder above, so it is ours.
    rmSync(join(dir, folder), { recursive: true, force: true });
    return { status: 'git_failed' };
  }
  const pushed = await git(dir, [
    'push',
    '--quiet',
    target.remote,
    `HEAD:${target.merge}`,
  ]);
  return { status: pushed.code === 0 ? 'pushed' : 'committed' };
}

export interface GitFlowDeps {
  readonly git: GitRunner;
  readonly pkg: DeployPackage;
  readonly files: readonly DeployFile[];
  /** The folder remembered for this gate, null when none. */
  stored(): string | null;
  save(dir: string): void;
  forget(): void;
  isFolder(dir: string): boolean;
  /** The main process's folder dialog; null when cancelled. */
  chooseFolder(): Promise<string | null>;
  /** The main process's confirmation with folder, branch and remote. */
  confirm(dir: string, target: GitTarget): Promise<'push' | 'other' | 'cancel'>;
}

/**
 * The Git target (DT-05, T-68): the remembered folder or one chosen in the main process, checked,
 * confirmed with its branch and remote, then committed and pushed. A remembered folder that no
 * longer fits is forgotten and the person chooses again.
 */
export async function runGitDeploy(deps: GitFlowDeps): Promise<DeployResult> {
  let dir = deps.stored();
  let remembered = dir !== null;
  for (;;) {
    if (dir === null || !deps.isFolder(dir)) {
      if (remembered) deps.forget();
      remembered = false;
      dir = await deps.chooseFolder();
      if (dir === null) return { status: 'cancelled' };
      if (!deps.isFolder(dir)) return { status: 'not_writable' };
    }
    const target = await inspectGitTarget(deps.git, dir, deps.files);
    if ('refused' in target) {
      if (remembered) {
        dir = null;
        continue;
      }
      return { status: 'refused', code: `git_${target.refused}` };
    }
    const answer = await deps.confirm(dir, target);
    if (answer === 'cancel') return { status: 'cancelled' };
    if (answer === 'other') {
      dir = null;
      remembered = false;
      continue;
    }
    const result = await deployToGit(
      deps.git,
      dir,
      target,
      deps.pkg,
      deps.files,
    );
    switch (result.status) {
      case 'pushed':
        deps.save(dir);
        return { status: 'exported', target: 'git', version: deps.pkg.version };
      case 'committed':
        deps.save(dir);
        return { status: 'committed', version: deps.pkg.version };
      case 'exists':
      case 'not_writable':
      case 'git_failed':
        return { status: result.status };
    }
  }
}
