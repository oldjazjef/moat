import { CONFIG_FILE, type StoragePort } from '@moat/core';
import type {
  BundleRecord,
  ConfigRecord,
  GateRecord,
  SecretRecord,
} from '../ports/gates.ports';

/**
 * A project as the core's planning functions read it (`planBundle`): the layout of a project
 * folder (`moat.yaml`, `gates/<g>.json`, `secrets/<g>/<n>.json`, `bundles/<g>/<v>.json`) over rows
 * from the database. Read-only and in memory; only the latest bundle is passed in (that is all
 * the comparison needs).
 */
export function projectStorage(input: {
  readonly config: ConfigRecord | null;
  readonly gates: readonly GateRecord[];
  readonly secrets: readonly SecretRecord[];
  readonly latestBundles: readonly BundleRecord[];
}): StoragePort {
  const files = new Map<string, string>();
  if (input.config !== null) files.set(CONFIG_FILE, input.config.text);
  for (const gate of input.gates)
    files.set(
      `gates/${gate.name}.json`,
      JSON.stringify({
        moat: 'gate',
        v: 1,
        gateId: gate.gateId,
        boxKey: gate.boxKey,
      }),
    );
  for (const secret of input.secrets)
    files.set(`secrets/${secret.gate}/${secret.name}.json`, secret.text);
  for (const bundle of input.latestBundles)
    files.set(`bundles/${bundle.gate}/${bundle.version}.json`, bundle.text);
  return {
    read: (path) => files.get(path) ?? null,
    list: (dir) => {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const path of files.keys())
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          if (!rest.includes('/')) names.add(rest);
        }
      return [...names];
    },
  };
}
