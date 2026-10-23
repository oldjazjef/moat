import { Command, Query } from '@nestjs/cqrs';
import type { Action, Role } from '../domain/permissions';

/**
 * `not_found` is also the answer for an organisation or project the caller is not a member of
 * (SEC-50, T-33: a foreign tenant's resource does not exist). `forbidden` is for a member who may
 * not do this (SEC-52).
 */
export interface NotFound {
  readonly status: 'not_found';
}
export interface Forbidden {
  readonly status: 'forbidden';
}

export interface OrganisationView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** The caller's place in an organisation, and what it allows. */
export interface MyAccess {
  readonly role: Role;
  /** The separate sign/release permission (SEC-52). */
  readonly releaseGranted: boolean;
  readonly permissions: readonly Action[];
}

export interface MemberView {
  readonly accountId: string;
  readonly email: string;
  readonly role: Role;
  readonly releaseGranted: boolean;
  readonly createdAt: string;
}

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

// ── Organisations ──────────────────────────────────────────────────────────────────────────

export type CreateOrganisationResult =
  | {
      readonly status: 'ok';
      readonly organisation: OrganisationView;
      readonly access: MyAccess;
    }
  | { readonly status: 'refused'; readonly code: 'name_invalid' };

/** The creator becomes the Owner, with the release permission. */
export class CreateOrganisationCommand extends Command<CreateOrganisationResult> {
  constructor(
    readonly actorId: string,
    readonly name: string,
  ) {
    super();
  }
}

export interface OrganisationSummary {
  readonly organisation: OrganisationView;
  readonly access: MyAccess;
}

export class ListOrganisationsQuery extends Query<
  readonly OrganisationSummary[]
> {
  constructor(readonly actorId: string) {
    super();
  }
}

export type GetOrganisationResult =
  ({ readonly status: 'ok' } & OrganisationSummary) | NotFound;

export class GetOrganisationQuery extends Query<GetOrganisationResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
  ) {
    super();
  }
}

// ── Members ────────────────────────────────────────────────────────────────────────────────

export type ListMembersResult =
  | { readonly status: 'ok'; readonly members: readonly MemberView[] }
  | NotFound
  | Forbidden;

export class ListMembersQuery extends Query<ListMembersResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
  ) {
    super();
  }
}

export type AddMemberResult =
  | { readonly status: 'ok' }
  | NotFound
  | Forbidden
  | { readonly status: 'refused'; readonly code: 'email_invalid' };

/**
 * Adds an existing account by address, with `releaseGranted` off. The answer is `ok` whether or
 * not an account with that address exists (T-79): invitations by e-mail replace this later.
 */
export class AddMemberCommand extends Command<AddMemberResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly email: string,
    readonly role: Role,
  ) {
    super();
  }
}

export type RevokeInvitationResult =
  | { readonly status: 'ok' }
  | NotFound
  | Forbidden
  | { readonly status: 'refused'; readonly code: 'email_invalid' };

/**
 * Withdraws the invitation for an address. There is deliberately no list of invitations: it would
 * tell an administrator which addresses have no confirmed account, which "add member" hides on
 * purpose (T-79). The answer is `ok` whether or not an invitation existed.
 */
export class RevokeInvitationCommand extends Command<RevokeInvitationResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly email: string,
  ) {
    super();
  }
}

export type ChangeMemberResult =
  | { readonly status: 'ok'; readonly member: MemberView }
  | NotFound
  | Forbidden
  | {
      readonly status: 'refused';
      readonly code: 'last_owner' | 'release_not_applicable';
    };

export class ChangeMemberCommand extends Command<ChangeMemberResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly accountId: string,
    readonly role: Role | undefined,
    readonly releaseGranted: boolean | undefined,
  ) {
    super();
  }
}

export type RemoveMemberResult =
  | { readonly status: 'ok' }
  | NotFound
  | Forbidden
  | { readonly status: 'refused'; readonly code: 'last_owner' };

export class RemoveMemberCommand extends Command<RemoveMemberResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly accountId: string,
  ) {
    super();
  }
}

// ── Projects ───────────────────────────────────────────────────────────────────────────────

export type ListProjectsResult =
  | { readonly status: 'ok'; readonly projects: readonly ProjectView[] }
  | NotFound
  | Forbidden;

export class ListProjectsQuery extends Query<ListProjectsResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
  ) {
    super();
  }
}

export type CreateProjectResult =
  | { readonly status: 'ok'; readonly project: ProjectView }
  | NotFound
  | Forbidden
  | { readonly status: 'refused'; readonly code: 'name_invalid' };

export class CreateProjectCommand extends Command<CreateProjectResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly name: string,
  ) {
    super();
  }
}

export type GetProjectResult =
  | { readonly status: 'ok'; readonly project: ProjectView }
  | NotFound
  | Forbidden;

export class GetProjectQuery extends Query<GetProjectResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
  ) {
    super();
  }
}

export type DeleteProjectResult =
  { readonly status: 'ok' } | NotFound | Forbidden;

export class DeleteProjectCommand extends Command<DeleteProjectResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
  ) {
    super();
  }
}
