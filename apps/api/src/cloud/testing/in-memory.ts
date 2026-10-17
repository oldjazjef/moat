import type { AuditRow } from '@moat/core';
import { AuditLogPort, type AppendOutcome } from '../audit/ports/audit.ports';
import {
  AccountRepositoryPort,
  type AccountRecord,
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
  type MembershipRecord,
  type MemberView,
  type OrganisationRecord,
  OrganisationRepositoryPort,
  type OrgProjectRecord,
  OrgProjectRepositoryPort,
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
