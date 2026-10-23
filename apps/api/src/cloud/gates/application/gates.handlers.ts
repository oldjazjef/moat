import { createHash, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  QueryHandler,
} from '@nestjs/cqrs';
import {
  BundlePlanError,
  buildBundlePayload,
  canonicalJson,
  ConfigEditError,
  ConfigError,
  fingerprint,
  fromBase64UrlLength,
  GatePlanError,
  keyId,
  loadMoatYaml,
  MAX_ENVELOPE_BYTES,
  MoatRejection,
  pinnedSignerOf,
  planBundle,
  planGate,
  SEALED_SECRET_ALG,
  signBundle,
  toBase64Url,
  verifyBundle,
  type BundlePlan,
  type JsonValue,
  type StoragePort,
} from '@moat/core';
import { applyConfigEdit } from '../../../project/application/apply-config-edit';
import { configHash } from '../../../project/application/config-hash';
import type { Env } from '../../../config/env';
import { AuditTrail } from '../../audit/application/audit-trail';
import { Clock, ID_PATTERN, iso } from '../../common/clock';
import { can, type Action } from '../../tenancy/domain/permissions';
import {
  OrganisationRepositoryPort,
  OrgProjectRepositoryPort,
} from '../../tenancy/ports/tenancy.ports';
import { projectStorage } from '../domain/project-storage';
import { CloudProjectStorePort, type GateRecord } from '../ports/gates.ports';
import { CloudSigner } from './cloud-signer';
import {
  AddGateCommand,
  type AddGateResult,
  CreatePullAddressCommand,
  EditConfigCommand,
  type ConfigView,
  GetConfigQuery,
  type GetConfigResult,
  type GateView,
  ListGatesQuery,
  type ListGatesResult,
  ListSecretsQuery,
  type ListSecretsResult,
  PreviewReleaseQuery,
  type PreviewReleaseResult,
  PullBundleQuery,
  type PullAddressResult,
  PutSecretCommand,
  type PutSecretResult,
  ReleaseCommand,
  RemoveGateCommand,
  type RemoveGateResult,
  type ReleaseResult,
  type SaveConfigResult,
  SetConfigCommand,
  UploadBundleCommand,
  type UploadBundleResult,
} from './gates.commands';

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_CONFIG_BYTES = 262_144;

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The tenant check every handler starts with (SEC-50, SEC-52): the caller's membership and the
 * project inside that organisation — anything else is `not_found`, a member without the right is
 * `forbidden`. A malformed id never reaches the database.
 */
async function guard(
  organisations: OrganisationRepositoryPort,
  projects: OrgProjectRepositoryPort,
  actorId: string,
  organisationId: string,
  projectId: string,
  action: Action,
): Promise<'not_found' | 'forbidden' | 'ok'> {
  if (!ID_PATTERN.test(organisationId) || !ID_PATTERN.test(projectId))
    return 'not_found';
  const member = await organisations.membership(organisationId, actorId);
  if (member === null) return 'not_found';
  if ((await projects.find(organisationId, projectId)) === null)
    return 'not_found';
  return can(member.role, member.releaseGranted, action) ? 'ok' : 'forbidden';
}

const failure = (access: 'not_found' | 'forbidden') => ({
  status: access,
});

function configView(
  record: { text: string; revision: number } | null,
): ConfigView {
  return record === null
    ? { text: null, revision: 0, hash: null }
    : {
        text: record.text,
        revision: record.revision,
        hash: configHash(record.text),
      };
}

class Guarded {
  constructor(
    protected readonly organisations: OrganisationRepositoryPort,
    protected readonly projects: OrgProjectRepositoryPort,
  ) {}

  protected guard(
    actorId: string,
    organisationId: string,
    projectId: string,
    action: Action,
  ) {
    return guard(
      this.organisations,
      this.projects,
      actorId,
      organisationId,
      projectId,
      action,
    );
  }
}

// ── Config ─────────────────────────────────────────────────────────────────────────────────

