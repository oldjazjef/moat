import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildBundle } from '../bundle/build';
import {
  signBundle,
  type BundlePayload,
  type Ed25519Signer,
} from '../bundle/bundle';
import { keyId } from '../crypto/kid';
import { sodium } from '../crypto/sodium';
import { fromBase64Url, toBase64Url } from '../encoding/base64url';
import { fromUtf8, utf8 } from '../encoding/utf8';
import { parseStrictJson, type JsonValue } from '../json/strict-json';
import { storedZip } from '../package/zip';
import { planBundle, type PlanSigner } from './bundle-plan';
import {
  hasForbiddenKey,
  ImportPlanError,
  packageBundleName,
  planImport,
  type ImportSource,
} from './import-plan';
import type { StoragePort } from './storage-port';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_GATE_ID = 'BBBBBBBBBBBBBBBBBBBBBB';
const gateFile = (gateId: string) =>
  JSON.stringify({
    moat: 'gate',
    v: 1,
    gateId,
    boxKey: toBase64Url(new Uint8Array(32).fill(7)),
  });
const SEALED = JSON.stringify({
  v: 1,
  alg: 'x25519-blake2b-xchacha20poly1305',
  secretVersion: 1,
  epk: toBase64Url(new Uint8Array(32).fill(1)),
  nonce: toBase64Url(new Uint8Array(24).fill(2)),
  ct: toBase64Url(new Uint8Array(40).fill(3)),
});
const BASE = {
  'moat.yaml': RECIPE,
  'gates/site.json': gateFile(GATE_ID),
  'secrets/site/hubspot-token.json': SEALED,
};

function folder(files: Record<string, string>): StoragePort {
  return {
    read: (path) => files[path] ?? null,
    list: (dir) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1))
        .filter((name) => !name.includes('/')),
  };
}

async function keys(): Promise<{ signer: Ed25519Signer; plan: PlanSigner }> {
  const na = await sodium();
  const pair = na.crypto_sign_keypair();
  return {
    signer: {
      alg: 'ed25519',
      secretKey: pair.privateKey,
      publicKey: pair.publicKey,
    },
    plan: {
      kid: await keyId('ed25519', pair.publicKey),
      publicKey: pair.publicKey,
    },
  };
}

/** A bundle of the recipe for `gateId`, as Moat Desktop or the CLI signs it. */
async function bundle(
  signer: Ed25519Signer,
  version: number,
  gateId = GATE_ID,
): Promise<string> {
  const plan = await planBundle(folder(BASE), 'site', null);
  return buildBundle(
    {
      config: plan.source,
      gate: 'site',
      gateId,
      secrets: plan.secrets,
      version,
      issuedAt: 1,
    },
    [signer],
  );
}

/** The payload of `envelope`, changed by `edit` and signed again by `signer`. */
async function resigned(
  envelope: string,
  signer: Ed25519Signer,
  edit: (payload: { [key: string]: JsonValue }) => void,
): Promise<string> {
  const parsed = JSON.parse(envelope) as { payload: string };
  const payload = parseStrictJson(fromBase64Url(parsed.payload)) as {
    [key: string]: JsonValue;
  };
  edit(payload);
  return signBundle(payload as unknown as BundlePayload, [signer]);
}

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ImportPlanError) return error.code;
    throw error;
  }
  return 'planned';
};
const file = (text: string): ImportSource => ({
  kind: 'bundle',
  bytes: utf8(text),
});
const inflate = (data: Uint8Array, maxBytes: number) =>
  new Uint8Array(
    inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) }),
  );

