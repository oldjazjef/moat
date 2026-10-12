import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import { AddProjectCommand } from './add-project.command';
import { AddProjectHandler } from './add-project.handler';
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
  });
  return {
    registry,
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
    });
  });

  it('removes only the list entry', async () => {
    const { add, remove, registry } = setup();
    const shop = await add.execute(new AddProjectCommand('/sites/shop'));
    expect(await remove.execute(new RemoveProjectCommand(shop.id))).toBe(true);
    expect(await remove.execute(new RemoveProjectCommand(shop.id))).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});
