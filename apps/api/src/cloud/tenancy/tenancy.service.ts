import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { Role } from './domain/permissions';
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
  GetOrganisationQuery,
  type GetOrganisationResult,
  GetProjectQuery,
  type GetProjectResult,
  ListMembersQuery,
  type ListMembersResult,
  ListOrganisationsQuery,
  ListProjectsQuery,
  type ListProjectsResult,
  type OrganisationSummary,
  RemoveMemberCommand,
  type RemoveMemberResult,
  RevokeInvitationCommand,
  type RevokeInvitationResult,
} from './application/tenancy.commands';

/** The façade of the controllers (Controller → Service → Bus → Handler → Port). */
@Injectable()
export class TenancyService {
  constructor(
    private readonly queries: QueryBus,
    private readonly commands: CommandBus,
  ) {}

  createOrganisation(
    actorId: string,
    name: string,
  ): Promise<CreateOrganisationResult> {
    return this.commands.execute(new CreateOrganisationCommand(actorId, name));
  }

  listOrganisations(actorId: string): Promise<readonly OrganisationSummary[]> {
    return this.queries.execute(new ListOrganisationsQuery(actorId));
  }

  getOrganisation(actorId: string, id: string): Promise<GetOrganisationResult> {
    return this.queries.execute(new GetOrganisationQuery(actorId, id));
  }

  listMembers(actorId: string, id: string): Promise<ListMembersResult> {
    return this.queries.execute(new ListMembersQuery(actorId, id));
  }

  addMember(
    actorId: string,
    id: string,
    email: string,
    role: Role,
  ): Promise<AddMemberResult> {
    return this.commands.execute(
      new AddMemberCommand(actorId, id, email, role),
    );
  }

  changeMember(
    actorId: string,
    id: string,
    accountId: string,
    role: Role | undefined,
    releaseGranted: boolean | undefined,
  ): Promise<ChangeMemberResult> {
    return this.commands.execute(
      new ChangeMemberCommand(actorId, id, accountId, role, releaseGranted),
    );
  }

  removeMember(
    actorId: string,
    id: string,
    accountId: string,
  ): Promise<RemoveMemberResult> {
    return this.commands.execute(
      new RemoveMemberCommand(actorId, id, accountId),
    );
  }

  revokeInvitation(
    actorId: string,
    id: string,
    email: string,
  ): Promise<RevokeInvitationResult> {
    return this.commands.execute(
      new RevokeInvitationCommand(actorId, id, email),
    );
  }

  listProjects(actorId: string, id: string): Promise<ListProjectsResult> {
    return this.queries.execute(new ListProjectsQuery(actorId, id));
  }

  createProject(
    actorId: string,
    id: string,
    name: string,
  ): Promise<CreateProjectResult> {
    return this.commands.execute(new CreateProjectCommand(actorId, id, name));
  }

  getProject(
    actorId: string,
    id: string,
    projectId: string,
  ): Promise<GetProjectResult> {
    return this.queries.execute(new GetProjectQuery(actorId, id, projectId));
  }

  deleteProject(
    actorId: string,
    id: string,
    projectId: string,
  ): Promise<DeleteProjectResult> {
    return this.commands.execute(
      new DeleteProjectCommand(actorId, id, projectId),
    );
  }
}