@QueryHandler(GetConfigQuery)
export class GetConfigHandler
  extends Guarded
  implements IQueryHandler<GetConfigQuery>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    private readonly store: CloudProjectStorePort,
  ) {
    super(organisations, projects);
  }

  async execute(query: GetConfigQuery): Promise<GetConfigResult> {
    const access = await this.guard(
      query.actorId,
      query.organisationId,
      query.projectId,
      'config:read',
    );
    if (access !== 'ok') return failure(access);
    return {
      status: 'ok',
      ...configView(await this.store.getConfig(query.projectId)),
    };
  }
}

/** Parses moat.yaml as the gate would; null when it is fine. */
function configProblem(text: string): 'config_invalid' | null {
  try {
    loadMoatYaml(text);
    return null;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof MoatRejection)
      return 'config_invalid';
    throw error;
  }
}

// Subclasses repeat the constructor: Nest reads the parameter types from the decorated class only.
abstract class ConfigWriter extends Guarded {
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    protected readonly store: CloudProjectStorePort,
    protected readonly clock: Clock,
    protected readonly audit: AuditTrail,
  ) {
    super(organisations, projects);
  }

  /** Writes `next` over the revision that `current` was read at. */
  protected async write(
    actorId: string,
    organisationId: string,
    projectId: string,
    current: { text: string; revision: number } | null,
    next: string,
    op: string,
  ): Promise<SaveConfigResult> {
    if (Buffer.byteLength(next, 'utf8') > MAX_CONFIG_BYTES)
      return { status: 'refused', code: 'config_too_large' };
    const revision = current?.revision ?? 0;
    const outcome = await this.store.setConfig(
      projectId,
      next,
      revision,
      iso(this.clock.now()),
    );
    if (outcome === 'conflict') return { status: 'changed' };
    await this.audit.record(organisationId, actorId, {
      action: 'config.edit',
      target: projectId,
      details: { op },
    });
    return {
      status: 'ok',
      ...configView({ text: next, revision: revision + 1 }),
    };
  }
}

@CommandHandler(SetConfigCommand)
export class SetConfigHandler
  extends ConfigWriter
  implements ICommandHandler<SetConfigCommand>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    store: CloudProjectStorePort,
    clock: Clock,
    audit: AuditTrail,
  ) {
    super(organisations, projects, store, clock, audit);
  }

  async execute(command: SetConfigCommand): Promise<SaveConfigResult> {
    const access = await this.guard(
      command.actorId,
      command.organisationId,
      command.projectId,
      'config:write',
    );
    if (access !== 'ok') return failure(access);
    const current = await this.store.getConfig(command.projectId);
    // `base` is the hash the caller saw (null: it saw no config).
    if ((current === null ? null : configHash(current.text)) !== command.base)
      return { status: 'changed' };
    if (Buffer.byteLength(command.text, 'utf8') > MAX_CONFIG_BYTES)
      return { status: 'refused', code: 'config_too_large' };
    const problem = configProblem(command.text);
    if (problem !== null) return { status: 'refused', code: problem };
    if (current !== null && current.text === command.text)
      return { status: 'ok', ...configView(current) };
    return this.write(
      command.actorId,
      command.organisationId,
      command.projectId,
      current,
      command.text,
      'replace',
    );
  }
}

@CommandHandler(EditConfigCommand)
export class EditConfigHandler
  extends ConfigWriter
  implements ICommandHandler<EditConfigCommand>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    store: CloudProjectStorePort,
    clock: Clock,
    audit: AuditTrail,
  ) {
    super(organisations, projects, store, clock, audit);
  }

  async execute(command: EditConfigCommand): Promise<SaveConfigResult> {
    const access = await this.guard(
      command.actorId,
      command.organisationId,
      command.projectId,
      'config:write',
    );
    if (access !== 'ok') return failure(access);
    const current = await this.store.getConfig(command.projectId);
    if (current === null) return { status: 'refused', code: 'config_missing' };
    if (configHash(current.text) !== command.base) return { status: 'changed' };
    let next: string;
    try {
      next = applyConfigEdit(current.text, command.edit);
    } catch (error) {
      if (error instanceof ConfigEditError)
        return error.code === 'value_invalid' ||
          error.code === 'upstream_in_use'
          ? { status: 'refused', code: error.code, fields: error.fields }
          : { status: 'refused', code: error.code };
      if (error instanceof ConfigError)
        return { status: 'refused', code: 'config_invalid' };
      throw error;
    }
    if (next === current.text) return { status: 'ok', ...configView(current) };
    return this.write(
      command.actorId,
      command.organisationId,
      command.projectId,
      current,
      next,
      command.edit.op,
    );
  }
}

