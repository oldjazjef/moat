import type { AuditRow } from '@moat/core';
import {
  type AddBundleOutcome,
  type AddGateOutcome,
  type BundleRecord,
  CloudProjectStorePort,
  type ConfigRecord,
  type GateRecord,
  MAX_GATES,
  MAX_SECRETS,
  type PutSecretOutcome,
  type SecretRecord,
  type SetConfigOutcome,
} from '../gates/ports/gates.ports';
import { AuditLogPort, type AppendOutcome } from '../audit/ports/audit.ports';
import {
  AccountRepositoryPort,
  type AccountRecord,
  AccountTokenPort,
  type AccountTokenPurpose,
  type AccountTokenRecord,
  RateLimitPort,
  type SessionRecord,
  SessionRepositoryPort,
  type TotpRecord,
} from '../auth/ports/auth.ports';
import { Clock } from '../common/clock';
import type { Role } from '../tenancy/domain/permissions';
import {
  type AddMemberOutcome,
  type ChangeMemberOutcome,
  InvitationRepositoryPort,
  type MembershipRecord,
  type MemberView,
  type OrganisationRecord,
  OrganisationRepositoryPort,
  type OrgProjectRecord,
  OrgProjectRepositoryPort,
  type PendingInvitationRecord,
} from '../tenancy/ports/tenancy.ports';

/** A clock the spec moves by hand. */
export class FixedClock extends Clock {
  constructor(private current = new Date('2026-10-15T12:00:00.000Z')) {
    super();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class InMemoryAccounts extends AccountRepositoryPort {
  readonly accounts = new Map<string, AccountRecord>();
  readonly totps = new Map<string, TotpRecord & { createdAt: string }>();
  readonly codes: {
    id: string;
    accountId: string;
    hash: string;
    usedAt: string | null;
  }[] = [];

  findByEmail(email: string): Promise<AccountRecord | null> {
    return Promise.resolve(
      [...this.accounts.values()].find((a) => a.email === email) ?? null,
    );
  }
  findById(id: string): Promise<AccountRecord | null> {
    return Promise.resolve(this.accounts.get(id) ?? null);
  }
  async create(account: AccountRecord): Promise<'created' | 'email_taken'> {
    if ((await this.findByEmail(account.email)) !== null) return 'email_taken';
    this.accounts.set(account.id, account);
    return 'created';
  }
  changePassword(id: string, passwordHash: string, at: string): Promise<void> {
    const a = this.accounts.get(id);
    if (a) this.accounts.set(id, { ...a, passwordHash, passwordChangedAt: at });
    return Promise.resolve();
  }
  markEmailVerified(id: string, at: string): Promise<void> {
    const a = this.accounts.get(id);
    if (a && a.emailVerifiedAt === null)
      this.accounts.set(id, { ...a, emailVerifiedAt: at });
    return Promise.resolve();
  }
  rehashPassword(id: string, passwordHash: string): Promise<void> {
    const a = this.accounts.get(id);
    if (a) this.accounts.set(id, { ...a, passwordHash });
    return Promise.resolve();
  }
  totp(accountId: string): Promise<TotpRecord | null> {
    return Promise.resolve(this.totps.get(accountId) ?? null);
  }
  savePendingTotp(
    accountId: string,
    sealedSecret: string,
    at: string,
  ): Promise<boolean> {
    if (this.totps.get(accountId)?.enabledAt != null)
      return Promise.resolve(false);
    this.totps.set(accountId, {
      accountId,
      sealedSecret,
      enabledAt: null,
      lastStep: 0,
      createdAt: at,
    });
    return Promise.resolve(true);
  }
  enableTotp(
    accountId: string,
    step: number,
    at: string,
    recoveryCodes: readonly { id: string; hash: string }[],
  ): Promise<boolean> {
    const t = this.totps.get(accountId);
    if (!t || t.enabledAt !== null) return Promise.resolve(false);
    this.totps.set(accountId, { ...t, enabledAt: at, lastStep: step });
    for (let i = this.codes.length - 1; i >= 0; i--)
      if (this.codes[i]?.accountId === accountId) this.codes.splice(i, 1);
    for (const c of recoveryCodes)
      this.codes.push({ id: c.id, accountId, hash: c.hash, usedAt: null });
    return Promise.resolve(true);
  }
  advanceTotpStep(accountId: string, step: number): Promise<boolean> {
    const t = this.totps.get(accountId);
    if (!t || t.enabledAt === null || t.lastStep >= step)
      return Promise.resolve(false);
    this.totps.set(accountId, { ...t, lastStep: step });
    return Promise.resolve(true);
  }
  removeTotp(accountId: string): Promise<void> {
    this.totps.delete(accountId);
    for (let i = this.codes.length - 1; i >= 0; i--)
      if (this.codes[i]?.accountId === accountId) this.codes.splice(i, 1);
    return Promise.resolve();
  }
  useRecoveryCode(
    accountId: string,
    hash: string,
    at: string,
  ): Promise<boolean> {
    const c = this.codes.find(
      (x) => x.accountId === accountId && x.hash === hash && x.usedAt === null,
    );
    if (!c) return Promise.resolve(false);
    c.usedAt = at;
    return Promise.resolve(true);
  }
}

export class InMemorySessions extends SessionRepositoryPort {
  readonly sessions = new Map<string, SessionRecord>();
  create(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }
  find(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }
  touch(id: string, lastSeenAt: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) this.sessions.set(id, { ...s, lastSeenAt });
    return Promise.resolve();
  }
  revoke(id: string, at: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s && s.revokedAt === null)
      this.sessions.set(id, { ...s, revokedAt: at });
    return Promise.resolve();
  }
  revokeAllOf(accountId: string, at: string, exceptId?: string): Promise<void> {
    for (const s of this.sessions.values())
      if (
        s.accountId === accountId &&
        s.id !== exceptId &&
        s.revokedAt === null
      )
        this.sessions.set(s.id, { ...s, revokedAt: at });
    return Promise.resolve();
  }
}

