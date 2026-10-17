import {
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  QueryHandler,
} from '@nestjs/cqrs';
import { sha256Hex } from '@moat/core';
import { AuditTrail } from '../../audit/application/audit-trail';
import { Clock, ID_PATTERN, iso, newId } from '../../common/clock';
import { normaliseEmail } from '../../auth/domain/credentials';
import {
  type Action,
  can,
  canChangeRole,
  canHoldRelease,
  permissionsOf,
} from '../domain/permissions';
import {
  OrganisationRepositoryPort,
  OrgProjectRepositoryPort,
  type MembershipRecord,
  type MemberView as StoredMember,
} from '../ports/tenancy.ports';
import {
  AddMemberCommand,
  type AddMemberResult,
  ChangeMemberCommand,
  type ChangeMemberResult,
  CreateOrganisationCommand,
  type CreateOrganisationResult,
  CreateProjectCommand,
  type CreateProjectResult,
  DeleteProjectCommand,
  type DeleteProjectResult,
  type Forbidden,
  GetOrganisationQuery,
  type GetOrganisationResult,
  GetProjectQuery,
  type GetProjectResult,
  ListMembersQuery,
  type ListMembersResult,
  ListOrganisationsQuery,
  ListProjectsQuery,
  type ListProjectsResult,
  type MemberView,
  type MyAccess,
  type NotFound,
  type OrganisationSummary,
  RemoveMemberCommand,
  type RemoveMemberResult,
} from './tenancy.commands';

const NOT_FOUND: NotFound = { status: 'not_found' };
const FORBIDDEN: Forbidden = { status: 'forbidden' };

/** A name for an organisation or project: 1–100 characters, no control characters. */
export function cleanName(input: string): string | null {
  const name = input.trim();
  const length = [...name].length;
  if (length < 1 || length > 100) return null;
  return /\p{C}/u.test(name) ? null : name;
}

function access(member: MembershipRecord): MyAccess {
  return {
    role: member.role,
    releaseGranted: member.releaseGranted,
    permissions: permissionsOf(member.role, member.releaseGranted),
  };
}

function memberView(member: StoredMember): MemberView {
  return {
    accountId: member.accountId,
    email: member.email,
    role: member.role,
    releaseGranted: member.releaseGranted,
    createdAt: member.createdAt,
  };
}

/**
 * The tenant check every organisation-scoped handler starts with (SEC-50): the caller's
 * membership, or null — which the handler answers as `not_found`, whether the organisation does
 * not exist or just is not theirs. A malformed id never reaches the database.
 */
async function membershipOf(
  organisations: OrganisationRepositoryPort,
  actorId: string,
  organisationId: string,
): Promise<MembershipRecord | null> {
  if (!ID_PATTERN.test(organisationId)) return null;
  return organisations.membership(organisationId, actorId);
}

function allowed(member: MembershipRecord, action: Action): boolean {
  return can(member.role, member.releaseGranted, action);
}

@CommandHandler(CreateOrganisationCommand)
export class CreateOrganisationHandler implements ICommandHandler<CreateOrganisationCommand> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly clock: Clock,
    private readonly audit: AuditTrail,
  ) {}

  async execute(
    command: CreateOrganisationCommand,
  ): Promise<CreateOrganisationResult> {
    const name = cleanName(command.name);
    if (name === null) return { status: 'refused', code: 'name_invalid' };
    const at = iso(this.clock.now());
    const organisation = { id: newId(), name, createdAt: at };
    const owner: MembershipRecord = {
      organisationId: organisation.id,
      accountId: command.actorId,
      role: 'owner',
      // The founder may sign and release; everybody else gets this from an Owner, explicitly.
      releaseGranted: true,
      createdAt: at,
    };
    await this.organisations.create(organisation, owner);
    await this.audit.record(organisation.id, command.actorId, {
      action: 'org.create',
      target: organisation.id,
      details: {},
    });
    return { status: 'ok', organisation, access: access(owner) };
  }
}

@QueryHandler(ListOrganisationsQuery)
export class ListOrganisationsHandler implements IQueryHandler<ListOrganisationsQuery> {
  constructor(private readonly organisations: OrganisationRepositoryPort) {}

  async execute(
    query: ListOrganisationsQuery,
  ): Promise<readonly OrganisationSummary[]> {
    const rows = await this.organisations.listFor(query.actorId);
    return rows.map(({ organisation, membership }) => ({
      organisation: {
        id: organisation.id,
        name: organisation.name,
        createdAt: organisation.createdAt,
      },
      access: access(membership),
    }));
  }
}

@QueryHandler(GetOrganisationQuery)
export class GetOrganisationHandler implements IQueryHandler<GetOrganisationQuery> {
  constructor(private readonly organisations: OrganisationRepositoryPort) {}