// ── Gates ──────────────────────────────────────────────────────────────────────────────────

async function boxFingerprint(boxKey: string): Promise<string> {
  return fingerprint('x25519', fromBase64UrlLength(boxKey, 32));
}

async function gateView(
  gate: GateRecord,
  signerFingerprint: string | null,
  latestVersion: number,
): Promise<GateView> {
  return {
    name: gate.name,
    gateId: gate.gateId,
    boxKey: gate.boxKey,
    mode: gate.mode,
    boxKeyFingerprint: await boxFingerprint(gate.boxKey),
    signerFingerprint:
      gate.mode === 'managed'
        ? signerFingerprint
        : await fingerprint(
            'ed25519',
            fromBase64UrlLength(gate.signerKey ?? '', 32),
          ),
    hasPullAddress: gate.pullTokenHash !== null,
    latestVersion,
    createdAt: gate.createdAt,
  };
}

@QueryHandler(ListGatesQuery)
export class ListGatesHandler
  extends Guarded
  implements IQueryHandler<ListGatesQuery>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    private readonly store: CloudProjectStorePort,
    private readonly signer: CloudSigner,
  ) {
    super(organisations, projects);
  }

  async execute(query: ListGatesQuery): Promise<ListGatesResult> {
    const access = await this.guard(
      query.actorId,
      query.organisationId,
      query.projectId,
      'config:read',
    );
    if (access !== 'ok') return failure(access);
    const info = this.signer.info();
    const gates: GateView[] = [];
    for (const gate of await this.store.listGates(query.projectId))
      gates.push(
        await gateView(
          gate,
          info?.fingerprint ?? null,
          (await this.store.latestBundle(query.projectId, gate.name))
            ?.version ?? 0,
        ),
      );
    return { status: 'ok', gates, signer: info };
  }
}

@CommandHandler(AddGateCommand)
export class AddGateHandler
  extends Guarded
  implements ICommandHandler<AddGateCommand>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    private readonly store: CloudProjectStorePort,
    private readonly signer: CloudSigner,
    private readonly clock: Clock,
    private readonly audit: AuditTrail,
  ) {
    super(organisations, projects);
  }

  async execute(command: AddGateCommand): Promise<AddGateResult> {
    const access = await this.guard(
      command.actorId,
      command.organisationId,
      command.projectId,
      'gate:manage',
    );
    if (access !== 'ok') return failure(access);
    let plan;
    try {
      plan = await planGate({
        name: command.name,
        gateId: command.gateId,
        boxKey: command.boxKey,
      });
    } catch (error) {
      if (error instanceof GatePlanError)
        return { status: 'refused', code: error.code };
      throw error;
    }
    // SEC-32: what the person compared with the gate's own display must be what is stored.
    if (command.fingerprint.trim() !== plan.boxKeyFingerprint)
      return { status: 'refused', code: 'fingerprint_mismatch' };
    let signerKid: string | null = null;
    if (command.signerKey !== null) {
      try {
        signerKid = await keyId(
          'ed25519',
          fromBase64UrlLength(command.signerKey, 32),
        );
      } catch (error) {
        if (error instanceof MoatRejection)
          return { status: 'refused', code: 'signer_key_invalid' };
        throw error;
      }
    } else if (!this.signer.available) {
      return { status: 'refused', code: 'managed_unavailable' };
    }
    const record: GateRecord = {
      projectId: command.projectId,
      name: plan.name,
      gateId: plan.gateId,
      boxKey: plan.boxKey,
      mode: command.signerKey === null ? 'managed' : 'signed',
      signerKid,
      signerKey: command.signerKey,
      pullTokenHash: null,
      createdAt: iso(this.clock.now()),
    };
    const outcome = await this.store.addGate(record);
    if (outcome === 'exists') return { status: 'refused', code: 'gate_exists' };
    if (outcome === 'limit') return { status: 'refused', code: 'gate_limit' };
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'gate.add',
      target: command.projectId,
      details: { gate: record.name, mode: record.mode },
    });
    return {
      status: 'ok',
      gate: await gateView(record, this.signer.info()?.fingerprint ?? null, 0),
    };
  }
}

