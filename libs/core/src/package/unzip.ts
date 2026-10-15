import { fromUtf8 } from '../encoding/utf8';
import { crc32, type ZipEntry } from './zip';

/**
 * A strict reader for the ZIP of a deploy package brought back into Moat Desktop (FR-45, DT-17,
 * T-50). It reads what storedZip writes and what ordinary zip tools make of a package folder
 * (stored or deflate entries, data descriptors), and refuses everything else instead of guessing:
 *
 * - no ZIP64, no multi-disk archive, no encryption, no compression other than stored and deflate
 *   (and deflate only when the caller hands in an inflater: core has no zlib);
 * - names (Zip-Slip): relative, `/` only, plain segments (no `.`/`..`, no backslash, no drive,
 *   no control character), at most four deep; no duplicate, also not when case is ignored (a
 *   case-insensitive file system would merge them);
 * - only regular files and folders: a symbolic link (or any other Unix file type) is refused;
 * - the local headers must agree with the central directory and the entries must fill the
 *   archive from byte 0 up to the central directory without gap or overlap (no hidden or shared
 *   data, no overlapping-entry bomb), with an end record that ends the file;
 * - limits on the archive, the number of entries and every entry's size (before and after
 *   inflating), and each entry's CRC-32.
 *
 * It never writes anything: the caller decides which of the returned files it uses.
 */

/** Inflates raw deflate data; must throw when the result would exceed `maxBytes`. */
export type Inflate = (data: Uint8Array, maxBytes: number) => Uint8Array;

export interface ZipReadLimits {
  /** The archive itself. */
  readonly maxBytes: number;
  /** Files and folders together. */
  readonly maxEntries: number;
  /** One file, compressed and uncompressed. */
  readonly maxEntryBytes: number;
  /** All files together, uncompressed. */
  readonly maxTotalBytes: number;
}

export interface ZipContents {
  readonly files: readonly ZipEntry[];
  /** Folder entries, without the trailing `/`. */
  readonly folders: readonly string[];
}

export type ZipReadErrorCode = 'too_large' | 'zip_invalid' | 'zip_unsupported';

export class ZipReadError extends Error {
  override readonly name = 'ZipReadError';
  constructor(readonly code: ZipReadErrorCode) {
    super(code);
  }
}

const SEGMENT = '[A-Za-z0-9_][A-Za-z0-9._-]{0,99}';
const FILE_NAME = new RegExp(`^${SEGMENT}(?:/${SEGMENT}){0,3}$`);
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const DESCRIPTOR = 0x08074b50;
const STORED = 0;
const DEFLATE = 8;
/** Bit 0 encrypted, 3 data descriptor, 1–2 deflate level, 11 UTF-8 names; nothing else. */
const ALLOWED_FLAGS = 0b0000_1000_0000_1110;
const UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function fail(code: ZipReadErrorCode = 'zip_invalid'): never {
  throw new ZipReadError(code);
}