describe('planImport (FR-45, DT-17, T-50)', () => {
  it('takes a bundle signed with the key for this gate, above the latest, byte for byte', async () => {
    const { signer, plan } = await keys();
    const v1 = await bundle(signer, 1);
    const v3 = await bundle(signer, 3);
    const files = { ...BASE, 'bundles/site/1.json': v1 };
    const imported = await planImport(folder(files), 'site', plan, file(v3));
    expect(imported).toMatchObject({
      gate: 'site',
      gateId: GATE_ID,
      version: 3,
      previousVersion: 1,
      locked: false,
    });
    expect(imported.bundle).toBe(v3);
  });

  it('keeps the exact bytes: whitespace in the envelope is not normalised', async () => {
    const { signer, plan } = await keys();
    const pretty = `${JSON.stringify(JSON.parse(await bundle(signer, 1)), null, 2)}\n`;
    const imported = await planImport(folder(BASE), 'site', plan, file(pretty));
    expect(imported.bundle).toBe(pretty);
  });

  it('SEC-01: refuses a bundle another key signed, or a tampered one', async () => {
    const mine = await keys();
    const other = await keys();
    expect(
      await code(async () =>
        planImport(
          folder(BASE),
          'site',
          mine.plan,
          file(await bundle(other.signer, 1)),
        ),
      ),
    ).toBe('signature_invalid');
    const envelope = JSON.parse(await bundle(mine.signer, 1)) as {
      payload: string;
      sigs: { kid: string; alg: string; sig: string }[];
    };
    const payload = fromUtf8(fromBase64Url(envelope.payload)).replace(
      '"version":1',
      '"version":2',
    );
    const tampered = JSON.stringify({
      ...envelope,
      payload: toBase64Url(utf8(payload)),
    });
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', mine.plan, file(tampered)),
      ),
    ).toBe('signature_invalid');
    const sig = envelope.sigs[0] as { kid: string; alg: string; sig: string };
    const flipped = JSON.stringify({
      ...envelope,
      sigs: [{ ...sig, sig: toBase64Url(new Uint8Array(64)) }],
    });
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', mine.plan, file(flipped)),
      ),
    ).toBe('signature_invalid');
  });

  it('SEC-07: refuses a bundle for another gate', async () => {
    const { signer, plan } = await keys();
    expect(
      await code(async () =>
        planImport(
          folder(BASE),
          'site',
          plan,
          file(await bundle(signer, 1, OTHER_GATE_ID)),
        ),
      ),
    ).toBe('gate_mismatch');
  });

  it('SEC-04: refuses a version not above the latest bundle', async () => {
    const { signer, plan } = await keys();
    const files = { ...BASE, 'bundles/site/2.json': await bundle(signer, 2) };
    for (const version of [1, 2]) {
      expect(
        await code(async () =>
          planImport(
            folder(files),
            'site',
            plan,
            file(await bundle(signer, version)),
          ),
        ),
      ).toBe('version_not_newer');
    }
  });

  it('refuses an unknown gate before reading anything', async () => {
    const { signer, plan } = await keys();
    const v1 = await bundle(signer, 1);
    for (const gate of ['shop', '../site', 'Site']) {
      expect(
        await code(() => planImport(folder(BASE), gate, plan, file(v1))),
      ).toBe('gate_unknown');
    }
  });

  it('DT-17: refuses a __proto__ key anywhere in the payload', async () => {
    const { signer, plan } = await keys();
    const v1 = await bundle(signer, 1);
    const signed = await resigned(v1, signer, (p) => {
      (p['config'] as { [k: string]: JsonValue })['__proto__'] = {
        polluted: true,
      };
    });
    expect(
      await code(() => planImport(folder(BASE), 'site', plan, file(signed))),
    ).toBe('bundle_invalid');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('DT-17: takes `constructor` and `prototype` as the names they are', async () => {
    const { signer, plan } = await keys();
    const v1 = await bundle(signer, 1);
    const signed = await resigned(v1, signer, (p) => {
      const routes = (p['config'] as { routes: { [k: string]: JsonValue } })
        .routes;
      const [first] = Object.keys(routes);
      routes['constructor'] = routes[first as string] as JsonValue;
      delete routes[first as string];
    });
    await expect(
      planImport(folder(BASE), 'site', plan, file(signed)),
    ).resolves.toBeDefined();
  });

  it('refuses an envelope with a __proto__ key, a BOM, broken UTF-8 or too deep JSON', async () => {
    const { signer, plan } = await keys();
    const v1 = await bundle(signer, 1);
    const proto = v1.replace('{"moat"', '{"__proto__":{},"moat"');
    expect(
      await code(() => planImport(folder(BASE), 'site', plan, file(proto))),
    ).toBe('bundle_invalid');
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', plan, file(`\uFEFF${v1}`)),
      ),
    ).toBe('bundle_invalid');
    const broken = new Uint8Array([
      ...utf8(v1).subarray(0, 10),
      0xff,
      ...utf8(v1).subarray(10),
    ]);
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', plan, {
          kind: 'bundle',
          bytes: broken,
        }),
      ),
    ).toBe('bundle_invalid');
    expect(
      await code(() =>
        planImport(
          folder(BASE),
          'site',
          plan,
          file('['.repeat(40) + ']'.repeat(40)),
        ),
      ),
    ).toBe('bundle_invalid');
  });

  it('refuses a signed payload whose config breaks the schema or whose secret is not sealed', async () => {
    const { signer, plan } = await keys();
    const v1 = await bundle(signer, 1);
    const unknownField = await resigned(v1, signer, (p) => {
      (p['config'] as { [k: string]: JsonValue })['eval'] = 'x';
    });
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', plan, file(unknownField)),
      ),
    ).toBe('config_invalid');
    const badSecret = await resigned(v1, signer, (p) => {
      const secrets = p['secrets'] as { [k: string]: JsonValue };
      secrets['hubspot-token'] = 'plain text';
    });
    expect(
      await code(() => planImport(folder(BASE), 'site', plan, file(badSecret))),
    ).toBe('bundle_invalid');
  });

  it('refuses an oversize file before parsing it', async () => {
    const { plan } = await keys();
    const huge = new Uint8Array(1024 * 1024 + 1).fill(0x20);
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', plan, { kind: 'bundle', bytes: huge }),
      ),
    ).toBe('too_large');
  });

  it('reads a deploy package ZIP and a package folder, ignoring policy.json', async () => {
    const { signer, plan } = await keys();
    const v2 = await bundle(signer, 2);
    const zip = storedZip([
      { name: 'moat-site-v2/bundle-v2.json', data: utf8(v2) },
      { name: 'moat-site-v2/policy.json', data: utf8('{"evil":true}') },
      { name: 'moat-site-v2/LIESMICH.txt', data: utf8('…') },
    ]);
    const fromZip = await planImport(folder(BASE), 'site', plan, {
      kind: 'zip',
      bytes: zip,
    });
    expect(fromZip.version).toBe(2);
    expect(fromZip.bundle).toBe(v2);
    const flat = storedZip([{ name: 'bundle-v2.json', data: utf8(v2) }]);
    expect(
      (
        await planImport(folder(BASE), 'site', plan, {
          kind: 'zip',
          bytes: flat,
          inflate,
        })
      ).version,
    ).toBe(2);
    const fromFolder = await planImport(folder(BASE), 'site', plan, {
      kind: 'package',
      name: 'bundle-v2.json',
      bytes: utf8(v2),
    });
    expect(fromFolder.bundle).toBe(v2);
  });

  it('refuses a package whose file name or folder names another version', async () => {
    const { signer, plan } = await keys();
    const v2 = await bundle(signer, 2);
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', plan, {
          kind: 'package',
          name: 'bundle-v3.json',
          bytes: utf8(v2),
        }),
      ),
    ).toBe('bundle_invalid');
    const zip = storedZip([
      { name: 'moat-site-v3/bundle-v2.json', data: utf8(v2) },
    ]);
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', plan, { kind: 'zip', bytes: zip }),
      ),
    ).toBe('package_invalid');
  });

  it('Zip-Slip and strange packages: refused', async () => {
    const { signer, plan } = await keys();
    const v1 = utf8(await bundle(signer, 1));
    const cases: { name: string; data: Uint8Array }[][] = [
      // Unexpected file next to the bundle.
      [
        { name: 'bundle-v1.json', data: v1 },
        { name: 'moat-gate.php', data: utf8('<?php') },
      ],
      // Two bundles.
      [
        { name: 'bundle-v1.json', data: v1 },
        { name: 'bundle-v2.json', data: v1 },
      ],
      // No bundle.
      [{ name: 'policy.json', data: utf8('{}') }],
      // Two top folders, or a folder that is not a package's.
      [
        { name: 'moat-site-v1/bundle-v1.json', data: v1 },
        { name: 'moat-shop-v1/policy.json', data: utf8('{}') },
      ],
      [{ name: 'bundles/bundle-v1.json', data: v1 }],
      // Nested deeper.
      [{ name: 'moat-site-v1/x/bundle-v1.json', data: v1 }],
      // Files at the top and in a folder.
      [
        { name: 'bundle-v1.json', data: v1 },
        { name: 'moat-site-v1/policy.json', data: utf8('{}') },
      ],
    ];
    for (const entries of cases) {
      expect(
        await code(() =>
          planImport(folder(BASE), 'site', plan, {
            kind: 'zip',
            bytes: storedZip(entries),
          }),
        ),
      ).toBe('package_invalid');
    }
    const slip = storedZip([{ name: 'bundle-v1.json', data: v1 }]);
    // Rewrite the name in both headers to `../undle-v1.json` (same length).
    const evil = new Uint8Array(slip);
    const name = utf8('bundle-v1.json');
    const replacement = utf8('../ndle-v1.json'.slice(0, name.length));
    for (let at = 0; at < evil.length - name.length; at++) {
      if (name.every((byte, i) => evil[at + i] === byte))
        evil.set(replacement, at);
    }
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', plan, { kind: 'zip', bytes: evil }),
      ),
    ).toBe('package_invalid');
    expect(
      await code(() =>
        planImport(folder(BASE), 'site', plan, {
          kind: 'zip',
          bytes: new Uint8Array(4 * 1024 * 1024 + 1),
        }),
      ),
    ).toBe('too_large');
  });
});

