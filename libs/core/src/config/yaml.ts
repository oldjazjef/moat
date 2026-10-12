import { isAlias, isNode, LineCounter, parseAllDocuments, visit } from 'yaml';
import { hasProtoKey } from '../json/strict-json';
import { moatConfigSchema, type MoatConfig } from './schema';

/** SEC-24: limits for an authoring file. */
export const MAX_YAML_BYTES = 256 * 1024;
export const MAX_YAML_DEPTH = 32;

export interface ConfigIssue {
  /** i18n key under `config.errors.*` — the UI translates, the CLI prints it with the path. */
  readonly code:
    | 'too_large'
    | 'syntax'
    | 'multiple_documents'
    | 'alias'
    | 'tag'
    | 'too_deep'
    | 'schema';
  /** Where in the document, e.g. ["routes", "newsletter", "path"]. */
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly issues: readonly ConfigIssue[]) {
    super(issues.map(formatIssue).join('\n'));
  }
}

export function formatIssue(issue: ConfigIssue): string {
  const where =
    issue.line === undefined ? '' : `${issue.line}:${issue.column ?? 1} `;
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${where}${path}${issue.message}`;
}

/**
 * Parses moat.yaml strictly (CLAUDE.md, YAML standards): YAML 1.2 core schema, unique keys, no
 * merge keys, no anchors or aliases, no tags, one document, size and depth limits — then checks
 * the result against the schema without coercion. Throws ConfigError with line and column.
 */
export function loadMoatYaml(text: string): MoatConfig {
  if (text.length > MAX_YAML_BYTES) {
    throw new ConfigError([
      {
        code: 'too_large',
        path: [],
        message: `larger than ${MAX_YAML_BYTES} bytes`,
      },
    ]);
  }
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    strict: true,
    prettyErrors: false,
    lineCounter,
  });
  if (!Array.isArray(documents) || documents.length !== 1) {
    throw new ConfigError([
      {
        code: 'multiple_documents',
        path: [],
        message: 'exactly one YAML document expected',
      },
    ]);
  }
  const [document] = documents;
  if (document === undefined)
    throw new ConfigError([
      { code: 'syntax', path: [], message: 'empty document' },
    ]);
  const at = (offset: number | undefined) => {
    if (offset === undefined) return {};
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };

  const issues: ConfigIssue[] = [];
  for (const error of [...document.errors, ...document.warnings]) {
    issues.push({
      code: 'syntax',
      path: [],
      message: error.message.split('\n')[0] ?? error.code,
      ...at(error.pos[0]),
    });
  }
  if (issues.length > 0) throw new ConfigError(issues);

  visit(document, (_key, node, path) => {
    if (isAlias(node)) {
      issues.push({
        code: 'alias',
        path: [],
        message: 'aliases are not allowed',
        ...at(node.range?.[0]),
      });
    } else if (isNode(node)) {
      if (node.anchor !== undefined) {
        issues.push({
          code: 'alias',
          path: [],
          message: 'anchors are not allowed',
          ...at(node.range?.[0]),
        });
      }
      if (node.tag !== undefined) {
        issues.push({
          code: 'tag',
          path: [],
          message: `tags are not allowed (${node.tag})`,
          ...at(node.range?.[0]),
        });
      }
      if (path.length > MAX_YAML_DEPTH * 2) {
        issues.push({
          code: 'too_deep',
          path: [],
          message: 'nested too deeply',
          ...at(node.range?.[0]),
        });
        return visit.BREAK;
      }
    }
    return undefined;
  });
  if (issues.length > 0) throw new ConfigError(issues);

  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (hasProtoKey(value)) {
    throw new ConfigError([
      {
        code: 'schema',
        path: [],
        message: 'the key "__proto__" is not allowed',
      },
    ]);
  }
  const parsed = moatConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const node = document.getIn(issue.path as (string | number)[], true);
        const range = isNode(node) ? node.range : undefined;
        return {
          code: 'schema' as const,
          path: issue.path.filter(
            (part): part is string | number => typeof part !== 'symbol',
          ),
          message: issue.message,
          ...at(range?.[0]),
        };
      }),
    );
  }
  return parsed.data;
}
