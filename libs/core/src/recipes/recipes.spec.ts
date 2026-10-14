import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigEditError } from '../config/edit';
import { NEW_PROJECT_CONFIG } from '../config/template';
import { loadMoatYaml } from '../config/yaml';
import { applyRecipe, RECIPE_IDS, RECIPES } from './recipes';

const BASE = 'version: 1\nupstreams: {}\nroutes: {}\n';
const RECIPE_DIR = path.join(__dirname, '../../../../recipes');

describe('recipes (FR-43)', () => {
  it.each(RECIPE_IDS)('%s is the same as its file in recipes/', (id) => {
    const file = loadMoatYaml(
      readFileSync(path.join(RECIPE_DIR, `${id}.moat.yaml`), 'utf8'),
    );
    const applied = loadMoatYaml(applyRecipe(BASE, id));
    expect(applied.upstreams).toEqual(file.upstreams);
    expect(applied.routes).toEqual(file.routes);
  });

  it.each(RECIPE_IDS)(
    '%s names its secret and sends a JSON test body',
    (id) => {
      const recipe = RECIPES[id];
      expect(recipe.upstream.input.auth?.secret).toBe(recipe.secret);
      expect(recipe.route.input.upstream).toBe(recipe.upstream.name);
      expect(typeof JSON.parse(recipe.testBody)).toBe('object');
    },
  );

  it('keeps the comments of a new project and adds the website origin', () => {
    const text = applyRecipe(NEW_PROJECT_CONFIG, 'hubspot-newsletter', {
      origins: ['https://www.example.ch'],
    });
    expect(text).toContain('# Secrets never go into this file.');
    expect(loadMoatYaml(text).routes['newsletter']?.origins).toEqual([
      'https://www.example.ch',
    ]);
  });

  it('never changes a route or upstream that is there', () => {
    const once = applyRecipe(BASE, 'openai-chat');
    expect(() => applyRecipe(once, 'openai-chat')).toThrow(
      expect.objectContaining({ code: 'route_exists' }),
    );
    const taken = once.replace('chat:', 'talk:');
    expect(() => applyRecipe(taken, 'openai-chat')).toThrow(
      expect.objectContaining({ code: 'upstream_exists' }),
    );
  });

  it('refuses an origin that is not one', () => {
    let error: unknown;
    try {
      applyRecipe(BASE, 'hubspot-newsletter', {
        origins: ['https://www.example.ch', 'javascript:alert(1)'],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigEditError);
    expect((error as ConfigEditError).code).toBe('value_invalid');
    expect((error as ConfigEditError).fields).toContain('origins.1');
  });

  it('refuses parameters it does not know', () => {
    expect(() =>
      applyRecipe(BASE, 'hubspot-newsletter', {
        upstreamPath: '/',
      } as never),
    ).toThrow(expect.objectContaining({ code: 'value_invalid' }));
  });
});
