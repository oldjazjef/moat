import { compileConfig } from '../config/compile';
import { ConfigError, loadMoatYaml } from '../config/yaml';
import type { MoatConfig } from '../config/schema';
import { MoatRejection } from '../errors';
import type { DryRunContext } from '../gate/dry-run';
import { suggestPolicy } from '../policy/policy';
import { readSealed } from './bundle-plan';
import { CONFIG_FILE, NAME_PATTERN } from './project';
import type { StoragePort } from './storage-port';

export type DryRunPlanErrorCode =
  'config_missing' | 'config_invalid' | 'gate_unknown';

export class DryRunPlanError extends Error {
  override readonly name = 'DryRunPlanError';

  constructor(readonly code: DryRunPlanErrorCode) {
    super(code);
  }
}

/**
 * What the test console (FR-42) checks a request against: the config as the next bundle would
 * carry it — for `gate`, with its lock and only the secrets sealed for it; without a gate, as if
 * every secret were sealed — and the local policy `moat policy suggest` writes for it. A gate's
 * own policy can be narrower; the console never sees it, nor any secret.
 */
export function planDryRun(
  storage: StoragePort,
  gate: string | null,
): DryRunContext {
  const text = storage.read(CONFIG_FILE);
  if (text === null) throw new DryRunPlanError('config_missing');
  let parsed: MoatConfig;
  try {
    parsed = loadMoatYaml(text);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof MoatRejection)
      throw new DryRunPlanError('config_invalid');
    throw error;
  }
  const used = [
    ...new Set(
      Object.values(parsed.upstreams).flatMap((upstream) =>
        upstream.auth ? [upstream.auth.secret] : [],
      ),
    ),
  ].sort();
  if (
    gate !== null &&
    (!NAME_PATTERN.test(gate) || storage.read(`gates/${gate}.json`) === null)
  )
    throw new DryRunPlanError('gate_unknown');
  let config;
  try {
    config = compileConfig(parsed, used, gate ?? undefined);
  } catch (error) {
    if (error instanceof MoatRejection)
      throw new DryRunPlanError('config_invalid');
    throw error;
  }
  const sealed = gate === null ? null : readSealed(storage, gate);
  return {
    config,
    policy: suggestPolicy(config),
    secrets:
      sealed === null
        ? used
        : used.filter((name) => Object.hasOwn(sealed, name)),
  };
}