describe('packageBundleName (DT-17)', () => {
  it('finds the one bundle among the files a package has', () => {
    expect(
      packageBundleName([
        { name: 'bundle-v12.json', kind: 'file' },
        { name: 'policy.json', kind: 'file' },
        { name: 'README.txt', kind: 'file' },
      ]),
    ).toBe('bundle-v12.json');
  });

  it.each([
    [[]],
    [[{ name: 'bundle-v1.json', kind: 'other' }]],
    [
      [
        { name: 'bundle-v1.json', kind: 'file' },
        { name: 'policy.json', kind: 'other' },
      ],
    ],
    [
      [
        { name: 'bundle-v1.json', kind: 'file' },
        { name: '.htaccess', kind: 'file' },
      ],
    ],
    [[{ name: 'bundle-v0.json', kind: 'file' }]],
    [[{ name: 'bundle-v01.json', kind: 'file' }]],
    [
      [
        { name: 'bundle-v1.json', kind: 'file' },
        { name: 'BUNDLE-V1.json', kind: 'file' },
      ],
    ],
    [
      [
        { name: 'bundle-v1.json', kind: 'file' },
        { name: 'bundle-v2.json', kind: 'file' },
      ],
    ],
  ] as const)('refuses %j', (entries) => {
    expect(() => packageBundleName(entries)).toThrow(ImportPlanError);
  });

  it('hasForbiddenKey looks into arrays and nested objects', () => {
    expect(
      hasForbiddenKey(parseStrictJson(utf8('{"a":[{"b":{"__proto__":1}}]}'))),
    ).toBe(true);
    expect(
      hasForbiddenKey(parseStrictJson(utf8('{"a":[{"b":{"constructor":1}}]}'))),
    ).toBe(false);
  });
});
