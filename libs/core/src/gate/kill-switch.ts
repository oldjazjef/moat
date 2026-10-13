/**
 * The local kill switch (SEC-15, FR-33, T-23): a data file `kill` next to the gate's other data
 * files, written by `php moat-gate.php kill|revive` or by hand over FTP. It works without the
 * Cloud and without any endpoint on the gate (SEC-40), and it only ever switches things off:
 *
 * - absent: nothing is switched off;
 * - present: one entry per line, `gate` (the whole gate) or `route <name>`; blank lines and lines
 *   starting with `#` are ignored, spaces, tabs and a `\r` around a line too;
 * - anything else (a line the gate does not know, a file without the data-file marker such as an
 *   empty file uploaded by hand, a file that cannot be read): the whole gate is off (SEC-46).
 *
 * A route name that is not in the bundle switches nothing off.
 */
export const KILL_FILE = 'kill';

export type KillFile =
  | { readonly kind: 'absent' }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'present'; readonly content: string };

export interface KillSwitch {
  /** The whole gate is off: every request gets `gate_disabled`. */
  readonly gate: boolean;
  /** Routes that are off (`route_disabled`), sorted. */
  readonly routes: readonly string[];
}

const ROUTE_LINE = /^route ([a-z][a-z0-9-]{0,62})$/;
const AROUND = /^[ \t\r]+|[ \t\r]+$/g;

export function killSwitchOf(file: KillFile): KillSwitch {
  if (file.kind === 'absent') return { gate: false, routes: [] };
  if (file.kind === 'damaged') return { gate: true, routes: [] };
  let gate = false;
  const routes = new Set<string>();
  for (const raw of file.content.split('\n')) {
    const line = raw.replace(AROUND, '');
    if (line === '' || line.startsWith('#')) continue;
    if (line === 'gate') {
      gate = true;
      continue;
    }
    const route = ROUTE_LINE.exec(line)?.[1];
    if (route === undefined) return { gate: true, routes: [] };
    routes.add(route);
  }
  return { gate, routes: [...routes].sort() };
}