export function readZip(
  bytes: Uint8Array,
  limits: ZipReadLimits,
  inflate?: Inflate,
): ZipContents {
  if (bytes.length > limits.maxBytes) fail('too_large');
  if (bytes.length < 22) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const within = (at: number, length: number) =>
    at >= 0 && length >= 0 && at + length <= bytes.length;

  // The end record: the last one whose comment reaches exactly to the end of the file.
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 22 - 0xffff);
    at--
  ) {
    if (u32(at) === END && at + 22 + u16(at + 20) === bytes.length) {
      end = at;
      break;
    }
  }
  if (end < 0) fail();
  const count = u16(end + 10);
  const centralSize = u32(end + 12);
  const centralOffset = u32(end + 16);
  if (
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  )
    fail('zip_unsupported');
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== count)
    fail('zip_unsupported');
  if (count === 0) fail();
  if (count > limits.maxEntries) fail('too_large');
  if (centralOffset + centralSize !== end) fail();

  interface Central {
    readonly name: string;
    readonly nameBytes: Uint8Array;
    readonly folder: boolean;
    readonly flags: number;
    readonly method: number;
    readonly crc: number;
    readonly compressed: number;
    readonly size: number;
    readonly offset: number;
  }
  const centrals: Central[] = [];
  const seen = new Set<string>();
  let at = centralOffset;
  for (let index = 0; index < count; index++) {
    if (!within(at, 46) || u32(at) !== CENTRAL) fail();
    const madeBy = u16(at + 4) >> 8;
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressed = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const disk = u16(at + 34);
    const external = u32(at + 38);
    const offset = u32(at + 42);
    if (flags & 1) fail('zip_unsupported');
    if ((flags & ~ALLOWED_FLAGS) !== 0) fail('zip_unsupported');
    if (method !== STORED && method !== DEFLATE) fail('zip_unsupported');
    if (method === DEFLATE && inflate === undefined) fail('zip_unsupported');
    if (
      compressed === 0xffffffff ||
      size === 0xffffffff ||
      offset === 0xffffffff
    )
      fail('zip_unsupported');
    if (disk !== 0) fail('zip_unsupported');
    const total = 46 + nameLength + extraLength + commentLength;
    if (!within(at, total)) fail();
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    let raw: string;
    try {
      raw = fromUtf8(nameBytes);
    } catch {
      fail();
    }
    const folder = raw.endsWith('/');
    const name = folder ? raw.slice(0, -1) : raw;
    if (!FILE_NAME.test(name)) fail();
    if (madeBy === UNIX) {
      const type = (external >>> 16) & S_IFMT;
      // 0: a tool that sets no Unix mode at all; anything else must be a plain file or folder.
      if (type !== 0 && type !== (folder ? S_IFDIR : S_IFREG)) fail();
    }
    if (folder && (compressed !== 0 || size !== 0)) fail();
    if (compressed > limits.maxEntryBytes || size > limits.maxEntryBytes)
      fail('too_large');
    if (method === STORED && compressed !== size) fail();
    const key = name.toLowerCase();
    if (seen.has(key)) fail();
    seen.add(key);
    centrals.push({
      name,
      nameBytes,
      folder,
      flags,
      method,
      crc,
      compressed,
      size,
      offset,
    });
    at += total;
  }
  if (at !== end) fail();

  // A folder entry and a file with the same name, or a file used as a folder: refused.
  for (const entry of centrals) {
    const parts = entry.name.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join('/').toLowerCase();
      const clash = centrals.find(
        (other) => !other.folder && other.name.toLowerCase() === parent,
      );
      if (clash !== undefined) fail();
    }
  }

  // The entries, in archive order, must fill [0, centralOffset) exactly.
  const ordered = [...centrals].sort((a, b) => a.offset - b.offset);
  const files: ZipEntry[] = [];
  const folders: string[] = [];
  let next = 0;
  let totalSize = 0;
  for (const entry of ordered) {
    if (entry.offset !== next) fail();
    if (!within(entry.offset, 30) || u32(entry.offset) !== LOCAL) fail();
    const flags = u16(entry.offset + 6);
    const method = u16(entry.offset + 8);
    const nameLength = u16(entry.offset + 26);
    const extraLength = u16(entry.offset + 28);
    if (flags !== entry.flags || method !== entry.method) fail();
    const nameAt = entry.offset + 30;
    if (!within(nameAt, nameLength + extraLength)) fail();
    const localName = bytes.subarray(nameAt, nameAt + nameLength);
    if (!sameBytes(localName, entry.nameBytes)) fail();
    const descriptor = (flags & 8) !== 0;
    if (!descriptor) {
      if (
        u32(entry.offset + 14) !== entry.crc ||
        u32(entry.offset + 18) !== entry.compressed ||
        u32(entry.offset + 22) !== entry.size
      )
        fail();
    }
    const dataAt = nameAt + nameLength + extraLength;
    if (!within(dataAt, entry.compressed)) fail();
    const data = bytes.subarray(dataAt, dataAt + entry.compressed);
    next = dataAt + entry.compressed;
    if (descriptor) {
      // Optional signature, then CRC-32 and both sizes (32 bits: no ZIP64).
      let d = next;
      if (within(d, 4) && u32(d) === DESCRIPTOR) d += 4;
      if (!within(d, 12)) fail();
      if (
        u32(d) !== entry.crc ||
        u32(d + 4) !== entry.compressed ||
        u32(d + 8) !== entry.size
      )
        fail();
      next = d + 12;
    }
    if (next > centralOffset) fail();
    if (entry.folder) {
      folders.push(entry.name);
      continue;
    }
    let content: Uint8Array;
    if (entry.method === STORED) {
      content = data;
    } else {
      try {
        content = (inflate as Inflate)(data, entry.size);
      } catch {
        fail();
      }
    }
    if (content.length !== entry.size) fail();
    if (crc32(content) !== entry.crc) fail();
    totalSize += content.length;
    if (totalSize > limits.maxTotalBytes) fail('too_large');
    files.push({ name: entry.name, data: content });
  }
  if (next !== centralOffset) fail();
  return { files, folders };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
