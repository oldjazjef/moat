import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  createKeyFile,
  crc32,
  fromBase64Url,
  storedZip,
  toBase64Url,
} from '@moat/core';
import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import { BundleImportService } from './bundle-import.service';
import { BundleSigningService } from './bundle-signing.service';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const PROJECT = {
  'moat.yaml': RECIPE,
  'gates/site.json': JSON.stringify({
    moat: 'gate',
    v: 1,
    gateId: GATE_ID,
    boxKey: toBase64Url(new Uint8Array(32).fill(7)),
  }),
  'secrets/site/hubspot-token.json': JSON.stringify({
    v: 1,
    alg: 'x25519-blake2b-xchacha20poly1305',
    secretVersion: 1,
    epk: toBase64Url(new Uint8Array(32).fill(1)),
    nonce: toBase64Url(new Uint8Array(24).fill(2)),
    ct: toBase64Url(new Uint8Array(40).fill(3)),
  }),
};

/** Two copies of the same project (two machines), one key: bundles signed in one go to the other. */
async function setup() {
  const keyFile = await createKeyFile('correct horse', {
    ops: 2,
    mem: 64 * 1024 * 1024,
    fixed: {
      seed: randomBytes(32),
      salt: randomBytes(16),
      nonce: randomBytes(24),
    },
  });
  const registry = new InMemoryProjectRegistry();
  const files = new InMemoryProjectFiles({
    '/here': { ...PROJECT },
    '/there': { ...PROJECT },
  });
  const here = registry.add('/here').id;
  const there = registry.add('/there').id;
  const signer = { kid: keyFile.kid, publicKey: fromBase64Url(keyFile.pk) };
  const signing = new BundleSigningService(registry, files);
  /** Signs the next bundle over there and returns its text. */
  const signThere = async () => {
    const prepared = await signing.prepare(there, 'site', signer);
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    const signed = await signing.sign(
      there,
      'site',
      prepared.preview.digest,
      JSON.stringify(keyFile),
      'correct horse',
      1_800_000_000,
    );
    if (signed.status !== 'signed') throw new Error(signed.status);
    return files.folders['/there']?.[
      `bundles/site/${signed.version}.json`
    ] as string;
  };
  return {
    here,
    files,
    signer,
    signThere,
    service: new BundleImportService(registry, files),
  };
}

const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

/** A one-entry ZIP with a deflate entry, as zip tools write it. */
function deflatedZip(name: string, data: Uint8Array): Uint8Array {
  const packed = new Uint8Array(deflateRawSync(data));
  const nameBytes = bytes(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralAt = 30 + nameBytes.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(centralAt, 16);
  return new Uint8Array(
    Buffer.concat([local, nameBytes, packed, central, nameBytes, end]),
  );
}

describe('BundleImportService (FR-45, DT-17)', () => {
  it('imports a bundle file byte for byte, then refuses it a second time', async () => {
    const { here, files, signer, signThere, service } = await setup();
    const v1 = await signThere();
    expect(
      await service.import(here, 'site', signer, {
        kind: 'file',
        bytes: bytes(v1),
      }),
    ).toEqual({ status: 'imported', version: 1 });
    expect(files.folders['/here']?.['bundles/site/1.json']).toBe(v1);
    expect(
      await service.import(here, 'site', signer, {
        kind: 'file',
        bytes: bytes(v1),
      }),
    ).toEqual({ status: 'refused', code: 'version_not_newer' });
  });

  it('imports a package ZIP (stored or deflate) and a package folder, never its policy', async () => {
    const { here, files, signer, signThere, service } = await setup();
    const v1 = await signThere();
    const v2 = await signThere();
    const v3 = await signThere();
    const zip = storedZip([
      { name: 'moat-site-v1/bundle-v1.json', data: bytes(v1) },
      { name: 'moat-site-v1/policy.json', data: bytes('{"upstreams":{}}') },
    ]);
    expect(
      await service.import(here, 'site', signer, { kind: 'file', bytes: zip }),
    ).toEqual({
      status: 'imported',
      version: 1,
    });
    expect(
      await service.import(here, 'site', signer, {
        kind: 'file',
        bytes: deflatedZip('bundle-v2.json', bytes(v2)),
      }),
    ).toEqual({ status: 'imported', version: 2 });
    const read: string[] = [];
    expect(
      await service.import(here, 'site', signer, {
        kind: 'folder',
        entries: [
          { name: 'bundle-v3.json', kind: 'file' },
          { name: 'policy.json', kind: 'file' },
          { name: 'README.txt', kind: 'file' },
        ],
        read: (name) => {
          read.push(name);
          return bytes(v3);
        },
      }),
    ).toEqual({ status: 'imported', version: 3 });
    expect(read).toEqual(['bundle-v3.json']);
    expect(Object.keys(files.folders['/here'] ?? {}).sort()).toEqual([
      'bundles/site/1.json',
      'bundles/site/2.json',
      'bundles/site/3.json',
      'gates/site.json',
      'moat.yaml',
      'secrets/site/hubspot-token.json',
    ]);
  });

  it('refuses a folder with a link, a file it cannot read, another key, an unknown project', async () => {
    const { here, signer, signThere, service } = await setup();
    const v1 = await signThere();
    expect(
      await service.import(here, 'site', signer, {
        kind: 'folder',
        entries: [
          { name: 'bundle-v1.json', kind: 'file' },
          { name: 'policy.json', kind: 'other' },
        ],
        read: () => bytes(v1),
      }),
    ).toEqual({ status: 'refused', code: 'package_invalid' });
    expect(
      await service.import(here, 'site', signer, {
        kind: 'folder',
        entries: [{ name: 'bundle-v1.json', kind: 'file' }],
        read: () => null,
      }),
    ).toEqual({ status: 'refused', code: 'unreadable' });
    expect(
      await service.import(
        here,
        'site',
        { kid: 'x', publicKey: new Uint8Array(32).fill(9) },
        { kind: 'file', bytes: bytes(v1) },
      ),
    ).toEqual({ status: 'refused', code: 'signature_invalid' });
    expect(
      await service.import('BBBBBBBBBBBBBBBBBBBBBB', 'site', signer, {
        kind: 'file',
        bytes: bytes(v1),
      }),
    ).toEqual({ status: 'not_found' });
  });

  it('says not_writable when the project folder is read-only', async () => {
    const { here, files, signer, signThere, service } = await setup();
    const v1 = await signThere();
    files.readOnly.add('/here');
    expect(
      await service.import(here, 'site', signer, {
        kind: 'file',
        bytes: bytes(v1),
      }),
    ).toEqual({ status: 'not_writable' });
  });
});
