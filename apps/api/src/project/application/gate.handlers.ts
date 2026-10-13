import {
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  QueryHandler,
} from '@nestjs/cqrs';
import { type GatePlan, GatePlanError, planGate } from '@moat/core';
import { FileExistsError, ProjectFilesPort } from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID, type ProjectEntry } from '../project.types';
import {
  AddGateCommand,
  type AddGateResult,
  CheckGateQuery,
  type CheckGateResult,
  type GateInput,
  type GateRefusal,
} from './gate.commands';

type Planned =
  | {
      readonly status: 'ready';
      readonly entry: ProjectEntry;
      readonly plan: GatePlan;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: GateRefusal };

async function plan(
  registry: ProjectRegistryPort,
  files: ProjectFilesPort,
  id: string,
  gate: GateInput,
): Promise<Planned> {
  if (!PROJECT_ID.test(id)) return { status: 'not_found' };
  const entry = registry.get(id);
  if (entry === null) return { status: 'not_found' };
  let planned: GatePlan;
  try {
    planned = await planGate(gate);
  } catch (error) {
    if (error instanceof GatePlanError)
      return { status: 'refused', code: error.code };
    throw error;
  }
  const storage = files.open(entry.folder);
  if (storage === null) return { status: 'not_found' };
  if (storage.read(planned.path) !== null)
    return { status: 'refused', code: 'gate_exists' };
  for (const file of storage.list('gates')) {
    if (!file.endsWith('.json')) continue;
    if (pinnedGateId(storage.read(`gates/${file}`)) === planned.gateId)
      return { status: 'refused', code: 'gate_id_exists' };
  }
  return { status: 'ready', entry, plan: planned };
}

@QueryHandler(CheckGateQuery)
export class CheckGateHandler implements IQueryHandler<CheckGateQuery> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  async execute(query: CheckGateQuery): Promise<CheckGateResult> {
    const planned = await plan(this.registry, this.files, query.id, query.gate);
    if (planned.status !== 'ready') return planned;
    const { name, gateId, boxKeyId, boxKeyFingerprint } = planned.plan;
    return {
      status: 'ready',
      preview: { name, gateId, boxKeyId, boxKeyFingerprint },
    };
  }
}

@CommandHandler(AddGateCommand)
export class AddGateHandler implements ICommandHandler<AddGateCommand> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  async execute(command: AddGateCommand): Promise<AddGateResult> {
    const planned = await plan(
      this.registry,
      this.files,
      command.id,
      command.gate,
    );
    if (planned.status !== 'ready') return planned;
    // A fingerprint is public: a plain comparison is enough.
    if (planned.plan.boxKeyFingerprint !== command.fingerprint)
      return { status: 'refused', code: 'fingerprint_mismatch' };
    try {
      this.files.writeGate(
        planned.entry.folder,
        planned.plan.name,
        planned.plan.text,
      );
    } catch (error) {
      if (error instanceof FileExistsError)
        return { status: 'refused', code: 'gate_exists' };
      return { status: 'refused', code: 'not_writable' };
    }
    return { status: 'saved' };
  }
}

/** The gate id a gate file pins; null when it is not readable as one. */
function pinnedGateId(text: string | null): string | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    const gateId =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)['gateId']
        : undefined;
    return typeof gateId === 'string' ? gateId : null;
  } catch {
    return null;
  }
}
