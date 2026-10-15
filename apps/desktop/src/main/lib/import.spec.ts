import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  importOutcome,
  listPackageFolder,
  MAX_FOLDER_ENTRIES,
  MAX_IMPORT_BUNDLE_BYTES,
  readImportFile,
  readPackageFile,
} from './import';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'moat-import-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const linksWork = process.platform !== 'win32';

describe('readImportFile (FR-45, T-50)', () => {
  it('reads a regular file up to the limit', () => {
    writeFileSync(join(dir, 'bundle-v1.json'), '{"moat":"bundle"}');
    const read = readImportFile(join(dir, 'bundle-v1.json'), 100);
    expect(Buffer.from(read as Uint8Array).toString()).toBe(
      '{"moat":"bundle"}',
    );
  });

  it('says too_large above the limit and refuses folders and missing files', () => {
    writeFileSync(join(dir, 'big.zip'), Buffer.alloc(101));
    expect(readImportFile(join(dir, 'big.zip'), 100)).toBe('too_large');
    expect(readImportFile(dir, 100)).toBeNull();
    expect(readImportFile(join(dir, 'missing.json'), 100)).toBeNull();
  });

  it.skipIf(!linksWork)('never follows a symbolic link', () => {
    writeFileSync(join(dir, 'real.json'), '{}');
    symlinkSync(join(dir, 'real.json'), join(dir, 'link.json'));
    expect(readImportFile(join(dir, 'link.json'), 100)).toBeNull();
  });
});

describe('listPackageFolder / readPackageFile (DT-17)', () => {
  it('lists names and kinds without following anything', () => {
    writeFileSync(join(dir, 'bundle-v2.json'), '{}');
    writeFileSync(join(dir, 'policy.json'), '{}');
    mkdirSync(join(dir, 'sub'));
    if (linksWork) symlinkSync('/etc/passwd', join(dir, 'README.txt'));
    const entries = listPackageFolder(dir)?.sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    expect(entries).toEqual([
      ...(linksWork ? [{ name: 'README.txt', kind: 'other' }] : []),
      { name: 'bundle-v2.json', kind: 'file' },
      { name: 'policy.json', kind: 'file' },
      { name: 'sub', kind: 'other' },
    ]);
  });

  it('stops listing after more entries than a package has', () => {
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}`), '');
    expect(listPackageFolder(dir)).toHaveLength(MAX_FOLDER_ENTRIES + 1);
    expect(listPackageFolder(join(dir, 'f0'))).toBeNull();
  });

  it('reads only a plain name inside the folder, at most a bundle', () => {
    writeFileSync(join(dir, 'bundle-v1.json'), '{}');
    writeFileSync(
      join(dir, 'bundle-v2.json'),
      Buffer.alloc(MAX_IMPORT_BUNDLE_BYTES + 1),
    );
    expect(readPackageFile(dir, 'bundle-v1.json')).toEqual(
      new Uint8Array(Buffer.from('{}')),
    );
    expect(readPackageFile(dir, 'bundle-v2.json')).toBe('too_large');
    for (const name of ['../x', '..', '.', 'a\\b', 'a/b'])
      expect(readPackageFile(dir, name)).toBeNull();
  });
});

describe('importOutcome', () => {
  it('passes outcomes through and hides an unknown project as failed', () => {
    expect(importOutcome({ status: 'imported', version: 3 })).toEqual({
      status: 'imported',
      version: 3,
    });
    expect(importOutcome({ status: 'refused', code: 'gate_mismatch' })).toEqual(
      {
        status: 'refused',
        code: 'gate_mismatch',
      },
    );
    expect(importOutcome({ status: 'not_found' })).toEqual({
      status: 'failed',
    });
  });
});