@CommandHandler(RemoveGateCommand)
export class RemoveGateHandler
  extends Guarded
  implements ICommandHandler<RemoveGateCommand>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    private readonly store: CloudProjectStorePort,
    private readonly audit: AuditTrail,
  ) {
    super(organisations, projects);
  }

  async execute(command: RemoveGateCommand): Promise<RemoveGateResult> {
    const access = await this.guard(
      command.actorId,
      command.organisationId,
      command.projectId,
      'gate:manage',
    );
    if (access !== 'ok') return failure(access);
    if (!NAME.test(command.gate)) return failure('not_found');
    if (!(await this.store.removeGate(command.projectId, command.gate)))
      return failure('not_found');
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'gate.remove',
      target: command.projectId,
      details: { gate: command.gate },
    });
    return { status: 'ok' };
  }
}

@CommandHandler(CreatePullAddressCommand)
export class CreatePullAddressHandler
  extends Guarded
  implements ICommandHandler<CreatePullAddressCommand>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    private readonly store: CloudProjectStorePort,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditTrail,
  ) {
    super(organisations, projects);
  }

  async execute(command: CreatePullAddressCommand): Promise<PullAddressResult> {
    const access = await this.guard(
      command.actorId,
      command.organisationId,
      command.projectId,
      'gate:manage',
    );
    if (access !== 'ok') return failure(access);
    if (!NAME.test(command.gate)) return failure('not_found');
    if ((await this.store.findGate(command.projectId, command.gate)) === null)
      return failure('not_found');
    // 256 random bits: nothing to guess. Only the hash is kept; the old address stops working.
    const token = toBase64Url(randomBytes(32));
    await this.store.setPullTokenHash(
      command.projectId,
      command.gate,
      sha256(token),
    );
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'gate.pull_token',
      target: command.projectId,
      details: { gate: command.gate },
    });
    const origin = this.config.get('MOAT_PUBLIC_ORIGIN', { infer: true });
    return { status: 'ok', url: `${origin}/api/pull/${token}` };
  }
}

// ── Secrets ────────────────────────────────────────────────────────────────────────────────

@QueryHandler(ListSecretsQuery)
export class ListSecretsHandler
  extends Guarded
  implements IQueryHandler<ListSecretsQuery>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    private readonly store: CloudProjectStorePort,
  ) {
    super(organisations, projects);
  }

  async execute(query: ListSecretsQuery): Promise<ListSecretsResult> {
    const access = await this.guard(
      query.actorId,
      query.organisationId,
      query.projectId,
      'config:read',
    );
    if (access !== 'ok') return failure(access);
    if (!NAME.test(query.gate)) return failure('not_found');
    if ((await this.store.findGate(query.projectId, query.gate)) === null)
      return failure('not_found');
    // Names and versions only: the ciphertext is never returned.
    const secrets = await this.store.listSecrets(query.projectId, query.gate);
    return {
      status: 'ok',
      secrets: secrets.map(({ name, secretVersion, updatedAt }) => ({
        name,
        secretVersion,
        updatedAt,
      })),
    };
  }
}

const B64_43 = /^[A-Za-z0-9_-]{43}$/;
const B64_32 = /^[A-Za-z0-9_-]{32}$/;
const CT = /^[A-Za-z0-9_-]{22,21846}$/;