export class InMemoryRateLimit extends RateLimitPort {
  readonly rows = new Map<string, { end: number; count: number }>();
  count(key: string, now: Date): Promise<number> {
    const r = this.rows.get(key);
    return Promise.resolve(r && r.end > now.getTime() ? r.count : 0);
  }
  windowEnd(key: string, now: Date): Promise<Date | null> {
    const r = this.rows.get(key);
    return Promise.resolve(r && r.end > now.getTime() ? new Date(r.end) : null);
  }
  increment(key: string, windowMs: number, now: Date): Promise<number> {
    const r = this.rows.get(key);
    if (r && r.end > now.getTime()) {
      r.count += 1;
      return Promise.resolve(r.count);
    }
    for (const [k, v] of this.rows)
      if (v.end <= now.getTime()) this.rows.delete(k);
    this.rows.set(key, { end: now.getTime() + windowMs, count: 1 });
    return Promise.resolve(1);
  }
}

export class InMemoryOrganisations extends OrganisationRepositoryPort {
  readonly orgs = new Map<string, OrganisationRecord>();
  readonly memberships: MembershipRecord[] = [];

  constructor(private readonly accounts: InMemoryAccounts) {
    super();
  }

  create(
    organisation: OrganisationRecord,
    owner: MembershipRecord,
  ): Promise<void> {
    this.orgs.set(organisation.id, organisation);
    this.memberships.push(owner);
    return Promise.resolve();
  }
  find(id: string): Promise<OrganisationRecord | null> {
    return Promise.resolve(this.orgs.get(id) ?? null);
  }
  listFor(accountId: string) {
    return Promise.resolve(
      this.memberships
        .filter((m) => m.accountId === accountId)
        .map((membership) => ({
          organisation: this.orgs.get(
            membership.organisationId,
          ) as OrganisationRecord,
          membership,
        })),
    );
  }
  membership(organisationId: string, accountId: string) {
    return Promise.resolve(
      this.memberships.find(
        (m) => m.organisationId === organisationId && m.accountId === accountId,
      ) ?? null,
    );
  }
  members(organisationId: string): Promise<readonly MemberView[]> {
    return Promise.resolve(
      this.memberships
        .filter((m) => m.organisationId === organisationId)
        .map((m) => ({
          ...m,
          email: this.accounts.accounts.get(m.accountId)?.email ?? '',
        })),
    );
  }
  async accountIdByEmail(email: string): Promise<string | null> {
    return (await this.accounts.findByEmail(email))?.id ?? null;
  }
  async verifiedAccountIdByEmail(email: string): Promise<string | null> {
    const account = await this.accounts.findByEmail(email);
    return account?.emailVerifiedAt != null ? account.id : null;
  }
  addMember(member: MembershipRecord): Promise<AddMemberOutcome> {
    if (
      this.memberships.some(
        (m) =>
          m.organisationId === member.organisationId &&
          m.accountId === member.accountId,
      )
    )
      return Promise.resolve('exists');
    this.memberships.push(member);
    return Promise.resolve('added');
  }
  updateMember(
    organisationId: string,
    accountId: string,
    role: Role,
    releaseGranted: boolean,
  ): Promise<ChangeMemberOutcome> {
    const i = this.memberships.findIndex(
      (m) => m.organisationId === organisationId && m.accountId === accountId,
    );
    const current = this.memberships[i];
    if (!current) return Promise.resolve('not_found');
    if (
      current.role === 'owner' &&
      role !== 'owner' &&
      this.owners(organisationId) <= 1
    )
      return Promise.resolve('last_owner');
    this.memberships[i] = { ...current, role, releaseGranted };
    return Promise.resolve('ok');
  }
  removeMember(
    organisationId: string,
    accountId: string,
  ): Promise<ChangeMemberOutcome> {
    const i = this.memberships.findIndex(
      (m) => m.organisationId === organisationId && m.accountId === accountId,
    );
    const current = this.memberships[i];
    if (!current) return Promise.resolve('not_found');
    if (current.role === 'owner' && this.owners(organisationId) <= 1)
      return Promise.resolve('last_owner');
    this.memberships.splice(i, 1);
    return Promise.resolve('ok');
  }
  private owners(organisationId: string): number {
    return this.memberships.filter(
      (m) => m.organisationId === organisationId && m.role === 'owner',
    ).length;
  }
}

