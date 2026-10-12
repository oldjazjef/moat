import { describe, expect, it } from 'vitest';
import { InMemoryProjectStorage } from '../testing/in-memory-project-storage';
import { GetProjectHandler } from './get-project.handler';
import { GetProjectQuery } from './get-project.query';

describe('GetProjectHandler', () => {
  it('answers "no project" while none is open', async () => {
    const handler = new GetProjectHandler(new InMemoryProjectStorage(null));
    expect(await handler.execute(new GetProjectQuery())).toEqual({
      folder: null,
      project: null,
    });
  });

  it('reads the open project folder', async () => {
    const handler = new GetProjectHandler(
      new InMemoryProjectStorage({
        'moat.yaml': 'version: 1\nupstreams: {}\nroutes: {}\n',
      }),
    );
    const view = await handler.execute(new GetProjectQuery());
    expect(view.folder).toBe('/projects/demo');
    expect(view.project?.config.status).toBe('valid');
    expect(view.project?.gates).toEqual([]);
  });
});