@CommandHandler(PutSecretCommand)
export class PutSecretHandler
  extends Guarded
  implements ICommandHandler<PutSecretCommand>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    private readonly store: CloudProjectStorePort,
    private readonly clock: Clock,
    private readonly audit: AuditTrail,
  ) {
    super(organisations, projects);
  }

  async execute(command: PutSecretCommand): Promise<PutSecretResult> {
    const access = await this.guard(
      command.actorId,
      command.organisationId,
      command.projectId,
      'secret:write',
    );
    if (access !== 'ok') return failure(access);
    if (!NAME.test(command.gate)) return failure('not_found');
    if ((await this.store.findGate(command.projectId, command.gate)) === null)
      return failure('not_found');
    if (!NAME.test(command.name))
      return { status: 'refused', code: 'name_invalid' };
    const s = command.sealed;
    // Shape only: the Cloud has no key to open it (SEC-31) and so cannot tell a sealed secret from
    // other bytes — which is why the CLI and Moat Desktop seal it, and this checks what it can.
    if (
      s.v !== 1 ||
      s.alg !== SEALED_SECRET_ALG ||
      !Number.isSafeInteger(s.secretVersion) ||
      s.secretVersion < 1 ||
      s.secretVersion > 999_999_999 ||
      !B64_43.test(s.epk) ||
      !B64_32.test(s.nonce) ||
      !CT.test(s.ct)
    )
      return { status: 'refused', code: 'secret_invalid' };
    const text = JSON.stringify({
      v: 1,
      alg: s.alg,
      secretVersion: s.secretVersion,
      epk: s.epk,
      nonce: s.nonce,
      ct: s.ct,
    });
    const at = iso(this.clock.now());
    const outcome = await this.store.putSecret({
      projectId: command.projectId,
      gate: command.gate,
      name: command.name,
      secretVersion: s.secretVersion,
      text,
      updatedAt: at,
    });
    if (outcome === 'stale')
      return { status: 'refused', code: 'version_stale' };
    if (outcome === 'limit') return { status: 'refused', code: 'secret_limit' };
    if (outcome === 'no_gate') return failure('not_found');
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'secret.set',
      target: command.projectId,
      details: {
        gate: command.gate,
        name: command.name,
        secretVersion: s.secretVersion,
      },
    });
    return {
      status: 'ok',
      secret: {
        name: command.name,
        secretVersion: s.secretVersion,
        updatedAt: at,
      },
    };
  }
}

// ── Releases ───────────────────────────────────────────────────────────────────────────────

/** Binds a confirmation to exactly one bundle (as Moat Desktop's signing dialog does). */
function releaseDigest(plan: BundlePlan): string {
  return sha256(
    canonicalJson({
      gateId: plan.gateId,
      version: plan.version,
      config: plan.config,
      secrets: plan.secrets,
      changes: plan.changes,
      previous: plan.previous,
    } as unknown as JsonValue),
  );
}

abstract class ReleasePlanner extends Guarded {
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    protected readonly store: CloudProjectStorePort,
    protected readonly signer: CloudSigner,
  ) {
    super(organisations, projects);
  }

  /** The project as the core reads a folder, with the gate's latest bundle only. */
  protected async storage(
    projectId: string,
    gate: GateRecord,
  ): Promise<StoragePort> {
    const latest = await this.store.latestBundle(projectId, gate.name);
    return projectStorage({
      config: await this.store.getConfig(projectId),
      gates: [gate],
      secrets: await this.store.listSecrets(projectId, gate.name),
      latestBundles: latest === null ? [] : [latest],
    });
  }

  /** The plan of a managed gate's next bundle, or the reason there is none. */
  protected async plan(
    projectId: string,
    gate: GateRecord,
  ): Promise<
    | { readonly status: 'planned'; readonly plan: BundlePlan }
    | {
        readonly status: 'refused';
        readonly code: string;
        readonly secrets?: readonly string[];
      }
  > {
    if (gate.mode !== 'managed')
      return { status: 'refused', code: 'not_managed' };
    const signers = this.signer.planSigners();
    if (signers.length === 0)
      return { status: 'refused', code: 'managed_unavailable' };
    try {
      const storage = await this.storage(projectId, gate);
      // The last bundle may have been signed by the key that was retired since: try each key in
      // turn, and settle for the comparison against the first one that recognises it.
      let plan: BundlePlan | null = null;
      for (const signer of signers) {
        plan = await planBundle(storage, gate.name, signer);
        if (plan.previous !== 'unverified') break;
      }
      return { status: 'planned', plan: plan as BundlePlan };
    } catch (error) {
      if (error instanceof BundlePlanError)
        return { status: 'refused', code: error.code, secrets: error.secrets };
      throw error;
    }
  }
}

