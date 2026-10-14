/**
 * A ZIP archive (PKWARE APPNOTE 6.3) of a few small files, stored without compression: what Moat
 * Desktop saves as a deploy package (DT-05). Reproducible: the same files give the same bytes
 * (a fixed time, no extra fields), and every unzip tool reads it. No ZIP64: at most
 * MAX_ZIP_ENTRIES entries of at most MAX_ZIP_ENTRY_BYTES each.
 */

export interface ZipEntry {
  /** A relative path with `/` between plain segments (`moat-www-v3/bundle-v3.json`). */
  readonly name: string;
  readonly data: Uint8Array;
}

export const MAX_ZIP_ENTRIES = 64;
export const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;
/** Segments as the package writes them: no `.`/`..`, no backslash, nothing an unzip could resolve. */
const ZIP_NAME =
  /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}){0,3}$/;

/** 1980-01-01 00:00 in MS-DOS time and date (the earliest a ZIP can say). */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data)
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length === 0 || entries.length > MAX_ZIP_ENTRIES)
    throw new RangeError('a ZIP holds 1 to 64 entries');
  const names = new Set<string>();
  for (const entry of entries) {
    if (!ZIP_NAME.test(entry.name) || names.has(entry.name))
      throw new RangeError('not a ZIP entry name');
    if (entry.data.length > MAX_ZIP_ENTRY_BYTES)
      throw new RangeError('ZIP entry too large');
    names.add(entry.name);
  }

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 10, true); // version needed: 1.0 (stored)
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method: stored
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra length
    locals.push(new Uint8Array(local.buffer), name, entry.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, (3 << 8) | 20, true); // made by: Unix, 2.0 (keeps the modes below)
    central.setUint16(6, 10, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, DOS_TIME, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, 0, true); // extra
    central.setUint16(32, 0, true); // comment
    central.setUint16(34, 0, true); // disk
    central.setUint16(36, 0, true); // internal attributes
    central.setUint32(38, (0o100644 << 16) >>> 0, true); // a regular file, rw-r--r--
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + size;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
