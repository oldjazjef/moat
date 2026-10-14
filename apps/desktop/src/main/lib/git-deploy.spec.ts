import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { DeployPackage } from './deploy';
import {
  commitMessage,
  deployToGit,
  type GitRunner,
  type GitTarget,
  gitRunner,
  inspectGitTarget,
  runGitDeploy,
} from './git-deploy';

const PKG: DeployPackage = {
  project: 'shop',
  gate: 'www',
  gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
  version: 3,
  locked: false,
  bundle: '{"b":1}',
  bundleSha256: 'ab'.repeat(32),
  policy: '{"p":1}',
};
const text = (value: string) => new TextEncoder().encode(value);
const FILES = [
  { name: 'moat-www-v3/bundle-v3.json', data: text('{"b":1}') },
  { name: 'moat-www-v3/policy.json', data: text('{"p":1}') },
  { name: 'moat-www-v3/LIESMICH.txt', data: text('liesmich') },
];

/** A git of its own: no global or system config, a fixed identity, branch `main`. */
const ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Moat Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Moat Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

describe('deploy to Git (DT-05, T-68) against real repositories', () => {
  let root: string;
  let saved: NodeJS.ProcessEnv;
  let git: GitRunner;
  let n = 0;

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();

  /** A clone of a fresh bare remote, `main` tracking `origin/main`. */
  function clone(): { work: string; bare: string } {
    const base = join(root, `r${n++}`);
    const bare = join(base, 'remote.git');
    const work = join(base, 'work');
    mkdirSync(base);
    sh(base, 'init', '-q', '--bare', '-b', 'main', bare);
    sh(base, 'clone', '-q', bare, work);
    writeFileSync(join(work, 'index.html'), '<p>shop</p>');
    sh(work, 'add', 'index.html');
    sh(work, 'commit', '-q', '-m', 'first');
    sh(work, 'push', '-q', '-u', 'origin', 'main');
    return { work, bare };
  }

  beforeAll(() => {
    saved = { ...process.env };
    Object.assign(process.env, ENV);
    root = mkdtempSync(join(tmpdir(), 'moat-git-'));
  });

  afterAll(() => {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    git = gitRunner(join(root, 'no-hooks'));
  });

  it('refuses a folder outside a working copy, a detached HEAD and a branch without upstream', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(await inspectGitTarget(git, plain, FILES)).toEqual({
      refused: 'not_a_repo',
    });

    const { work } = clone();
    sh(work, 'checkout', '-q', '--detach');
    expect(await inspectGitTarget(git, work, FILES)).toEqual({
      refused: 'detached',
    });

    const local = join(root, 'local');
    sh(root, 'init', '-q', '-b', 'main', local);
    expect(await inspectGitTarget(git, local, FILES)).toEqual({
      refused: 'no_upstream',
    });
  });

  it('refuses a folder where .gitignore would keep the package out', async () => {
    const { work } = clone();
    writeFileSync(join(work, '.gitignore'), 'moat-*/\n');
    expect(await inspectGitTarget(git, work, FILES)).toEqual({
      refused: 'ignored',
    });
  });

  it('commits only the package folder and pushes it to the upstream branch', async () => {
    const { work, bare } = clone();
    // The person's own work in progress: staged and unstaged, never part of the commit.
    writeFileSync(join(work, 'index.html'), '<p>staged</p>');
    sh(work, 'add', 'index.html');
    writeFileSync(join(work, 'notes.txt'), 'untracked');

    const target = await inspectGitTarget(git, work, FILES);
    expect(target).toEqual({
      branch: 'main',
      remote: 'origin',
      merge: 'refs/heads/main',
    });
    expect(
      await deployToGit(git, work, target as GitTarget, PKG, FILES),
    ).toEqual({ status: 'pushed' });

    expect(sh(bare, 'show', 'main:moat-www-v3/policy.json')).toBe('{"p":1}');
    expect(
      sh(bare, 'show', '--name-only', '--format=', 'main').split('\n').sort(),
    ).toEqual([
      'moat-www-v3/LIESMICH.txt',
      'moat-www-v3/bundle-v3.json',
      'moat-www-v3/policy.json',
    ]);
    expect(sh(bare, 'log', '-1', '--format=%B', 'main')).toBe(
      commitMessage(PKG),
    );
    // Still staged, still uncommitted, still untracked.
    expect(sh(work, 'status', '--porcelain')).toBe(
      'M  index.html\n?? notes.txt',
    );
  });

  it('never replaces a package folder that is there already', async () => {
    const { work, bare } = clone();
    const target = (await inspectGitTarget(git, work, FILES)) as GitTarget;
    await deployToGit(git, work, target, PKG, FILES);
    const head = sh(bare, 'rev-parse', 'main');
    expect(await deployToGit(git, work, target, PKG, FILES)).toEqual({
      status: 'exists',
    });
    expect(sh(bare, 'rev-parse', 'main')).toBe(head);
  });

  it('a failed push keeps the commit to push by hand', async () => {
    const { work, bare } = clone();
    const target = (await inspectGitTarget(git, work, FILES)) as GitTarget;
    const before = sh(bare, 'rev-parse', 'main');
    sh(work, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    expect(await deployToGit(git, work, target, PKG, FILES)).toEqual({
      status: 'committed',
    });
    expect(sh(work, 'log', '-1', '--format=%s')).toBe(
      'moat: deploy package www v3',
    );
    expect(sh(bare, 'rev-parse', 'main')).toBe(before);
  });

  it('a failed commit removes the folder and leaves nothing staged', async () => {
    const { work } = clone();
    const target = (await inspectGitTarget(git, work, FILES)) as GitTarget;
    const failing: GitRunner = (cwd, args) =>
      args.includes('commit')
        ? Promise.resolve({ code: 1, stdout: '' })
        : git(cwd, args);
    expect(await deployToGit(failing, work, target, PKG, FILES)).toEqual({
      status: 'git_failed',
    });
    expect(existsSync(join(work, 'moat-www-v3'))).toBe(false);
    expect(sh(work, 'status', '--porcelain')).toBe('');
  });

  it('runs no hook of the repository, wherever it is configured', async () => {
    const { work } = clone();
    const marker = join(root, 'hook-ran');
    const hook = `#!/bin/sh\ntouch '${marker}'\n`;
    for (const name of ['pre-commit', 'post-commit', 'pre-push']) {
      writeFileSync(join(work, '.git', 'hooks', name), hook);
      chmodSync(join(work, '.git', 'hooks', name), 0o755);
    }
    const custom = join(work, '.githooks');
    mkdirSync(custom);
    writeFileSync(join(custom, 'pre-commit'), hook);
    chmodSync(join(custom, 'pre-commit'), 0o755);
    sh(work, 'config', 'core.hooksPath', '.githooks');

    const target = (await inspectGitTarget(git, work, FILES)) as GitTarget;
    expect(await deployToGit(git, work, target, PKG, FILES)).toEqual({
      status: 'pushed',
    });
    expect(existsSync(marker)).toBe(false);
    // The control: the same repository runs the hook for a plain `git commit`.
    sh(work, 'commit', '-q', '--allow-empty', '-m', 'control');
    expect(existsSync(marker)).toBe(true);
  });

  /** The main process's part, with the dialogs answered by the test. */
  function flow(options: {
    stored: string | null;
    chosen?: (string | null)[];
    answers?: ('push' | 'other' | 'cancel')[];
  }) {
    let stored = options.stored;
    const chosen = [...(options.chosen ?? [])];
    const answers = [...(options.answers ?? [])];
    const chooseFolder = vi.fn(() => Promise.resolve(chosen.shift() ?? null));
    const confirm = vi.fn(() => Promise.resolve(answers.shift() ?? 'cancel'));
    const run = () =>
      runGitDeploy({
        git,
        pkg: PKG,
        files: FILES,
        stored: () => stored,
        save: (dir) => {
          stored = dir;
        },
        forget: () => {
          stored = null;
        },
        isFolder: (dir) => existsSync(dir),
        chooseFolder,
        confirm,
      });
    return { run, chooseFolder, confirm, stored: () => stored };
  }

  it('first time: chooses the folder, confirms branch and remote, pushes, remembers the folder', async () => {
    const { work } = clone();
    const f = flow({ stored: null, chosen: [work], answers: ['push'] });
    expect(await f.run()).toEqual({
      status: 'exported',
      target: 'git',
      version: 3,
    });
    expect(f.confirm).toHaveBeenCalledWith(work, {
      branch: 'main',
      remote: 'origin',
      merge: 'refs/heads/main',
    });
    expect(f.stored()).toBe(work);
  });

  it('next time: the remembered folder, only the confirmation; cancel writes nothing', async () => {
    const { work } = clone();
    const f = flow({ stored: work, answers: ['cancel'] });
    expect(await f.run()).toEqual({ status: 'cancelled' });
    expect(f.chooseFolder).not.toHaveBeenCalled();
    expect(existsSync(join(work, 'moat-www-v3'))).toBe(false);
  });

  it('a remembered folder that no longer fits is forgotten, and the person chooses again', async () => {
    const { work } = clone();
    const plain = join(root, `plain${n++}`);
    mkdirSync(plain);
    const f = flow({ stored: plain, chosen: [work], answers: ['push'] });
    expect(await f.run()).toMatchObject({ status: 'exported' });
    expect(f.chooseFolder).toHaveBeenCalledTimes(1);
    expect(f.stored()).toBe(work);
  });

  it('«Anderen Ordner wählen» opens the folder dialog; a chosen folder that does not fit is refused', async () => {
    const { work } = clone();
    const local = join(root, `local${n++}`);
    sh(root, 'init', '-q', '-b', 'main', local);
    const f = flow({ stored: work, chosen: [local], answers: ['other'] });
    expect(await f.run()).toEqual({
      status: 'refused',
      code: 'git_no_upstream',
    });
    expect(f.stored()).toBe(work);
  });

  it('a failed push is committed: the folder is remembered, the commit stays', async () => {
    const { work } = clone();
    sh(work, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    const f = flow({ stored: null, chosen: [work], answers: ['push'] });
    expect(await f.run()).toEqual({ status: 'committed', version: 3 });
    expect(f.stored()).toBe(work);
  });
});
