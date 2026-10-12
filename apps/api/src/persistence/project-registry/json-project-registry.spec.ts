import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../config/env';
import { JsonProjectRegistry, REGISTRY_FILE } from './json-project-registry';

describe('JsonProjectRegistry', () => {
  let dir: string;
  let registry: JsonProjectRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'moat-registry-'));
    registry = new JsonProjectRegistry({
      get: () => join(dir, 'data'),
    } as unknown as ConfigService<Env, true>);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts empty, adds each folder once with a random id, removes entries', () => {
    expect(registry.list()).toEqual([]);
    const shop = registry.add('/sites/shop');
    expect(shop.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(registry.add('/sites/shop')).toEqual(shop);
    const blog = registry.add('/sites/blog');
    expect(blog.id).not.toBe(shop.id);
    expect(registry.list()).toEqual([shop, blog]);
    expect(registry.get(blog.id)).toEqual(blog);
    expect(registry.remove(shop.id)).toBe(true);
    expect(registry.remove(shop.id)).toBe(false);
    expect(registry.list()).toEqual([blog]);
  });

  it('writes the file for the owner only', () => {
    registry.add('/sites/shop');
    const file = join(dir, 'data', REGISTRY_FILE);
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('reads a damaged file as empty and skips malformed entries', () => {
    registry.add('/sites/shop');
    const file = join(dir, 'data', REGISTRY_FILE);
    writeFileSync(file, '{');
    expect(registry.list()).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        projects: [
          { id: 'A'.repeat(22), folder: '/ok' },
          { id: 'A'.repeat(22), folder: '/duplicate-id' },
          { id: '../x', folder: '/bad-id' },
          { id: 'B'.repeat(22), folder: 'relative' },
          { id: 'C'.repeat(22), folder: 42 },
          null,
        ],
      }),
    );
    expect(registry.list()).toEqual([{ id: 'A'.repeat(22), folder: '/ok' }]);
  });

  it('keeps a damaged list aside instead of overwriting it', () => {
    const file = join(dir, 'data', REGISTRY_FILE);
    registry.add('/sites/shop');
    writeFileSync(file, '{ not json');
    registry.add('/sites/blog');
    expect(registry.list().map((entry) => entry.folder)).toEqual([
      '/sites/blog',
    ]);
    const kept = readdirSync(join(dir, 'data')).filter((name) =>
      name.startsWith(`${REGISTRY_FILE}.damaged-`),
    );
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dir, 'data', kept[0] ?? ''), 'utf8')).toBe(
      '{ not json',
    );
  });
});
