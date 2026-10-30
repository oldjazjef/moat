import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import { historyService } from '../testing/in-memory-storage';
import { AddProjectCommand } from './add-project.command';
import { AddProjectHandler } from './add-project.handler';
import { configHash } from './config-hash';
import {
  GetConfigTextHandler,
  GetConfigTextQuery,
  ReplaceConfigCommand,
  ReplaceConfigHandler,
} from './config-text';

const YAML = `version: 1
# kept: comments are the person's
routes: {}
`;
const NEXT = `version: 1
upstreams:
  hubspot:
    origin: "https://api.hubapi.com"
routes:
  newsletter:
    method: POST
    path: "/newsletter"
    upstream: hubspot
    upstreamPath: "/contacts"
`;

async function setup() {
  const registry = new InMemoryProjectRegistry();
  const files = new InMemoryProjectFiles({
    '/sites/shop': { 'moat.yaml': YAML },
    '/sites/blank': {},
  });
  const add = new AddProjectHandler(registry);
  const shop = (await add.execute(new AddProjectCommand('/sites/shop'))).id;
  const blank = (await add.execute(new AddProjectCommand('/sites/blank'))).id;
  return {
    files,
    shop,
    blank,
    get: new GetConfigTextHandler(registry, files),
    replace: new ReplaceConfigHandler(
      registry,
      files,
      historyService(registry),
    ),
  };
}

describe('moat.yaml editor', () => {
  it('reads the text as it is, with the hash to save against', async () => {
    const { get, shop, blank } = await setup();
    expect(await get.execute(new GetConfigTextQuery(shop))).toEqual({
      text: YAML,
      hash: configHash(YAML),
    });
    expect(await get.execute(new GetConfigTextQuery(blank))).toEqual({
      text: null,
      hash: null,
    });
    expect(await get.execute(new GetConfigTextQuery('x'.repeat(22)))).toBe(
      null,
    );
  });

  it('writes a valid text against the hash it was loaded with', async () => {
    const { replace, files, shop } = await setup();
    const result = await replace.execute(
      new ReplaceConfigCommand(shop, configHash(YAML), NEXT),
    );
    expect(result).toEqual({
      status: 'saved',
      config: { text: NEXT, hash: configHash(NEXT) },
    });
    expect(files.open('/sites/shop')?.read('moat.yaml')).toBe(NEXT);
  });

  it('creates moat.yaml in a folder without one only from base null', async () => {
    const { replace, files, blank } = await setup();
    expect(
      (await replace.execute(new ReplaceConfigCommand(blank, null, NEXT)))
        .status,
    ).toBe('saved');
    expect(files.open('/sites/blank')?.read('moat.yaml')).toBe(NEXT);
  });

  it('refuses a stale base and writes nothing (lost updates)', async () => {
    const { replace, files, shop } = await setup();
    expect(
      await replace.execute(
        new ReplaceConfigCommand(shop, configHash('other'), NEXT),
      ),
    ).toEqual({ status: 'changed' });
    expect(files.open('/sites/shop')?.read('moat.yaml')).toBe(YAML);
  });

  it('refuses an invalid text with line and column, never the core message, and writes nothing (SEC-20, SEC-24)', async () => {
    const { replace, files, shop } = await setup();
    const syntax = await replace.execute(
      new ReplaceConfigCommand(
        shop,
        configHash(YAML),
        'version: 1\nroutes: [\n',
      ),
    );
    expect(syntax.status).toBe('refused');
    if (syntax.status !== 'refused') return;
    expect(syntax.code).toBe('config_invalid');
    expect(syntax.issues?.[0]?.code).toBe('syntax');
    expect(syntax.issues?.[0]?.line).toEqual(expect.any(Number));
    expect(JSON.stringify(syntax)).not.toContain('message');

    const unknown = await replace.execute(
      new ReplaceConfigCommand(
        shop,
        configHash(YAML),
        'version: 1\nscript: x\n',
      ),
    );
    expect(unknown.status === 'refused' && unknown.issues?.[0]?.code).toBe(
      'schema',
    );

    const alias = await replace.execute(
      new ReplaceConfigCommand(
        shop,
        configHash(YAML),
        'version: 1\nx: &a 1\ny: *a\n',
      ),
    );
    expect(alias.status).toBe('refused');
    expect(files.open('/sites/shop')?.read('moat.yaml')).toBe(YAML);
  });

  it('refuses a text larger than an authoring file may be', async () => {
    const { replace, shop } = await setup();
    const big = `version: 1\n# ${'x'.repeat(300 * 1024)}\n`;
    expect(
      await replace.execute(
        new ReplaceConfigCommand(shop, configHash(YAML), big),
      ),
    ).toEqual({ status: 'refused', code: 'config_too_large' });
  });
});
