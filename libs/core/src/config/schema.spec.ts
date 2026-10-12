import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moatJsonSchema } from './schema';

const FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../schema/moat.schema.json',
);

describe('schema/moat.schema.json', () => {
  it('is generated from the Zod schema (`pnpm schema` rewrites it)', () => {
    const expected = `${JSON.stringify(moatJsonSchema(), null, 2)}\n`;
    if (process.env['MOAT_WRITE_SCHEMA'] === '1') writeFileSync(FILE, expected);
    expect(readFileSync(FILE, 'utf8')).toBe(expected);
  });
});