  async execute(query: GetOrganisationQuery): Promise<GetOrganisationResult> {
    const member = await membershipOf(
      this.organisations,
      query.actorId,
      query.organisationId,
    );
    if (member === null) return NOT_FOUND;
    const organisation = await this.organisations.find(query.organisationId);
    if (organisation === null) return NOT_FOUND;
    return {
      status: 'ok',
      organisation: {
        id: organisation.id,
        name: organisation.name,
        createdAt: organisation.createdAt,
      },
      access: access(member),
    };
  }
}

@QueryHandler(ListMembersQuery)
export class ListMembersHandler implements IQueryHandler<ListMembersQuery> {
  constructor(private readonly organisations: OrganisationRepositoryPort) {}

  async execute(query: ListMembersQuery): Promise<ListMembersResult> {
    const member = await membershipOf(
      this.organisations,
      query.actorId,
      query.organisationId,
    );
    if (member === null) return NOT_FOUND;
    if (!allowed(member, 'members:read')) return FORBIDDEN;
    const members = await this.organisations.members(query.organisationId);
    return { status: 'ok', members: members.map(memberView) };
  }
}

@CommandHandler(AddMemberCommand)
export class AddMemberHandler implements ICommandHandler<AddMemberCommand> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly clock: Clock,
    private readonly audit: AuditTrail,
  ) {}

  async execute(command: AddMemberCommand): Promise<AddMemberResult> {
    const actor = await membershipOf(
      this.organisations,
      command.actorId,
      command.organisationId,
    );
    if (actor === null) return NOT_FOUND;
    // Role escalation (SEC-52, T-81): who may add whom is decided before anything is looked up.
    if (
      !allowed(actor, 'members:manage') ||
      !canChangeRole(actor.role, null, command.role)
    )
      return FORBIDDEN;
    const email = normaliseEmail(command.email);
    if (email === null) return { status: 'refused', code: 'email_invalid' };
    const accountId = await this.organisations.accountIdByEmail(email);
    if (accountId !== null)
      await this.organisations.addMember({
        organisationId: command.organisationId,
        accountId,
        role: command.role,
        releaseGranted: false,
        createdAt: iso(this.clock.now()),
      });
    // Recorded as a request, whatever came of it: the row must not tell an unknown address from a
    // known one (T-79), and the address only as its hash (no personal data in an append-only log).
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'member.add_requested',
      target: null,
      details: { role: command.role, emailHash: await sha256Hex(email) },
    });
    // `ok` for an unknown address and for one that is a member already: nothing tells them apart.
    return { status: 'ok' };
  }
}

@CommandHandler(ChangeMemberCommand)
export class ChangeMemberHandler implements ICommandHandler<ChangeMemberCommand> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly audit: AuditTrail,
  ) {}

  async execute(command: ChangeMemberCommand): Promise<ChangeMemberResult> {
    const actor = await membershipOf(
      this.organisations,
      command.actorId,
      command.organisationId,
    );
    if (actor === null) return NOT_FOUND;
    if (!allowed(actor, 'members:manage')) return FORBIDDEN;
    if (!ID_PATTERN.test(command.accountId)) return NOT_FOUND;
    const target = await this.organisations.membership(
      command.organisationId,
      command.accountId,
    );
    if (target === null) return NOT_FOUND;

    const role = command.role ?? target.role;
    // Not named: it stays, unless the new role cannot hold it (then it goes with the role).
    const releaseGranted =
      command.releaseGranted ??
      (canHoldRelease(role) ? target.releaseGranted : false);
    // An Admin neither touches an Owner or another Admin nor promotes anybody to those.
    if (!canChangeRole(actor.role, target.role, role)) return FORBIDDEN;
    // The release permission is its own right (SEC-52): changing it needs `release:grant`, which
    // an Editor never has and an Admin does not either. (A role change that cannot keep the
    // permission drops it without this right: taking a right away is always safe.)
    if (
      command.releaseGranted !== undefined &&
      command.releaseGranted !== target.releaseGranted &&
      !allowed(actor, 'release:grant')
    )
      return FORBIDDEN;
    if (releaseGranted && !canHoldRelease(role))
      return { status: 'refused', code: 'release_not_applicable' };
    const outcome = await this.organisations.updateMember(
      command.organisationId,
      command.accountId,
      role,
      releaseGranted,
    );
    if (outcome === 'not_found') return NOT_FOUND;
    if (outcome === 'last_owner')
      return { status: 'refused', code: 'last_owner' };
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'member.change',
      target: command.accountId,
      details: {
        fromRole: target.role,
        toRole: role,
        fromRelease: target.releaseGranted,
        toRelease: releaseGranted,
      },
    });
    const member = (
      await this.organisations.members(command.organisationId)
    ).find((m) => m.accountId === command.accountId);
    return member === undefined
      ? NOT_FOUND
      : { status: 'ok', member: memberView(member) };
  }
}

