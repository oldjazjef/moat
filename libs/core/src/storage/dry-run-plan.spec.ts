import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../encoding/base64url';
import { dryRun } from '../gate/dry-run';
import { DryRunPlanError, planDryRun } from './dry-run-plan';
import type { StoragePort } from './storage-port';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE = JSON.stringify({
  moat: 'gate',
  v: 1,
  gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
  boxKey: toBase64Url(new Uint8Array(32).fill(7)),
});
const SEALED = JSON.stringify({
  v: 1,
  alg: 'x25519-blake2b-xchacha20poly1305',
  secretVersion: 1,
  epk: 'PLANTED-EPK',
  nonce: 'PLANTED-NONCE',
  ct: 'PLANTED-CIPHERTEXT',
});
const SIGNUP = {
  method: 'POST',
  path: '/newsletter',
  headers: { 'Content-Type': 'application/json' },
  body: '{"properties":{"email":"a@example.com","hs_lead_status":"x"},"admin":true}',
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

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof DryRunPlanError ? error.code : error;
  }
  return null;
};

describe('planDryRun (FR-42)', () => {
  it('without a gate, checks against the suggested policy as if every secret were sealed', () => {
    const result = dryRun(
      planDryRun(folder({ 'moat.yaml': RECIPE }), null),
      SIGNUP,
    );
    expect(result).toMatchObject({
      kind: 'forwarded',
      route: 'newsletter',
      call: {
        method: 'POST',
        url: 'https://api.hubapi.com/crm/v3/objects/contacts',
        // FR-13: the recipe's body fields, nothing else.
        body: '{"properties":{"email":"a@example.com"}}',
      },
    });
  });

  it('for a gate, only the secrets sealed for it count (secret_unavailable)', () => {
    const files = { 'moat.yaml': RECIPE, 'gates/www.json': GATE };
    expect(dryRun(planDryRun(folder(files), 'www'), SIGNUP)).toMatchObject({
      kind: 'refused',
      error: 'secret_unavailable',
    });
    const sealed = { ...files, 'secrets/www/hubspot-token.json': SEALED };
    expect(dryRun(planDryRun(folder(sealed), 'www'), SIGNUP).kind).toBe(
      'forwarded',
    );
  });

  it("carries the gate's lock (gate_disabled)", () => {
    const locked = `${RECIPE}\ngates:\n  www:\n    enabled: false\n`;
    const files = {
      'moat.yaml': locked,
      'gates/www.json': GATE,
      'secrets/www/hubspot-token.json': SEALED,
    };
    expect(dryRun(planDryRun(folder(files), 'www'), SIGNUP)).toMatchObject({
      kind: 'refused',
      error: 'gate_disabled',
    });
  });

  it('refuses a missing or broken config and an unknown gate', () => {
    expect(code(() => planDryRun(folder({}), null))).toBe('config_missing');
    expect(
      code(() => planDryRun(folder({ 'moat.yaml': 'version: 2\n' }), null)),
    ).toBe('config_invalid');
    expect(code(() => planDryRun(folder({ 'moat.yaml': RECIPE }), 'www'))).toBe(
      'gate_unknown',
    );
    expect(
      code(() => planDryRun(folder({ 'moat.yaml': RECIPE }), '../www')),
    ).toBe('gate_unknown');
  });
});
