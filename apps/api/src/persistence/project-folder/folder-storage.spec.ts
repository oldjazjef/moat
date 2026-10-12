import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FolderStorage,
  FolderWriteError,
  MAX_FILE_BYTES,
} from './folder-storage';

describe('FolderStorage', () => {
  let base: string;
  let project: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'moat-folder-'));
    project = join(base, 'project');
    mkdirSync(join(project, 'gates'), { recursive: true });
    writeFileSync(join(project, 'moat.yaml'), 'version: 1\n');
    writeFileSync(join(project, 'gates', 'site.json'), '{}');
    writeFileSync(join(base, 'outside.txt'), 'PLANTED-OUTSIDE');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('reads files and lists folders inside the project', () => {
    const storage = new FolderStorage(project);
    expect(storage.read('moat.yaml')).toBe('version: 1\n');
    expect(storage.list('gates')).toEqual(['site.json']);
    expect(storage.read('missing.yaml')).toBeNull();
    expect(storage.list('bundles')).toEqual([]);
  });

  it('never reads outside the project: .., absolute paths, NUL', () => {
    const storage = new FolderStorage(project);
    for (const path of [
      '../outside.txt',
      'gates/../../outside.txt',
      join(base, 'outside.txt'),
      'moat.yaml\0',
    ]) {
      expect(storage.read(path)).toBeNull();
    }
    expect(storage.list('..')).toEqual([]);
    expect(storage.list('.')).toEqual([]);
  });

  it('follows a symbolic link only when its target lies inside the project', () => {
    symlinkSync(join(base, 'outside.txt'), join(project, 'gates', 'evil.json'));
    symlinkSync(join(project, 'moat.yaml'), join(project, 'alias.yaml'));
    const storage = new FolderStorage(project);
    expect(storage.read('gates/evil.json')).toBeNull();
    expect(storage.read('alias.yaml')).toBe('version: 1\n');
  });

  it('reads only regular files up to the size limit', () => {
    writeFileSync(join(project, 'big.json'), Buffer.alloc(MAX_FILE_BYTES + 1));
    const storage = new FolderStorage(project);
    expect(storage.read('big.json')).toBeNull();
    expect(storage.read('gates')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'answers a FIFO swapped in for a file as absent instead of hanging',
    () => {
      execFileSync('mkfifo', [join(project, 'moat.yaml.fifo')]);
      const storage = new FolderStorage(project);
      expect(storage.read('moat.yaml.fifo')).toBeNull();
    },
  );

  it('replaces a file atomically, keeping its permissions and leaving no temporary file', () => {
    chmodSync(join(project, 'moat.yaml'), 0o600);
    const storage = new FolderStorage(project);
    storage.replace('moat.yaml', 'version: 1\n# edited\n');
    expect(readFileSync(join(project, 'moat.yaml'), 'utf8')).toBe(
      'version: 1\n# edited\n',
    );
    if (process.platform !== 'win32')
      expect(statSync(join(project, 'moat.yaml')).mode & 0o777).toBe(0o600);
    expect(readdirSync(project).sort()).toEqual(['gates', 'moat.yaml']);
  });

  it('never writes through a symbolic link or outside the project', () => {
    const storage = new FolderStorage(project);
    symlinkSync(join(base, 'outside.txt'), join(project, 'link.yaml'));
    for (const name of [
      'link.yaml',
      'gates',
      'gates/../moat.yaml',
      '../outside.txt',
      '.hidden',
      join(base, 'outside.txt'),
      '',
    ]) {
      expect(() => storage.replace(name, 'PLANTED')).toThrow(FolderWriteError);
    }
    expect(readFileSync(join(base, 'outside.txt'), 'utf8')).toBe(
      'PLANTED-OUTSIDE',
    );
  });

  it('replaces a sealed secret in its folder, never through a symbolic link folder', () => {
    const storage = new FolderStorage(project);
    storage.replace('secrets/site/hubspot-token.json', '{"v":1}');
    storage.replace('secrets/site/hubspot-token.json', '{"v":2}');
    expect(
      readFileSync(
        join(project, 'secrets', 'site', 'hubspot-token.json'),
        'utf8',
      ),
    ).toBe('{"v":2}');
    expect(readdirSync(join(project, 'secrets', 'site'))).toEqual([
      'hubspot-token.json',
    ]);
    symlinkSync(base, join(project, 'secrets', 'other'));
    expect(() =>
      storage.replace('secrets/other/outside.txt', 'PLANTED'),
    ).toThrow(FolderWriteError);
    expect(readFileSync(join(base, 'outside.txt'), 'utf8')).toBe(
      'PLANTED-OUTSIDE',
    );
  });

  it('creates a bundle file with its folders, and never replaces one', () => {
    const storage = new FolderStorage(project);
    storage.create('bundles/site/1.json', '{"v":1}');
    expect(
      readFileSync(join(project, 'bundles', 'site', '1.json'), 'utf8'),
    ).toBe('{"v":1}');
    let error: unknown;
    try {
      storage.create('bundles/site/1.json', 'PLANTED');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FolderWriteError);
    expect((error as FolderWriteError).reason).toBe('exists');
    expect(
      readFileSync(join(project, 'bundles', 'site', '1.json'), 'utf8'),
    ).toBe('{"v":1}');
    expect(readdirSync(join(project, 'bundles', 'site'))).toEqual(['1.json']);
  });

  it('never creates through a symbolic link folder or outside the project', () => {
    const storage = new FolderStorage(project);
    symlinkSync(base, join(project, 'bundles'));
    for (const path of [
      'bundles/site/1.json',
      '../outside/1.json',
      'gates/../../x.json',
      '.git/1.json',
      '/tmp/1.json',
      'bundles//1.json',
    ]) {
      expect(() => storage.create(path, 'PLANTED')).toThrow(FolderWriteError);
    }
    expect(readdirSync(base).sort()).toEqual(['outside.txt', 'project']);
  });
});
