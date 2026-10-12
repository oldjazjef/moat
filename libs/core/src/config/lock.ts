import type { MoatConfig } from './schema';

/** Where a gate stands in moat.yaml: its environment and whether it or that environment is locked. */
export interface GateLockState {
  /** The environment the gate belongs to, or null when it has none. */
  readonly environment: string | null;
  /** `gates.<gate>.enabled` is false. */
  readonly gateLocked: boolean;
  /** The gate's environment has `enabled: false`. */
  readonly environmentLocked: boolean;
  /** False when either lock applies: the next bundle for this gate carries `enabled: false`. */
  readonly enabled: boolean;
}

export function gateLockState(config: MoatConfig, gate: string): GateLockState {
  const entry = Object.hasOwn(config.gates ?? {}, gate)
    ? config.gates?.[gate]
    : undefined;
  const environment = entry?.environment ?? null;
  const environmentEntry =
    environment !== null &&
    Object.hasOwn(config.environments ?? {}, environment)
      ? config.environments?.[environment]
      : undefined;
  const gateLocked = entry?.enabled === false;
  const environmentLocked = environmentEntry?.enabled === false;
  return {
    environment,
    gateLocked,
    environmentLocked,
    enabled: !gateLocked && !environmentLocked,
  };
}
