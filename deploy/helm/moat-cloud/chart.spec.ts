// Static checks of the Helm chart that need no `helm` binary: the values, their schema and the
// templates must agree. `helm lint` and kubeconform (CI) check the rendered result.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const dir = __dirname;
const values = parse(readFileSync(join(dir, 'values.yaml'), 'utf8')) as Record<
  string,
  unknown
>;
const schema = JSON.parse(
  readFileSync(join(dir, 'values.schema.json'), 'utf8'),
) as {
  properties: Record<string, { properties?: Record<string, unknown> }>;
};
const templates = readdirSync(join(dir, 'templates'))
  .filter((f) => f.endsWith('.yaml') || f.endsWith('.tpl'))
  .map((f) => readFileSync(join(dir, 'templates', f), 'utf8'));

function has(path: string[]): boolean {
  let node: unknown = values;
  for (const part of path) {
    if (typeof node !== 'object' || node === null || !(part in node))
      return false;
    node = (node as Record<string, unknown>)[part];
  }
  return true;
}

describe('moat-cloud chart', () => {
  it('declares every top-level value in the schema and the schema declares nothing else', () => {
    expect(Object.keys(schema.properties).sort()).toEqual(
      Object.keys(values).sort(),
    );
  });

  it('declares every nested value of an object section in the schema', () => {
    for (const [section, def] of Object.entries(schema.properties)) {
      if (!def.properties) continue;
      const actual = values[section];
      expect(Object.keys(def.properties).sort(), section).toEqual(
        Object.keys(actual as object).sort(),
      );
    }
  });

  it('only reads values that values.yaml defines', () => {
    const used = new Set<string>();
    for (const text of templates) {
      for (const m of text.matchAll(/\.Values\.([A-Za-z0-9_.]+)/g))
        used.add(m[1] ?? '');
    }
    expect(used.size).toBeGreaterThan(10);
    for (const path of used) expect(has(path.split('.')), path).toBe(true);
  });

  it('keeps secrets out of values.yaml: only names of existing Secrets', () => {
    const text = readFileSync(join(dir, 'values.yaml'), 'utf8');
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    expect(
      (values['secrets'] as Record<string, { name: string }>)['accountKey']
        ?.name,
    ).toBe('');
  });

  it('hardens the pod (SEC-57)', () => {
    const deployment = templates.join('\n');
    for (const needle of [
      'runAsNonRoot: true',
      'readOnlyRootFilesystem: true',
      'allowPrivilegeEscalation: false',
      'type: RuntimeDefault',
      'automountServiceAccountToken: false',
    ]) {
      expect(deployment, needle).toContain(needle);
    }
    expect(deployment).toMatch(/drop:\s+- ALL/);
  });

  it('never lets an empty egress list render and never defaults to a latest tag', () => {
    const np = readFileSync(
      join(dir, 'templates', 'networkpolicy.yaml'),
      'utf8',
    );
    expect(np).toContain('fail "networkPolicy.databaseTo');
    expect((values['image'] as { tag: string }).tag).toBe('');
  });
});
