import { toBase64Url } from '@moat/core';
import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import { CreateProjectCommand } from './create-project.command';
import { CreateProjectHandler } from './create-project.handler';
import { AddGateCommand, CheckGateQuery } from './gate.commands';
import { AddGateHandler, CheckGateHandler } from './gate.handlers';

const GATE = {
  name: 'www',
  gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
  boxKey: toBase64Url(new Uint8Array(32).fill(9)),
};

function setup() {
  const registry = new InMemoryProjectRegistry();
  const files = new InMemoryProjectFiles({
    '/sites/shop': { 'moat.yaml': 'version: 1\nupstreams: {}\nroutes: {}\n' },
    '/sites/new': {},
  });
  const shop = registry.add('/sites/shop');
  return {
    registry,
    files,
    shop,
    check: new CheckGateHandler(registry, files),
    add: new AddGateHandler(registry, files),
    create: new CreateProjectHandler(registry, files),
  };
}

describe('pinning a gate (SEC-32, FR-73)', () => {
  it('shows the fingerprint first and writes nothing', async () => {
    const { check, files, shop } = setup();
    const result = await check.execute(new CheckGateQuery(shop.id, GATE));
    expect(result).toMatchObject({
      status: 'ready',
      preview: { name: 'www', gateId: GATE.gateId },
    });
    expect(Object.keys(files.folders['/sites/shop'] ?? {})).toEqual([
      'moat.yaml',
    ]);
  });

  it('writes the gate file only with the fingerprint that was shown', async () => {
    const { check, add, files, shop } = setup();
    const checked = await check.execute(new CheckGateQuery(shop.id, GATE));
    if (checked.status !== 'ready') throw new Error('not ready');
    expect(
      await add.execute(new AddGateCommand(shop.id, GATE, 'MOAT-AAAA')),
    ).toEqual({ status: 'refused', code: 'fingerprint_mismatch' });
    expect(files.folders['/sites/shop']?.['gates/www.json']).toBeUndefined();

    const fingerprint = checked.preview.boxKeyFingerprint;
    expect(
      await add.execute(new AddGateCommand(shop.id, GATE, fingerprint)),
    ).toEqual({ status: 'saved' });
    expect(
      JSON.parse(files.folders['/sites/shop']?.['gates/www.json'] ?? ''),
    ).toEqual({ moat: 'gate', v: 1, gateId: GATE.gateId, boxKey: GATE.boxKey });
  });

  it('never replaces a gate: another key under the same name is refused', async () => {
    const { check, add, shop } = setup();
    const checked = await check.execute(new CheckGateQuery(shop.id, GATE));
    if (checked.status !== 'ready') throw new Error('not ready');
    const fingerprint = checked.preview.boxKeyFingerprint;
    await add.execute(new AddGateCommand(shop.id, GATE, fingerprint));
    const other = { ...GATE, boxKey: toBase64Url(new Uint8Array(32).fill(1)) };
    expect(await check.execute(new CheckGateQuery(shop.id, other))).toEqual({
      status: 'refused',
      code: 'gate_exists',
    });
    expect(
      await add.execute(new AddGateCommand(shop.id, GATE, fingerprint)),
    ).toEqual({ status: 'refused', code: 'gate_exists' });
  });

  it.each([
    [{ ...GATE, name: '../etc' }, 'name_invalid'],
    [{ ...GATE, gateId: 'x' }, 'gate_id_invalid'],
    [{ ...GATE, boxKey: 'not a key' }, 'box_key_invalid'],
  ])('refuses %o with %s', async (gate, code) => {
    const { check, add, shop } = setup();
    expect(await check.execute(new CheckGateQuery(shop.id, gate))).toEqual({
      status: 'refused',
      code,
    });
    expect(
      await add.execute(new AddGateCommand(shop.id, gate, 'MOAT-AAAA')),
    ).toEqual({ status: 'refused', code });
  });

  it('answers an unknown project like a missing one', async () => {
    const { check, add } = setup();
    const id = 'z'.repeat(22);
    expect(await check.execute(new CheckGateQuery(id, GATE))).toEqual({
      status: 'not_found',
    });
    expect(await add.execute(new AddGateCommand(id, GATE, 'x'))).toEqual({
      status: 'not_found',
    });
  });

  it('reports a folder that cannot be written', async () => {
    const { check, add, files, shop } = setup();
    const checked = await check.execute(new CheckGateQuery(shop.id, GATE));
    if (checked.status !== 'ready') throw new Error('not ready');
    files.readOnly.add('/sites/shop');
    expect(
      await add.execute(
        new AddGateCommand(shop.id, GATE, checked.preview.boxKeyFingerprint),
      ),
    ).toEqual({ status: 'refused', code: 'not_writable' });
  });
});

describe('«Neues Projekt» (FR-73)', () => {
  it('writes the new moat.yaml and lists the folder', async () => {
    const { create, files, registry } = setup();
    const result = await create.execute(new CreateProjectCommand('/sites/new'));
    expect(result.created).toBe(true);
    expect(files.folders['/sites/new']?.['moat.yaml']).toContain('version: 1');
    expect(registry.get(result.entry.id)?.folder).toBe('/sites/new');
  });

  it('keeps an existing moat.yaml as it is', async () => {
    const { create, files } = setup();
    const before = files.folders['/sites/shop']?.['moat.yaml'];
    const result = await create.execute(
      new CreateProjectCommand('/sites/shop'),
    );
    expect(result.created).toBe(false);
    expect(files.folders['/sites/shop']?.['moat.yaml']).toBe(before);
  });

  it('refuses a relative folder', async () => {
    const { create } = setup();
    await expect(
      create.execute(new CreateProjectCommand('sites/new')),
    ).rejects.toThrow();
  });
});

describe('one gate, one pinned key (SEC-32)', () => {
  it('refuses the same gate id under another name', async () => {
    const { check, add, shop } = setup();
    const checked = await check.execute(new CheckGateQuery(shop.id, GATE));
    if (checked.status !== 'ready') throw new Error('not ready');
    await add.execute(
      new AddGateCommand(shop.id, GATE, checked.preview.boxKeyFingerprint),
    );
    const again = {
      ...GATE,
      name: 'other',
      boxKey: toBase64Url(new Uint8Array(32).fill(3)),
    };
    expect(await check.execute(new CheckGateQuery(shop.id, again))).toEqual({
      status: 'refused',
      code: 'gate_id_exists',
    });
  });
});
