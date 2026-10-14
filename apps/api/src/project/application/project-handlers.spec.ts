import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import { AddProjectCommand } from './add-project.command';
import { AddProjectHandler } from './add-project.handler';
import { configHash } from './config-hash';
import { EditConfigCommand } from './edit-config.command';
import { EditConfigHandler } from './edit-config.handler';
import { GetProjectHandler } from './get-project.handler';
import { GetProjectQuery } from './get-project.query';
import { ListProjectsHandler } from './list-projects.handler';
import { ListProjectsQuery } from './list-projects.query';
import { RemoveProjectCommand } from './remove-project.command';
import { RemoveProjectHandler } from './remove-project.handler';

const YAML = `version: 1
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

function setup() {
  const registry = new InMemoryProjectRegistry();
  const files = new InMemoryProjectFiles({
    '/sites/shop': { 'moat.yaml': YAML },
    '/sites/blog/': {},
    '/sites/broken': { 'moat.yaml': 'version: 1\nroutes: [\n' },
  });
  return {
    registry,
    files,
    edit: new EditConfigHandler(registry, files),
    add: new AddProjectHandler(registry),
    list: new ListProjectsHandler(registry, files),
    get: new GetProjectHandler(registry, files),
    remove: new RemoveProjectHandler(registry),
  };
}

describe('project handlers', () => {
  it('adds folders once each and lists them with their state', async () => {
    const { add, list } = setup();
    const shop = await add.execute(new AddProjectCommand('/sites/shop'));
    expect(await add.execute(new AddProjectCommand('/sites/shop'))).toEqual(
      shop,
    );
    await add.execute(new AddProjectCommand('/sites/blog/'));
    await add.execute(new AddProjectCommand('/sites/gone'));
    const summaries = await list.execute(new ListProjectsQuery());
    expect(
      summaries.map(({ name, config, routes }) => ({ name, config, routes })),
    ).toEqual([
      { name: 'shop', config: 'valid', routes: 1 },
      { name: 'blog', config: 'missing', routes: 0 },
      { name: 'gone', config: null, routes: 0 },
    ]);
  });

  it('refuses a relative folder (the main process always passes an absolute one)', async () => {
    const { add } = setup();
    await expect(
      add.execute(new AddProjectCommand('sites/shop')),
    ).rejects.toThrow();
  });

  it('answers an unknown or malformed id like a missing project', async () => {
    const { add, get } = setup();
    const shop = await add.execute(new AddProjectCommand('/sites/shop'));
    const view = await get.execute(new GetProjectQuery(shop.id));
    expect(view?.name).toBe('shop');
    expect(view?.project?.config.status).toBe('valid');
    expect(await get.execute(new GetProjectQuery('x'.repeat(22)))).toBeNull();
    expect(await get.execute(new GetProjectQuery('../../etc'))).toBeNull();
  });

  it('shows a project whose folder is gone, without its contents', async () => {
    const { add, get } = setup();
    const gone = await add.execute(new AddProjectCommand('/sites/gone'));
    expect(await get.execute(new GetProjectQuery(gone.id))).toEqual({
      id: gone.id,
      name: 'gone',
      folder: '/sites/gone',
      project: null,
      configHash: null,
    });
  });

  it('removes only the list entry', async () => {
    const { add, remove, registry } = setup();
    const shop = await add.execute(new AddProjectCommand('/sites/shop'));
    expect(await remove.execute(new RemoveProjectCommand(shop.id))).toBe(true);
    expect(await remove.execute(new RemoveProjectCommand(shop.id))).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it('reports the hash of moat.yaml, the base of the next edit', async () => {
    const { add, get } = setup();
    const shop = await add.execute(new AddProjectCommand('/sites/shop'));
    expect((await get.execute(new GetProjectQuery(shop.id)))?.configHash).toBe(
      configHash(YAML),
    );
  });
});

describe('editing moat.yaml', () => {
  async function shop() {
    const context = setup();
    const entry = await context.add.execute(
      new AddProjectCommand('/sites/shop'),
    );
    const text = () =>
      context.files.folders['/sites/shop']?.['moat.yaml'] ?? '';
    return { ...context, id: entry.id, text };
  }

  it('adds and locks an environment, keeping what was there', async () => {
    const { edit, id, text } = await shop();
    expect(
      await edit.execute(
        new EditConfigCommand(id, configHash(YAML), {
          op: 'addEnvironment',
          environment: 'production',
        }),
      ),
    ).toEqual({ status: 'saved' });
    const added = text();
    expect(added).toContain('environments:\n  production: {}');
    expect(added).toContain('upstreamPath: "/contacts"');
    await edit.execute(
      new EditConfigCommand(id, configHash(added), {
        op: 'lockEnvironment',
        environment: 'production',
      }),
    );
    expect(text()).toContain('production:\n    enabled: false');
  });

  it('assigns, moves, locks and unlocks a gate', async () => {
    const { edit, id, text } = await shop();
    const run = async (
      change: ConstructorParameters<typeof EditConfigCommand>[2],
    ) => edit.execute(new EditConfigCommand(id, configHash(text()), change));
    await run({ op: 'assignGate', gate: 'site', environment: 'staging' });
    await run({ op: 'assignGate', gate: 'site', environment: 'production' });
    expect(text()).toContain('site:\n    environment: production');
    await run({ op: 'lockGate', gate: 'site' });
    expect(text()).toContain('enabled: false');
    await run({ op: 'unlockGate', gate: 'site' });
    expect(text()).not.toContain('enabled');
  });

  it('writes nothing when moat.yaml changed since the window read it', async () => {
    const { edit, id, text } = await shop();
    const result = await edit.execute(
      new EditConfigCommand(id, configHash(`${YAML}# edited\n`), {
        op: 'lockGate',
        gate: 'site',
      }),
    );
    expect(result).toEqual({ status: 'changed' });
    expect(text()).toBe(YAML);
  });

  it('refuses unknown environments, missing or invalid configs and read-only folders', async () => {
    const { edit, id, add, files } = await shop();
    const base = configHash(YAML);
    expect(
      await edit.execute(
        new EditConfigCommand(id, base, {
          op: 'lockEnvironment',
          environment: 'nowhere',
        }),
      ),
    ).toEqual({ status: 'refused', code: 'environment_unknown' });

    const blog = await add.execute(new AddProjectCommand('/sites/blog/'));
    expect(
      await edit.execute(
        new EditConfigCommand(blog.id, base, { op: 'lockGate', gate: 'site' }),
      ),
    ).toEqual({ status: 'refused', code: 'config_missing' });

    const broken = await add.execute(new AddProjectCommand('/sites/broken'));
    const brokenText = files.folders['/sites/broken']?.['moat.yaml'] ?? '';
    expect(
      await edit.execute(
        new EditConfigCommand(broken.id, configHash(brokenText), {
          op: 'lockGate',
          gate: 'site',
        }),
      ),
    ).toEqual({ status: 'refused', code: 'config_invalid' });

    files.readOnly.add('/sites/shop');
    expect(
      await edit.execute(
        new EditConfigCommand(id, base, { op: 'lockGate', gate: 'site' }),
      ),
    ).toEqual({ status: 'refused', code: 'not_writable' });
  });

  it('answers an unknown project like a missing one', async () => {
    const { edit } = await shop();
    const change = { op: 'lockGate', gate: 'site' } as const;
    for (const id of ['x'.repeat(22), '../../etc']) {
      expect(
        await edit.execute(new EditConfigCommand(id, '0'.repeat(64), change)),
      ).toEqual({ status: 'not_found' });
    }
  });

  it('adds, changes, switches off and removes a route', async () => {
    const { edit, id, text } = await shop();
    const run = async (
      change: ConstructorParameters<typeof EditConfigCommand>[2],
    ) => edit.execute(new EditConfigCommand(id, configHash(text()), change));
    const contact = {
      method: 'POST',
      path: '/contact',
      upstream: 'hubspot',
      upstreamPath: '/notes',
    } as const;
    expect(
      await run({ op: 'addRoute', route: 'contact', definition: contact }),
    ).toEqual({ status: 'saved' });
    expect(text()).toContain('path: "/contact"');
    await run({
      op: 'updateRoute',
      route: 'contact',
      definition: { ...contact, origins: ['https://www.example.ch'] },
    });
    expect(text()).toContain('origins: ["https://www.example.ch"]');
    await run({ op: 'disableRoute', route: 'contact' });
    expect(text()).toContain('enabled: false');
    await run({ op: 'removeRoute', route: 'contact' });
    expect(text()).toBe(YAML);
  });

  it('refuses a route value the gate would refuse and names the field', async () => {
    const { edit, id, text } = await shop();
    expect(
      await edit.execute(
        new EditConfigCommand(id, configHash(YAML), {
          op: 'updateRoute',
          route: 'newsletter',
          definition: {
            method: 'POST',
            path: '/newsletter/',
            upstream: 'hubspot',
            upstreamPath: '/contacts',
          },
        }),
      ),
    ).toEqual({ status: 'refused', code: 'value_invalid', fields: ['path'] });
    expect(text()).toBe(YAML);
  });

  it('adds, changes and removes an upstream, and keeps one a route calls', async () => {
    const { edit, id, text } = await shop();
    const run = async (
      change: ConstructorParameters<typeof EditConfigCommand>[2],
    ) => edit.execute(new EditConfigCommand(id, configHash(text()), change));
    expect(
      await run({
        op: 'addUpstream',
        upstream: 'mailchimp',
        upstreamDefinition: { origin: 'https://us21.api.mailchimp.com' },
      }),
    ).toEqual({ status: 'saved' });
    expect(text()).toContain('origin: "https://us21.api.mailchimp.com"');
    await run({
      op: 'updateUpstream',
      upstream: 'mailchimp',
      upstreamDefinition: {
        origin: 'https://us21.api.mailchimp.com',
        auth: { type: 'bearer', secret: 'mailchimp-key' },
      },
    });
    expect(text()).toContain('secret: mailchimp-key');
    expect(await run({ op: 'removeUpstream', upstream: 'hubspot' })).toEqual({
      status: 'refused',
      code: 'upstream_in_use',
      fields: ['newsletter'],
    });
    await run({ op: 'removeUpstream', upstream: 'mailchimp' });
    expect(text()).toBe(YAML);
  });

  it('applies a recipe once, with the website origin (FR-43)', async () => {
    const { edit, id, text } = await shop();
    const run = async (
      change: ConstructorParameters<typeof EditConfigCommand>[2],
    ) => edit.execute(new EditConfigCommand(id, configHash(text()), change));
    expect(
      await run({
        op: 'applyRecipe',
        recipe: 'openai-chat',
        origins: ['https://www.example.ch'],
      }),
    ).toEqual({ status: 'saved' });
    expect(text()).toContain('upstreamPath: "/v1/chat/completions"');
    expect(text()).toContain('https://www.example.ch');
    const before = text();
    expect(await run({ op: 'applyRecipe', recipe: 'openai-chat' })).toEqual({
      status: 'refused',
      code: 'route_exists',
    });
    expect(
      await run({
        op: 'applyRecipe',
        recipe: 'hubspot-newsletter',
        origins: ['not an origin'],
      }),
    ).toMatchObject({ status: 'refused', code: 'route_exists' });
    expect(text()).toBe(before);
  });
});
