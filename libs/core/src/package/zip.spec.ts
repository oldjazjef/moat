import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { utf8 } from '../encoding/utf8';
import { crc32, storedZip } from './zip';

/** Reads the central directory back, as an unzip tool would. */
function entriesOf(zip: Uint8Array): { name: string; data: string }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: { name: string; data: string }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      zip.subarray(at + 46, at + 46 + nameLength),
    );
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true);
    const data = zip.subarray(start, start + size);
    expect(crc32(data)).toBe(view.getUint32(at + 16, true));
    out.push({ name, data: new TextDecoder().decode(data) });
    at += 46 + nameLength;
  }
  return out;
}

describe('storedZip (DT-05)', () => {
  it('CRC-32 as every unzip computes it', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('holds the files unchanged and gives the same bytes every time', () => {
    const files = [
      { name: 'moat-www-v3/bundle-v3.json', data: utf8('{"payload":"x"}') },
      { name: 'moat-www-v3/LIESMICH.txt', data: utf8('Grüezi\n') },
    ];
    const zip = storedZip(files);
    expect(entriesOf(zip)).toEqual([
      { name: 'moat-www-v3/bundle-v3.json', data: '{"payload":"x"}' },
      { name: 'moat-www-v3/LIESMICH.txt', data: 'Grüezi\n' },
    ]);
    expect(storedZip(files)).toEqual(zip);
  });

  it('refuses names an unzip could resolve outside its folder', () => {
    const data = new Uint8Array();
    for (const name of [
      '../x',
      '/etc/passwd',
      'a/../b',
      'a\\b',
      '.htaccess',
      'a//b',
      'C:x',
      '',
    ])
      expect(() => storedZip([{ name, data }]), name).toThrow(RangeError);
    expect(() =>
      storedZip([
        { name: 'a', data },
        { name: 'a', data },
      ]),
    ).toThrow(RangeError);
    expect(() => storedZip([])).toThrow(RangeError);
  });

  it.runIf(hasUnzip())('unzip -t accepts it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moat-zip-'));
    try {
      const path = join(dir, 'p.zip');
      writeFileSync(
        path,
        storedZip([{ name: 'p/a.txt', data: utf8('hello\n') }]),
      );
      expect(execFileSync('unzip', ['-t', path]).toString()).toContain(
        'No errors detected',
      );
      execFileSync('unzip', ['-q', path, '-d', dir]);
      expect(readFileSync(join(dir, 'p/a.txt'), 'utf8')).toBe('hello\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function hasUnzip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