export class InMemoryOrgProjects extends OrgProjectRepositoryPort {
  readonly projects: OrgProjectRecord[] = [];
  list(organisationId: string) {
    return Promise.resolve(
      this.projects.filter((p) => p.organisationId === organisationId),
    );
  }
  find(organisationId: string, id: string) {
    return Promise.resolve(
      this.projects.find(
        (p) => p.organisationId === organisationId && p.id === id,
      ) ?? null,
    );
  }
  create(project: OrgProjectRecord): Promise<void> {
    this.projects.push(project);
    return Promise.resolve();
  }
  delete(organisationId: string, id: string): Promise<boolean> {
    const i = this.projects.findIndex(
      (p) => p.organisationId === organisationId && p.id === id,
    );
    if (i === -1) return Promise.resolve(false);
    this.projects.splice(i, 1);
    return Promise.resolve(true);
  }
}

/** The audit log in memory; like the database it refuses a seq that is taken (a lost race). */
export class InMemoryAudit extends AuditLogPort {
  readonly rows: AuditRow[] = [];
  head(organisationId: string): Promise<AuditRow | null> {
    return Promise.resolve(
      this.rows.filter((r) => r.organisationId === organisationId).at(-1) ??
        null,
    );
  }
  append(row: AuditRow): Promise<AppendOutcome> {
    if (
      this.rows.some(
        (r) => r.organisationId === row.organisationId && r.seq === row.seq,
      )
    )
      return Promise.resolve('conflict');
    this.rows.push(row);
    return Promise.resolve('ok');
  }
  list(organisationId: string, afterSeq: number, limit: number) {
    return Promise.resolve(
      this.rows
        .filter((r) => r.organisationId === organisationId && r.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit),
    );
  }
}

/** Config, gates, secrets and bundles in memory, with the database's atomic rules. */
export class InMemoryCloudStore extends CloudProjectStorePort {
  readonly configs = new Map<string, ConfigRecord>();
  readonly gates: GateRecord[] = [];
  readonly secrets: SecretRecord[] = [];
  readonly bundles: BundleRecord[] = [];

