import { Injectable } from '@nestjs/common';
import type { Role } from '../../cloud/tenancy/domain/permissions';
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
} from '../../cloud/tenancy/ports/tenancy.ports';
import { CloudDatabase } from './cloud-database';

/** The database's CHECK keeps `role` to the five known values. */
function membershipOf(row: {
  organisationId: string;
  accountId: string;
  role: string;
  releaseGranted: boolean;
  createdAt: string;
}): MembershipRecord {
  return { ...row, role: row.role as Role };
}

@Injectable()
export class PrismaOrganisationRepository extends OrganisationRepositoryPort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  async create(
    organisation: OrganisationRecord,
    owner: MembershipRecord,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.organisation.create({ data: { ...organisation } });
      await tx.membership.create({ data: { ...owner } });
    });
  }

  find(id: string): Promise<OrganisationRecord | null> {
    return this.db.organisation.findUnique({ where: { id } });
  }

  async listFor(accountId: string) {
    const rows = await this.db.membership.findMany({
      where: { accountId },
      include: { organisation: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(({ organisation, ...membership }) => ({
      organisation,
      membership: membershipOf(membership),
    }));
  }

  async membership(
    organisationId: string,
    accountId: string,
  ): Promise<MembershipRecord | null> {
    const row = await this.db.membership.findUnique({
      where: { organisationId_accountId: { organisationId, accountId } },
    });
    return row === null ? null : membershipOf(row);
  }

  async members(organisationId: string): Promise<readonly MemberView[]> {
    const rows = await this.db.membership.findMany({
      where: { organisationId },
      include: { account: { select: { email: true } } },
      orderBy: [{ createdAt: 'asc' }, { accountId: 'asc' }],
    });
    return rows.map(({ account, ...membership }) => ({
      ...membershipOf(membership),
      email: account.email,
    }));
  }

  async accountIdByEmail(email: string): Promise<string | null> {
    const row = await this.db.account.findUnique({
      where: { email },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async verifiedAccountIdByEmail(email: string): Promise<string | null> {
    const row = await this.db.account.findFirst({
      where: { email, emailVerifiedAt: { not: null } },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async addMember(member: MembershipRecord): Promise<AddMemberOutcome> {
    try {
      await this.db.membership.create({ data: { ...member } });
      return 'added';
    } catch (error) {
      if ((error as { code?: unknown }).code === 'P2002') return 'exists';
      throw error;
    }
  }

  updateMember(
    organisationId: string,
    accountId: string,
    role: Role,
    releaseGranted: boolean,
  ): Promise<ChangeMemberOutcome> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.membership.findUnique({
        where: { organisationId_accountId: { organisationId, accountId } },
      });
      if (current === null) return 'not_found';
      if (current.role === 'owner' && role !== 'owner') {
        const owners = await tx.membership.count({
          where: { organisationId, role: 'owner' },
        });
        if (owners <= 1) return 'last_owner';
      }
      await tx.membership.update({
        where: { organisationId_accountId: { organisationId, accountId } },
        data: { role, releaseGranted },
      });
      return 'ok';
    });
  }

  removeMember(
    organisationId: string,
    accountId: string,
  ): Promise<ChangeMemberOutcome> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.membership.findUnique({
        where: { organisationId_accountId: { organisationId, accountId } },
      });
      if (current === null) return 'not_found';
      if (current.role === 'owner') {
        const owners = await tx.membership.count({
          where: { organisationId, role: 'owner' },
        });
        if (owners <= 1) return 'last_owner';
      }
      await tx.membership.delete({
        where: { organisationId_accountId: { organisationId, accountId } },
      });
      return 'ok';
    });
  }
}

@Injectable()
export class PrismaOrgProjectRepository extends OrgProjectRepositoryPort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  list(organisationId: string): Promise<readonly OrgProjectRecord[]> {
    return this.db.orgProject.findMany({
      where: { organisationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  find(organisationId: string, id: string): Promise<OrgProjectRecord | null> {
    return this.db.orgProject.findFirst({ where: { id, organisationId } });
  }

  async create(project: OrgProjectRecord): Promise<void> {
    await this.db.orgProject.create({ data: { ...project } });
  }

  async delete(organisationId: string, id: string): Promise<boolean> {
    const deleted = await this.db.orgProject.deleteMany({
      where: { id, organisationId },
    });
    return deleted.count === 1;
  }
}

@Injectable()
export class PrismaInvitationRepository extends InvitationRepositoryPort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  async save(invitation: PendingInvitationRecord): Promise<void> {
    const { organisationId, email, ...fields } = invitation;
    await this.db.pendingInvitation.upsert({
      where: { organisationId_email: { organisationId, email } },
      create: { organisationId, email, ...fields },
      update: { ...fields },
    });
  }

  async revoke(organisationId: string, email: string): Promise<void> {
    await this.db.pendingInvitation.deleteMany({
      where: { organisationId, email },
    });
  }

  takeAllFor(
    email: string,
    now: string,
  ): Promise<readonly PendingInvitationRecord[]> {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.pendingInvitation.findMany({ where: { email } });
      // Deleting by id inside the transaction: a racing second redemption finds nothing.
      const taken: PendingInvitationRecord[] = [];
      for (const row of rows) {
        const gone = await tx.pendingInvitation.deleteMany({
          where: { id: row.id },
        });
        if (gone.count === 1 && row.expiresAt > now)
          taken.push({ ...row, role: row.role as Role });
      }
      return taken;
    });
  }
}