@CommandHandler(RemoveMemberCommand)
export class RemoveMemberHandler implements ICommandHandler<RemoveMemberCommand> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly audit: AuditTrail,
  ) {}

  async execute(command: RemoveMemberCommand): Promise<RemoveMemberResult> {
    const actor = await membershipOf(
      this.organisations,
      command.actorId,
      command.organisationId,
    );
    if (actor === null) return NOT_FOUND;
    const own = command.accountId === command.actorId;
    let removedRole = actor.role;
    if (!own) {
      if (!allowed(actor, 'members:manage')) return FORBIDDEN;
      if (!ID_PATTERN.test(command.accountId)) return NOT_FOUND;
      const target = await this.organisations.membership(
        command.organisationId,
        command.accountId,
      );
      if (target === null) return NOT_FOUND;
      if (!canChangeRole(actor.role, target.role, null)) return FORBIDDEN;
      removedRole = target.role;
    }
    // Leaving needs no right; the last Owner cannot leave.
    const outcome = await this.organisations.removeMember(
      command.organisationId,
      command.accountId,
    );
    if (outcome === 'not_found') return NOT_FOUND;
    if (outcome === 'last_owner')
      return { status: 'refused', code: 'last_owner' };
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'member.remove',
      target: command.accountId,
      details: { role: removedRole, self: own },
    });
    return { status: 'ok' };
  }
}

@QueryHandler(ListProjectsQuery)
export class ListProjectsHandler implements IQueryHandler<ListProjectsQuery> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly projects: OrgProjectRepositoryPort,
  ) {}

  async execute(query: ListProjectsQuery): Promise<ListProjectsResult> {
    const member = await membershipOf(
      this.organisations,
      query.actorId,
      query.organisationId,
    );
    if (member === null) return NOT_FOUND;
    if (!allowed(member, 'project:read')) return FORBIDDEN;
    const projects = await this.projects.list(query.organisationId);
    return {
      status: 'ok',
      projects: projects.map(({ id, name, createdAt }) => ({
        id,
        name,
        createdAt,
      })),
    };
  }
}

@CommandHandler(CreateProjectCommand)
export class CreateProjectHandler implements ICommandHandler<CreateProjectCommand> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly projects: OrgProjectRepositoryPort,
    private readonly clock: Clock,
    private readonly audit: AuditTrail,
  ) {}

  async execute(command: CreateProjectCommand): Promise<CreateProjectResult> {
    const member = await membershipOf(
      this.organisations,
      command.actorId,
      command.organisationId,
    );
    if (member === null) return NOT_FOUND;
    if (!allowed(member, 'project:create')) return FORBIDDEN;
    const name = cleanName(command.name);
    if (name === null) return { status: 'refused', code: 'name_invalid' };
    const project = {
      id: newId(),
      organisationId: command.organisationId,
      name,
      createdAt: iso(this.clock.now()),
    };
    await this.projects.create(project);
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'project.create',
      target: project.id,
      details: {},
    });
    return {
      status: 'ok',
      project: { id: project.id, name, createdAt: project.createdAt },
    };
  }
}

@QueryHandler(GetProjectQuery)
export class GetProjectHandler implements IQueryHandler<GetProjectQuery> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly projects: OrgProjectRepositoryPort,
  ) {}

  async execute(query: GetProjectQuery): Promise<GetProjectResult> {
    const member = await membershipOf(
      this.organisations,
      query.actorId,
      query.organisationId,
    );
    if (member === null) return NOT_FOUND;
    if (!allowed(member, 'project:read')) return FORBIDDEN;
    if (!ID_PATTERN.test(query.projectId)) return NOT_FOUND;
    // Looked up inside the caller's organisation only: a project of another one is not found.
    const project = await this.projects.find(
      query.organisationId,
      query.projectId,
    );
    return project === null
      ? NOT_FOUND
      : {
          status: 'ok',
          project: {
            id: project.id,
            name: project.name,
            createdAt: project.createdAt,
          },
        };
  }
}

@CommandHandler(DeleteProjectCommand)
export class DeleteProjectHandler implements ICommandHandler<DeleteProjectCommand> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly projects: OrgProjectRepositoryPort,
    private readonly audit: AuditTrail,
  ) {}

  async execute(command: DeleteProjectCommand): Promise<DeleteProjectResult> {
    const member = await membershipOf(
      this.organisations,
      command.actorId,
      command.organisationId,
    );
    if (member === null) return NOT_FOUND;
    if (!allowed(member, 'project:delete')) return FORBIDDEN;
    if (!ID_PATTERN.test(command.projectId)) return NOT_FOUND;
    if (
      !(await this.projects.delete(command.organisationId, command.projectId))
    )
      return NOT_FOUND;
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'project.delete',
      target: command.projectId,
      details: {},
    });
    return { status: 'ok' };
  }
}

export const TENANCY_HANDLERS = [
  CreateOrganisationHandler,
  ListOrganisationsHandler,
  GetOrganisationHandler,
  ListMembersHandler,
  AddMemberHandler,
  ChangeMemberHandler,
  RemoveMemberHandler,
  ListProjectsHandler,
  CreateProjectHandler,
  GetProjectHandler,
  DeleteProjectHandler,
];
