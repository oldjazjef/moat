import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** `<userData>/config.json`: what the desktop remembers between starts. */
export const CONFIG_FILE = 'config.json';

export interface DesktopConfig {
  /** The open project folder (DT-03), absolute; null = none chosen yet. */
  readonly projectDir: string | null;
}

const EMPTY: DesktopConfig = { projectDir: null };

/** The stored config; a missing or damaged file is an empty one (the user chooses again). */
export function readConfig(userData: string): DesktopConfig {
  try {
    const value = JSON.parse(
      readFileSync(join(userData, CONFIG_FILE), 'utf8'),
    ) as unknown;
    if (typeof value !== 'object' || value === null) return EMPTY;
    const dir = (value as Record<string, unknown>)['projectDir'];
    return {
      projectDir: typeof dir === 'string' && isAbsolute(dir) ? dir : null,
    };
  } catch {
    return EMPTY;
  }
}

/** Atomic write (temp file + rename), as everywhere in Moat. */
export function writeConfig(userData: string, config: DesktopConfig): void {
  mkdirSync(userData, { recursive: true });
  const target = join(userData, CONFIG_FILE);
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}