@QueryHandler(PreviewReleaseQuery)
export class PreviewReleaseHandler
  extends ReleasePlanner
  implements IQueryHandler<PreviewReleaseQuery>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    store: CloudProjectStorePort,
    signer: CloudSigner,
  ) {
    super(organisations, projects, store, signer);
  }

  async execute(query: PreviewReleaseQuery): Promise<PreviewReleaseResult> {
    const access = await this.guard(
      query.actorId,
      query.organisationId,
      query.projectId,
      'config:read',
    );
    if (access !== 'ok') return failure(access);
    if (!NAME.test(query.gate)) return failure('not_found');
    const gate = await this.store.findGate(query.projectId, query.gate);
    if (gate === null) return failure('not_found');
    const planned = await this.plan(query.projectId, gate);
    if (planned.status === 'refused')
      return refusal(planned.code, planned.secrets);
    const { plan } = planned;
    return {
      status: 'ok',
      preview: {
        gate: plan.gate,
        version: plan.version,
        previousVersion: plan.previousVersion,
        locked: plan.locked,
        changes: plan.changes,
        digest: releaseDigest(plan),
      },
    };
  }
}

function refusal(
  code: string,
  secrets: readonly string[] | undefined,
): PreviewReleaseResult & ReleaseResult {
  return {
    status: 'refused',
    code: code as never,
    ...(code === 'secrets_missing' ? { secrets: secrets ?? [] } : {}),
  } as never;
}

@CommandHandler(ReleaseCommand)
export class ReleaseHandler
  extends ReleasePlanner
  implements ICommandHandler<ReleaseCommand>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    store: CloudProjectStorePort,
    signer: CloudSigner,
    private readonly clock: Clock,
    private readonly audit: AuditTrail,
  ) {
    super(organisations, projects, store, signer);
  }

  async execute(command: ReleaseCommand): Promise<ReleaseResult> {
    // The separate sign/release permission (SEC-52): not a role's, a flag an Owner grants.
    const access = await this.guard(
      command.actorId,
      command.organisationId,
      command.projectId,
      'release',
    );
    if (access !== 'ok') return failure(access);
    if (!NAME.test(command.gate)) return failure('not_found');
    const gate = await this.store.findGate(command.projectId, command.gate);
    if (gate === null) return failure('not_found');
    const planned = await this.plan(command.projectId, gate);
    if (planned.status === 'refused')
      return refusal(planned.code, planned.secrets);
    const { plan } = planned;
    // Sign nothing but what the person confirmed.
    if (releaseDigest(plan) !== command.digest) return { status: 'changed' };

    const planSigner = this.signer.planSigner();
    if (planSigner === null) return refusal('managed_unavailable', undefined);
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const envelope = await this.signer.withSigner((key) =>
      signBundle(
        buildBundlePayload({
          config: plan.source,
          gate: plan.gate,
          gateId: plan.gateId,
          secrets: plan.secrets,
          version: plan.version,
          issuedAt: now,
        }),
        [key],
      ),
    );
    if (envelope === null) return refusal('managed_unavailable', undefined);
    // Verified exactly as the gate verifies it, before anything is stored (fail closed, SEC-46).
    const verified = await verifyBundle(new TextEncoder().encode(envelope), {
      gateId: plan.gateId,
      signers: [pinnedSignerOf(planSigner)],
      threshold: 1,
      currentVersion: plan.version - 1,
      now,
      expiryEnabled: false,
    });
    if (verified.payload.version !== plan.version)
      throw new Error('The signed bundle does not carry the planned version');

    const digest = sha256(envelope);
    const outcome = await this.store.addBundle({
      projectId: command.projectId,
      gate: command.gate,
      version: plan.version,
      digest,
      text: envelope,
      createdAt: iso(this.clock.now()),
    });
    if (outcome === 'exists') return { status: 'changed' };
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'bundle.sign',
      target: command.projectId,
      details: {
        gate: command.gate,
        version: plan.version,
        sha256: digest,
        kid: planSigner.kid,
      },
    });
    return {
      status: 'ok',
      version: plan.version,
      kid: planSigner.kid,
      sha256: digest,
    };
  }
}

