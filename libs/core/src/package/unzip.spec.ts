import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { utf8 } from '../encoding/utf8';
import { readZip, ZipReadError, type Inflate } from './unzip';
import { crc32, storedZip } from './zip';

const LIMITS = {
  maxBytes: 1024 * 1024,
  maxEntries: 8,
  maxEntryBytes: 64 * 1024,
  maxTotalBytes: 128 * 1024,
};
const inflate: Inflate = (data, maxBytes) =>
  new Uint8Array(
    inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) }),
  );

interface RawEntry {
  readonly name: string;
  readonly data?: Uint8Array;
  readonly method?: number;
  readonly flags?: number;
  /** Unix mode in the upper half of the external attributes. */
  readonly mode?: number;
  /** Overrides for the central directory's sizes and CRC (the local header keeps the truth). */
  readonly size?: number;
  readonly crc?: number;
  readonly localName?: string;
  readonly descriptor?: boolean;
}

/** A ZIP built field by field, so the tests can break any of them. */
function rawZip(
  entries: readonly RawEntry[],
  options: { gap?: number; offsetShift?: number; comment?: string } = {},
): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = options.gap ?? 0;
  if (options.gap) locals.push(new Uint8Array(options.gap));
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array();
    const method = entry.method ?? 0;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const name = utf8(entry.name);
    const localName = utf8(entry.localName ?? entry.name);
    const crc = crc32(data);
    const flags = (entry.flags ?? 0) | (entry.descriptor ? 8 : 0);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint32(14, entry.descriptor ? 0 : crc, true);
    local.setUint32(18, entry.descriptor ? 0 : stored.length, true);
    local.setUint32(22, entry.descriptor ? 0 : data.length, true);
    local.setUint16(26, localName.length, true);
    locals.push(new Uint8Array(local.buffer), localName, stored);
    let size = 30 + localName.length + stored.length;
    if (entry.descriptor) {
      const d = new DataView(new ArrayBuffer(16));
      d.setUint32(0, 0x08074b50, true);
      d.setUint32(4, crc, true);
      d.setUint32(8, stored.length, true);
      d.setUint32(12, data.length, true);
      locals.push(new Uint8Array(d.buffer));
      size += 16;
    }
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, (3 << 8) | 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, flags, true);
    central.setUint16(10, method, true);
    central.setUint32(16, entry.crc ?? crc, true);
    central.setUint32(20, stored.length, true);
    central.setUint32(24, entry.size ?? data.length, true);
    central.setUint16(28, name.length, true);
    const mode = entry.mode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644);
    central.setUint32(38, (mode << 16) >>> 0, true);
    central.setUint32(42, offset + (options.offsetShift ?? 0), true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += size;
  }
  const comment = utf8(options.comment ?? '');
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, comment.length, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer), comment];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof ZipReadError) return error.code;
    throw error;
  }
  return 'read';
};
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('readZip (DT-17, T-50)', () => {
  it('reads back what storedZip writes', () => {
    const zip = storedZip([
      { name: 'moat-www-v3/bundle-v3.json', data: utf8('{"a":1}') },
      { name: 'moat-www-v3/policy.json', data: utf8('{}') },
    ]);
    const read = readZip(zip, LIMITS);
    expect(read.folders).toEqual([]);
    expect(read.files.map((f) => [f.name, text(f.data)])).toEqual([
      ['moat-www-v3/bundle-v3.json', '{"a":1}'],
      ['moat-www-v3/policy.json', '{}'],
    ]);
  });

  it('reads deflate entries, data descriptors, folder entries and a comment', () => {
    const zip = rawZip(
      [
        { name: 'p/' },
        { name: 'p/a.txt', data: utf8('hello '.repeat(50)), method: 8 },
        { name: 'p/b.txt', data: utf8('stored'), descriptor: true },
      ],
      { comment: 'hi' },
    );
    const read = readZip(zip, LIMITS, inflate);
    expect(read.folders).toEqual(['p']);
    expect(read.files.map((f) => f.name)).toEqual(['p/a.txt', 'p/b.txt']);
    expect(text(read.files[0]?.data as Uint8Array)).toBe('hello '.repeat(50));
  });

  it('refuses deflate without an inflater, and any other method or encryption', () => {
    const deflated = rawZip([{ name: 'a', data: utf8('x'), method: 8 }]);
    expect(code(() => readZip(deflated, LIMITS))).toBe('zip_unsupported');
    expect(
      code(() => readZip(rawZip([{ name: 'a', method: 12 }]), LIMITS)),
    ).toBe('zip_unsupported');
    expect(code(() => readZip(rawZip([{ name: 'a', flags: 1 }]), LIMITS))).toBe(
      'zip_unsupported',
    );
  });

  it.each([
    ['/etc/passwd'],
    ['../evil.php'],
    ['a/../../evil.php'],
    ['./a'],
    ['a/./b'],
    ['a\\..\\evil.php'],
    ['..\\evil.php'],
    ['C:/evil.php'],
    ['a//b'],
    ['a/b/c/d/e'],
    ['.htaccess'],
    ['a\u0000b'],
    [''],
  ])('Zip-Slip: refuses the entry name %j', (name) => {
    expect(
      code(() => readZip(rawZip([{ name, data: utf8('x') }]), LIMITS)),
    ).toBe('zip_invalid');
  });

  it('refuses a local name that differs from the central one', () => {
    const zip = rawZip([
      { name: 'a.txt', localName: '../a.tx', data: utf8('x') },
    ]);
    expect(code(() => readZip(zip, LIMITS))).toBe('zip_invalid');
  });

  it('refuses duplicate names, also by case, and a file used as a folder', () => {
    for (const names of [
      ['a.txt', 'a.txt'],
      ['A.txt', 'a.txt'],
      ['p/', 'P/'],
      ['p', 'p/a.txt'],
    ]) {
      const zip = rawZip(
        names.map((name) => ({
          name,
          data: name.endsWith('/') ? undefined : utf8('x'),
        })),
      );
      expect(code(() => readZip(zip, LIMITS))).toBe('zip_invalid');
    }
  });

  it('refuses symbolic links and other Unix file types', () => {
    for (const mode of [0o120777, 0o020644, 0o060644, 0o010644]) {
      const zip = rawZip([{ name: 'a', data: utf8('/etc/passwd'), mode }]);
      expect(code(() => readZip(zip, LIMITS))).toBe('zip_invalid');
    }
    expect(
      code(() => readZip(rawZip([{ name: 'a/', mode: 0o100644 }]), LIMITS)),
    ).toBe('zip_invalid');
  });

  it('refuses a wrong CRC or size, data before or between entries, and overlapping entries', () => {
    expect(
      code(() =>
        readZip(rawZip([{ name: 'a', data: utf8('x'), crc: 1 }]), LIMITS),
      ),
    ).toBe('zip_invalid');
    expect(
      code(() =>
        readZip(rawZip([{ name: 'a', data: utf8('xy'), size: 1 }]), LIMITS),
      ),
    ).toBe('zip_invalid');
    expect(
      code(() =>
        readZip(rawZip([{ name: 'a', data: utf8('x') }], { gap: 4 }), LIMITS),
      ),
    ).toBe('zip_invalid');
    expect(
      code(() =>
        readZip(
          rawZip([{ name: 'a', data: utf8('x') }], { offsetShift: 1 }),
          LIMITS,
        ),
      ),
    ).toBe('zip_invalid');
    // Two central entries pointing at the same local header.
    const one = rawZip([{ name: 'a', data: utf8('x') }]);
    const twice = rawZip([
      { name: 'a', data: utf8('x') },
      { name: 'b', data: utf8('x') },
    ]);
    const view = new DataView(twice.buffer);
    const central = view.getUint32(twice.length - 6, true);
    const second = central + 46 + 1;
    view.setUint32(second + 42, 0, true);
    expect(code(() => readZip(twice, LIMITS))).toBe('zip_invalid');
    expect(code(() => readZip(one, LIMITS))).toBe('read');
  });

  it('refuses a truncated archive, trailing bytes and garbage', () => {
    const zip = storedZip([{ name: 'a', data: utf8('x') }]);
    expect(code(() => readZip(zip.subarray(0, zip.length - 1), LIMITS))).toBe(
      'zip_invalid',
    );
    const trailing = new Uint8Array(zip.length + 3);
    trailing.set(zip);
    expect(code(() => readZip(trailing, LIMITS))).toBe('zip_invalid');
    expect(code(() => readZip(utf8('not a zip at all, really'), LIMITS))).toBe(
      'zip_invalid',
    );
    expect(code(() => readZip(new Uint8Array(), LIMITS))).toBe('zip_invalid');
  });

  it('enforces the limits: archive, entry count, entry size, total and inflated size', () => {
    const big = new Uint8Array(LIMITS.maxEntryBytes + 1);
    expect(
      code(() => readZip(rawZip([{ name: 'a', data: big }]), LIMITS)),
    ).toBe('too_large');
    expect(
      code(() => readZip(new Uint8Array(LIMITS.maxBytes + 1), LIMITS)),
    ).toBe('too_large');
    const many = rawZip(
      Array.from({ length: LIMITS.maxEntries + 1 }, (_, i) => ({
        name: `f${i}`,
        data: utf8('x'),
      })),
    );
    expect(code(() => readZip(many, LIMITS))).toBe('too_large');
    const half = new Uint8Array(LIMITS.maxEntryBytes);
    const total = rawZip([
      { name: 'a', data: half },
      { name: 'b', data: half },
      { name: 'c', data: half },
    ]);
    expect(code(() => readZip(total, LIMITS))).toBe('too_large');
    // A deflate bomb that claims a small size: the inflater stops at the claimed size.
    const bomb = rawZip([
      {
        name: 'a',
        data: new Uint8Array(LIMITS.maxEntryBytes),
        method: 8,
        size: 10,
      },
    ]);
    expect(code(() => readZip(bomb, LIMITS, inflate))).toBe('zip_invalid');
  });

  const hasZip = (() => {
    try {
      execFileSync('zip', ['-v'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasZip)(
    'reads what the zip tool makes of a package folder, refuses its links',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'moat-unzip-'));
      try {
        mkdirSync(join(dir, 'moat-www-v2'));
        writeFileSync(
          join(dir, 'moat-www-v2/bundle-v2.json'),
          '{"x":"' + 'a'.repeat(500) + '"}',
        );
        writeFileSync(join(dir, 'moat-www-v2/README.txt'), 'read me\n');
        execFileSync('zip', ['-qr', 'p.zip', 'moat-www-v2'], { cwd: dir });
        const read = readZip(
          new Uint8Array(readFileSync(join(dir, 'p.zip'))),
          LIMITS,
          inflate,
        );
        expect(read.folders).toEqual(['moat-www-v2']);
        expect(read.files.map((f) => f.name).sort()).toEqual([
          'moat-www-v2/README.txt',
          'moat-www-v2/bundle-v2.json',
        ]);

        symlinkSync('/etc/passwd', join(dir, 'moat-www-v2/policy.json'));
        execFileSync('zip', ['-qry', 'l.zip', 'moat-www-v2'], { cwd: dir });
        expect(
          code(() =>
            readZip(
              new Uint8Array(readFileSync(join(dir, 'l.zip'))),
              LIMITS,
              inflate,
            ),
          ),
        ).toBe('zip_invalid');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
