import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  EMPTY_CONFIG,
  readConfig,
  updateConfig,
  writeConfig,
} from './config';

const KID = 'hpJ_W-5BmWCxRC4DaLFNKQ';

describe('desktop config', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'moat-config-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('remembers the project folder', () => {
    expect(readConfig(dir)).toEqual(EMPTY_CONFIG);
    writeConfig(dir, { ...EMPTY_CONFIG, projectDir: '/home/me/site' });
    expect(readConfig(dir).projectDir).toBe('/home/me/site');
    expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toContain(
      '/home/me/site',
    );
  });

  it('keeps the other fields when one changes, readable by this user only', () => {
    updateConfig(dir, { keyFile: '/home/me/release.moatkey' });
    updateConfig(dir, { passphrases: { [KID]: 'c2VhbGVk' } });
    expect(readConfig(dir)).toEqual({
      projectDir: null,
      keyFile: '/home/me/release.moatkey',
      passphrases: { [KID]: 'c2VhbGVk' },
    });
    if (process.platform !== 'win32')
      expect(statSync(join(dir, CONFIG_FILE)).mode & 0o077).toBe(0);
  });

  it('treats a damaged file, a relative path or another type as no choice', () => {
    for (const content of [
      '{',
      '[]',
      'null',
      '{"projectDir":"relative/dir","keyFile":"key.moatkey"}',
      '{"projectDir":42,"passphrases":[]}',
    ]) {
      writeFileSync(join(dir, CONFIG_FILE), content);
      expect(readConfig(dir)).toEqual(EMPTY_CONFIG);
    }
  });

  it('drops remembered passphrases under a name that is not a key id', () => {
    writeFileSync(
      join(dir, CONFIG_FILE),
      JSON.stringify({
        passphrases: {
          [KID]: 'c2VhbGVk',
          '../x': 'a',
          other: 'b',
          [`${KID}x`]: 'c',
        },
      }),
    );
    expect(readConfig(dir).passphrases).toEqual({ [KID]: 'c2VhbGVk' });
  });
});
