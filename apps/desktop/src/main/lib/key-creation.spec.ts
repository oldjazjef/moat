import {
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from './messages';
import { KeyCreationSession, writeKeyFile } from './key-creation';

const KEY = {
  kid: 'k'.repeat(22),
  publicKey: 'p'.repeat(43),
  fingerprint: 'MOAT-AAAA',
};
const GOOD = 'correct horse battery';

function session(
  overrides: Partial<ConstructorParameters<typeof KeyCreationSession>[0]> = {},
) {
  const deps = {
    texts: MESSAGES['de-CH'].keyDialog,
    chooseTarget: vi.fn(async () => '/keys/moat.moatkey' as string | null),
    create: vi.fn(async () => ({ text: '{"moat":"keyfile"}', key: KEY })),
    write: vi.fn(() => 'written' as const),
    use: vi.fn(),
    ...overrides,
  };
  return { deps, session: new KeyCreationSession(deps) };
}

describe('KeyCreationSession (FR-73)', () => {
  it('creates, writes and uses the key, and gives the page only its public half', async () => {
    const { deps, session: s } = session();
    expect(await s.confirm({ passphrase: GOOD, repeat: GOOD })).toEqual({
      done: { status: 'created', key: KEY },
    });
    expect(deps.create).toHaveBeenCalledWith(GOOD);
    expect(deps.write).toHaveBeenCalledWith(
      '/keys/moat.moatkey',
      '{"moat":"keyfile"}',
    );
    expect(deps.use).toHaveBeenCalledWith('/keys/moat.moatkey');
  });

  it.each([
    ['short', 'short', 'too_short'],
    ['x'.repeat(1025), 'x'.repeat(1025), 'too_long'],
    [GOOD, `${GOOD}!`, 'mismatch'],
  ])(
    'refuses %s before asking where to save',
    async (passphrase, repeat, notice) => {
      const { deps, session: s } = session();
      const step = await s.confirm({ passphrase, repeat });
      expect('view' in step && step.view.notice).toBe(notice);
      expect(deps.chooseTarget).not.toHaveBeenCalled();
      expect(deps.create).not.toHaveBeenCalled();
    },
  );

  it('stays open without a key when the save dialog is cancelled', async () => {
    const { deps, session: s } = session({
      chooseTarget: vi.fn(async () => null),
    });
    const step = await s.confirm({ passphrase: GOOD, repeat: GOOD });
    expect('view' in step && step.view.notice).toBeNull();
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('never overwrites a file and does not use a key it could not write', async () => {
    for (const [outcome, notice] of [
      ['exists', 'exists'],
      ['failed', 'not_writable'],
    ] as const) {
      const { deps, session: s } = session({ write: vi.fn(() => outcome) });
      const step = await s.confirm({ passphrase: GOOD, repeat: GOOD });
      expect('view' in step && step.view.notice).toBe(notice);
      expect(deps.use).not.toHaveBeenCalled();
    }
  });
});

describe('writeKeyFile', () => {
  it('writes 0600 and never over an existing file or through a link', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moat-key-'));
    const path = join(dir, 'a.moatkey');
    expect(writeKeyFile(path, 'one')).toBe('written');
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(writeKeyFile(path, 'two')).toBe('exists');
    expect(readFileSync(path, 'utf8')).toBe('one');
    if (process.platform !== 'win32') {
      const target = join(dir, 'target');
      writeFileSync(target, 'keep');
      symlinkSync(target, join(dir, 'link.moatkey'));
      expect(writeKeyFile(join(dir, 'link.moatkey'), 'x')).toBe('exists');
      expect(readFileSync(target, 'utf8')).toBe('keep');
    }
    expect(writeKeyFile(join(dir, 'missing', 'b.moatkey'), 'x')).toBe('failed');
  });
});
