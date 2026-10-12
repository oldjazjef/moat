import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fromBase64Url,
  openSecret,
  toBase64Url,
  verifyBundle,
  keyId,
} from '@moat/core';
import _sodium from 'libsodium-wrappers-sumo';
import type { Context } from './context';
import { run } from './main';

const PLANTED_SECRET = 'pat-eu1-PLANTED-SECRET-must-never-appear';

const yaml = `version: 1
upstreams:
  hubspot:
    origin: "https://api.hubapi.com"
    auth: { type: bearer, secret: hubspot-token }
routes:
  newsletter:
    method: POST
    path: "/newsletter"
    upstream: hubspot
    upstreamPath: "/crm/v3/objects/contacts"
`;

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function project(answers: string[]) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'moat-cli-'));
  folders.push(cwd);
  writeFileSync(path.join(cwd, 'moat.yaml'), yaml);
  const output: string[] = [];
  const context: Context = {
    cwd,
    out: (line) => output.push(line),
    err: (line) => output.push(line),
    readSecret: async () => answers.shift() ?? '',
    now: () => 1_791_792_000,
  };
  return { cwd, output, context, answers };
}

async function gateKeys() {
  await _sodium.ready;
  const pair = _sodium.crypto_box_keypair();
  const gateId = toBase64Url(_sodium.randombytes_buf(16));
  return { pair, gateId };
}

describe('moat CLI', () => {
  it('keygen → gate add → secret seal → build produces a bundle the gate accepts', async () => {
    const passphrase = 'a long test passphrase';
    const { cwd, output, context, answers } = project([passphrase, passphrase]);
    const { pair, gateId } = await gateKeys();

    expect(await run(['keygen', 'signer.moatkey'], context)).toBe(0);
    const keyFile = JSON.parse(
      readFileSync(path.join(cwd, 'signer.moatkey'), 'utf8'),
    ) as { pk: string };
    expect(
      await run(
        [
          'gate',
          'add',
          'www',
          '--gate-id',
          gateId,
          '--box-key',
          toBase64Url(pair.publicKey),
        ],
        context,
      ),
    ).toBe(0);
    answers.push(PLANTED_SECRET);
    expect(await run(['secret', 'seal', 'www', 'hubspot-token'], context)).toBe(
      0,
    );
    answers.push(passphrase);
    expect(
      await run(['build', 'www', '--key', 'signer.moatkey'], context),
    ).toBe(0);

    const envelope = readFileSync(path.join(cwd, 'bundles/www/1.json'));
    const publicKey = fromBase64Url(keyFile.pk);
    const verified = await verifyBundle(envelope, {
      gateId,
      signers: [
        { kid: await keyId('ed25519', publicKey), alg: 'ed25519', publicKey },
      ],
      threshold: 1,
      currentVersion: 0,
      now: 1_791_792_000,
      expiryEnabled: false,
    });
    const opened = await openSecret(
      verified.payload.secrets['hubspot-token'],
      pair.privateKey,
      gateId,
      'hubspot-token',
    );
    expect(new TextDecoder().decode(opened)).toBe(PLANTED_SECRET);

    // SEC-31/SEC-34: the value is nowhere in the project folder or the output.
    const files = readdirSync(cwd, {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile());
    for (const file of files) {
      expect(
        readFileSync(path.join(file.parentPath, file.name), 'utf8'),
      ).not.toContain(PLANTED_SECRET);
    }
    expect(output.join('\n')).not.toContain(PLANTED_SECRET);
    expect(output.join('\n')).not.toContain(passphrase);
  });

  it('refuses a wrong passphrase and writes no bundle', async () => {
    const { cwd, context, answers } = project([
      'a long test passphrase',
      'a long test passphrase',
    ]);
    const { pair, gateId } = await gateKeys();
    await run(['keygen', 'signer.moatkey'], context);
    await run(
      [
        'gate',
        'add',
        'www',
        '--gate-id',
        gateId,
        '--box-key',
        toBase64Url(pair.publicKey),
      ],
      context,
    );
    answers.push('value', 'wrong passphrase');
    await run(['secret', 'seal', 'www', 'hubspot-token'], context);
    expect(
      await run(['build', 'www', '--key', 'signer.moatkey'], context),
    ).toBe(1);
    expect(readdirSync(cwd)).not.toContain('bundles');
  });

  it('SEC-11: build fails when the config leaves the gate policy', async () => {
    const { cwd, output, context, answers } = project([
      'a long test passphrase',
      'a long test passphrase',
    ]);
    const { pair, gateId } = await gateKeys();
    await run(['keygen', 'signer.moatkey'], context);
    await run(
      [
        'gate',
        'add',
        'www',
        '--gate-id',
        gateId,
        '--box-key',
        toBase64Url(pair.publicKey),
      ],
      context,
    );
    answers.push('value', 'a long test passphrase');
    await run(['secret', 'seal', 'www', 'hubspot-token'], context);
    mkdirSync(path.join(cwd, 'gate'), { recursive: true });
    writeFileSync(
      path.join(cwd, 'gate/policy.json'),
      JSON.stringify({
        v: 1,
        upstreams: {},
        maxBodyBytes: 65536,
        maxResponseBytes: 1048576,
        maxTimeoutMs: 30000,
      }),
    );
    expect(
      await run(
        [
          'build',
          'www',
          '--key',
          'signer.moatkey',
          '--policy',
          'gate/policy.json',
        ],
        context,
      ),
    ).toBe(1);
    expect(output.at(-1)).toContain('policy_violation');
  });

  it('validate reports YAML errors with line and column', async () => {
    const { cwd, output, context } = project([]);
    writeFileSync(
      path.join(cwd, 'moat.yaml'),
      yaml.replace('method: POST', 'method: TRACE'),
    );
    expect(await run(['validate'], context)).toBe(1);
    expect(output.at(-1)).toMatch(/^moat: 8:13 routes\.newsletter\.method: /);
  });

  it('policy suggest prints the narrowest policy', async () => {
    const { output, context } = project([]);
    expect(await run(['policy', 'suggest'], context)).toBe(0);
    expect(JSON.parse(output.join('\n'))).toMatchObject({
      upstreams: {
        'api.hubapi.com': {
          pathPrefixes: ['/crm/v3/objects/contacts'],
          methods: ['POST'],
          secrets: ['hubspot-token'],
        },
      },
    });
  });
});
