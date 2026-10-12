import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE, readConfig, writeConfig } from './config';

describe('desktop config', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'moat-config-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('remembers the project folder', () => {
    expect(readConfig(dir)).toEqual({ projectDir: null });
    writeConfig(dir, { projectDir: '/home/me/site' });
    expect(readConfig(dir)).toEqual({ projectDir: '/home/me/site' });
    expect(readFileSync(join(dir, CONFIG_FILE), 'utf8')).toContain(
      '/home/me/site',
    );
  });

  it('treats a damaged file, a relative path or another type as no choice', () => {
    for (const content of [
      '{',
      '[]',
      'null',
      '{"projectDir":"relative/dir"}',
      '{"projectDir":42}',
    ]) {
      writeFileSync(join(dir, CONFIG_FILE), content);
      expect(readConfig(dir)).toEqual({ projectDir: null });
    }
  });
});
