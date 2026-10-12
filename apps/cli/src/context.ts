import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

/** Everything a command touches outside itself — swapped for a temporary folder in tests. */
export interface Context {
  /** The project folder (DT-03, DT-14): moat.yaml, gates/, secrets/, bundles/. */
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** A secret value: piped stdin or a hidden prompt. Never an argument (shell history). */
  readonly readSecret: (prompt: string) => Promise<string>;
  /** Seconds since the epoch. */
  readonly now: () => number;
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function resolve(context: Context, file: string): string {
  return path.resolve(context.cwd, file);
}

export function readText(context: Context, file: string): string {
  return readFileSync(resolve(context, file), 'utf8');
}

export function readJson(context: Context, file: string): unknown {
  return JSON.parse(readText(context, file)) as unknown;
}

export function exists(context: Context, file: string): boolean {
  return existsSync(resolve(context, file));
}

export function list(context: Context, dir: string): string[] {
  return exists(context, dir) ? readdirSync(resolve(context, dir)) : [];
}

/** Atomic write (temp file + rename), optionally refusing to replace an existing file. */
export function writeFile(
  context: Context,
  file: string,
  content: string,
  options: { overwrite?: boolean; mode?: number } = {},
): string {
  const target = resolve(context, file);
  if (!options.overwrite && existsSync(target))
    throw new UsageError(`${file} already exists`);
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode: options.mode ?? 0o644 });
  renameSync(temp, target);
  return target;
}
