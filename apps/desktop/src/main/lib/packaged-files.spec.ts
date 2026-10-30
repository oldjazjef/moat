import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What electron-builder packs (`files` in electron-builder.config.cjs) must contain every file the
 * main process loads at run time. A dialog's preload that is not packed leaves its window blank,
 * and nothing else notices: the app starts, the window opens, the page is empty.
 */
const root = join(__dirname, '../../..');
const config = require(join(root, 'electron-builder.config.cjs')) as {
  files: string[];
};

const included = config.files
  .filter((pattern) => !pattern.startsWith('!'))
  .map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')}$`,
      ),
  );
const packed = (file: string): boolean =>
  included.some((pattern) => pattern.test(file));

const mainSources = join(root, 'src/main');
const used = (pattern: RegExp): string[] => {
  const found = new Set<string>();
  for (const name of readdirSync(mainSources).filter((n) =>
    n.endsWith('.ts'),
  )) {
    const text = readFileSync(join(mainSources, name), 'utf8');
    for (const match of text.matchAll(pattern)) found.add(match[1] as string);
  }
  return [...found];
};

describe('packaged files', () => {
  it('pack every preload script a window loads', () => {
    const preloads = used(/preload: '([\w-]+\.js)'/g);
    expect(preloads.length).toBeGreaterThan(5);
    for (const file of preloads) expect(packed(file), file).toBe(true);
  });

  it('pack every dialog page a window loads', () => {
    const pages = used(/page: '(dialogs\/[\w-]+\.html)'/g);
    expect(pages.length).toBeGreaterThan(5);
    for (const file of pages) expect(packed(file), file).toBe(true);
  });
});