@CommandHandler(UploadBundleCommand)
export class UploadBundleHandler
  extends Guarded
  implements ICommandHandler<UploadBundleCommand>
{
  constructor(
    organisations: OrganisationRepositoryPort,
    projects: OrgProjectRepositoryPort,
    private readonly store: CloudProjectStorePort,
    private readonly clock: Clock,
    private readonly audit: AuditTrail,
  ) {
    super(organisations, projects);
  }

  async execute(command: UploadBundleCommand): Promise<UploadBundleResult> {
    const access = await this.guard(
      command.actorId,
      command.organisationId,
      command.projectId,
      'release',
    );
    if (access !== 'ok') return failure(access);
    if (!NAME.test(command.gate)) return failure('not_found');
    const gate = await this.store.findGate(command.projectId, command.gate);
    if (gate === null) return failure('not_found');
    // Moat Cloud has no key for a gate whose customer pinned their own (SEC-02): it only stores.
    if (
      gate.mode !== 'signed' ||
      gate.signerKey === null ||
      gate.signerKid === null
    )
      return { status: 'refused', code: 'not_signed' };
    const bytes = new TextEncoder().encode(command.envelope);
    if (bytes.length > MAX_ENVELOPE_BYTES)
      return { status: 'refused', code: 'bundle_invalid' };
    const latest = await this.store.latestBundle(command.projectId, gate.name);
    let version: number;
    try {
      const verified = await verifyBundle(bytes, {
        gateId: gate.gateId,
        signers: [
          {
            kid: gate.signerKid,
            alg: 'ed25519',
            publicKey: fromBase64UrlLength(gate.signerKey, 32),
          },
        ],
        threshold: 1,
        currentVersion: latest?.version ?? 0,
        now: Math.floor(this.clock.now().getTime() / 1000),
        expiryEnabled: false,
      });
      version = verified.payload.version;
    } catch (error) {
      if (error instanceof MoatRejection)
        return { status: 'refused', code: 'bundle_invalid' };
      throw error;
    }
    const digest = sha256(command.envelope);
    const outcome = await this.store.addBundle({
      projectId: command.projectId,
      gate: gate.name,
      version,
      digest,
      text: command.envelope,
      createdAt: iso(this.clock.now()),
    });
    if (outcome === 'exists') return { status: 'changed' };
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'bundle.upload',
      target: command.projectId,
      details: {
        gate: gate.name,
        version,
        sha256: digest,
        kid: gate.signerKid,
      },
    });
    return { status: 'ok', version, sha256: digest };
  }
}

/** What the gate's lazy pull fetches: no session, the address is the credential. */
@QueryHandler(PullBundleQuery)
export class PullBundleHandler implements IQueryHandler<PullBundleQuery> {
  constructor(private readonly store: CloudProjectStorePort) {}

  async execute(query: PullBundleQuery): Promise<string | null> {
    if (!B64_43.test(query.token)) return null;
    const gate = await this.store.findGateByPullTokenHash(sha256(query.token));
    if (gate === null) return null;
    // The bytes as signed: the gate verifies them, so this serves nothing it could not check.
    return (
      (await this.store.latestBundle(gate.projectId, gate.name))?.text ?? null
    );
  }
}

export const GATES_HANDLERS = [
  GetConfigHandler,
  SetConfigHandler,
  EditConfigHandler,
  ListGatesHandler,
  AddGateHandler,
  RemoveGateHandler,
  CreatePullAddressHandler,
  ListSecretsHandler,
  PutSecretHandler,
  PreviewReleaseHandler,
  ReleaseHandler,
  UploadBundleHandler,
  PullBundleHandler,
];