  getConfig(projectId: string) {
    return Promise.resolve(this.configs.get(projectId) ?? null);
  }
  setConfig(
    projectId: string,
    text: string,
    expectedRevision: number,
    at: string,
  ): Promise<SetConfigOutcome> {
    const current = this.configs.get(projectId);
    if ((current?.revision ?? 0) !== expectedRevision)
      return Promise.resolve('conflict');
    this.configs.set(projectId, {
      projectId,
      text,
      revision: expectedRevision + 1,
      updatedAt: at,
    });
    return Promise.resolve('ok');
  }
  listGates(projectId: string) {
    return Promise.resolve(this.gates.filter((g) => g.projectId === projectId));
  }
  findGate(projectId: string, name: string) {
    return Promise.resolve(
      this.gates.find((g) => g.projectId === projectId && g.name === name) ??
        null,
    );
  }
  addGate(gate: GateRecord): Promise<AddGateOutcome> {
    if (
      this.gates.some(
        (g) => g.projectId === gate.projectId && g.name === gate.name,
      )
    )
      return Promise.resolve('exists');
    if (
      this.gates.filter((g) => g.projectId === gate.projectId).length >=
      MAX_GATES
    )
      return Promise.resolve('limit');
    this.gates.push(gate);
    return Promise.resolve('ok');
  }
  removeGate(projectId: string, name: string) {
    const i = this.gates.findIndex(
      (g) => g.projectId === projectId && g.name === name,
    );
    if (i < 0) return Promise.resolve(false);
    this.gates.splice(i, 1);
    for (const list of [this.secrets, this.bundles])
      for (let j = list.length - 1; j >= 0; j -= 1) {
        const row = list[j];
        if (row?.projectId === projectId && row.gate === name)
          list.splice(j, 1);
      }
    return Promise.resolve(true);
  }
  setPullTokenHash(projectId: string, name: string, hash: string) {
    const i = this.gates.findIndex(
      (g) => g.projectId === projectId && g.name === name,
    );
    const gate = this.gates[i];
    if (!gate) return Promise.resolve(false);
    this.gates[i] = { ...gate, pullTokenHash: hash };
    return Promise.resolve(true);
  }
  findGateByPullTokenHash(hash: string) {
    return Promise.resolve(
      this.gates.find((g) => g.pullTokenHash === hash) ?? null,
    );
  }
  listSecrets(projectId: string, gate: string) {
    return Promise.resolve(
      this.secrets.filter((s) => s.projectId === projectId && s.gate === gate),
    );
  }
  putSecret(secret: SecretRecord): Promise<PutSecretOutcome> {
    const i = this.secrets.findIndex(
      (s) =>
        s.projectId === secret.projectId &&
        s.gate === secret.gate &&
        s.name === secret.name,
    );
    const current = this.secrets[i];
    if (current) {
      if (current.secretVersion >= secret.secretVersion)
        return Promise.resolve('stale');
      this.secrets[i] = secret;
      return Promise.resolve('ok');
    }
    if (
      this.secrets.filter(
        (s) => s.projectId === secret.projectId && s.gate === secret.gate,
      ).length >= MAX_SECRETS
    )
      return Promise.resolve('limit');
    this.secrets.push(secret);
    return Promise.resolve('ok');
  }
  latestBundle(projectId: string, gate: string) {
    return Promise.resolve(
      this.bundles
        .filter((b) => b.projectId === projectId && b.gate === gate)
        .sort((a, b) => b.version - a.version)[0] ?? null,
    );
  }
  addBundle(bundle: BundleRecord): Promise<AddBundleOutcome> {
    if (
      this.bundles.some(
        (b) =>
          b.projectId === bundle.projectId &&
          b.gate === bundle.gate &&
          b.version === bundle.version,
      )
    )
      return Promise.resolve('exists');
    this.bundles.push(bundle);
    return Promise.resolve('ok');
  }
}

export class InMemoryAccountTokens extends AccountTokenPort {
  readonly tokens: (AccountTokenRecord & { usedAt: string | null })[] = [];
  issue(token: AccountTokenRecord): Promise<void> {
    for (const t of this.tokens)
      if (
        t.accountId === token.accountId &&
        t.purpose === token.purpose &&
        t.usedAt === null
      )
        t.usedAt = token.createdAt;
    this.tokens.push({ ...token, usedAt: null });
    return Promise.resolve();
  }
  consume(
    id: string,
    purpose: AccountTokenPurpose,
    now: string,
  ): Promise<string | null> {
    const t = this.tokens.find((x) => x.id === id);
    if (!t || t.purpose !== purpose || t.usedAt !== null || t.expiresAt <= now)
      return Promise.resolve(null);
    t.usedAt = now;
    return Promise.resolve(t.accountId);
  }
  revokeAll(
    accountId: string,
    purpose: AccountTokenPurpose,
    at: string,
  ): Promise<void> {
    for (const t of this.tokens)
      if (
        t.accountId === accountId &&
        t.purpose === purpose &&
        t.usedAt === null
      )
        t.usedAt = at;
    return Promise.resolve();
  }
}

export class InMemoryInvitations extends InvitationRepositoryPort {
  readonly rows: PendingInvitationRecord[] = [];
  save(invitation: PendingInvitationRecord): Promise<void> {
    const at = this.rows.findIndex(
      (r) =>
        r.organisationId === invitation.organisationId &&
        r.email === invitation.email,
    );
    if (at >= 0) this.rows.splice(at, 1);
    this.rows.push(invitation);
    return Promise.resolve();
  }
  revoke(organisationId: string, email: string): Promise<void> {
    const at = this.rows.findIndex(
      (r) => r.organisationId === organisationId && r.email === email,
    );
    if (at >= 0) this.rows.splice(at, 1);
    return Promise.resolve();
  }
  takeAllFor(
    email: string,
    now: string,
  ): Promise<readonly PendingInvitationRecord[]> {
    const mine = this.rows.filter((r) => r.email === email);
    for (const r of mine) this.rows.splice(this.rows.indexOf(r), 1);
    return Promise.resolve(mine.filter((r) => r.expiresAt > now));
  }
}
