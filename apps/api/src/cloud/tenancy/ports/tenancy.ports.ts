import type { Role } from '../domain/permissions';

export interface OrganisationRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface MembershipRecord {
  readonly organisationId: string;
  readonly accountId: string;
  readonly role: Role;
  /** The separate sign/release permission (SEC-52). */
  readonly releaseGranted: boolean;
  readonly createdAt: string;
}

/** A member with the address of the account (what a member list shows). */
export interface MemberView extends MembershipRecord {
  readonly email: string;
}

export interface OrgProjectRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly name: string;
  readonly createdAt: string;
}

/** `exists`: the account is a member already, nothing changed. */
export type AddMemberOutcome = 'added' | 'exists';
/** `last_owner`: the change would leave the organisation without an Owner; nothing changed. */
export type ChangeMemberOutcome = 'ok' | 'not_found' | 'last_owner';

export abstract class OrganisationRepositoryPort {
  /** The organisation and its first member (the Owner) in one step. */
  abstract create(
    organisation: OrganisationRecord,
    owner: MembershipRecord,
  ): Promise<void>;
  abstract find(id: string): Promise<OrganisationRecord | null>;
  /** The organisations the account is a member of, with its membership. */
  abstract listFor(accountId: string): Promise<
    readonly {
      organisation: OrganisationRecord;
      membership: MembershipRecord;
    }[]
  >;
  abstract membership(
    organisationId: string,
    accountId: string,
  ): Promise<MembershipRecord | null>;
  abstract members(organisationId: string): Promise<readonly MemberView[]>;
  /** The account with this (normalised) address, if any: its id only. */
  abstract accountIdByEmail(email: string): Promise<string | null>;
  abstract addMember(member: MembershipRecord): Promise<AddMemberOutcome>;
  /** Role and release flag; refused when it would remove the last Owner. */
  abstract updateMember(
    organisationId: string,
    accountId: string,
    role: Role,
    releaseGranted: boolean,
  ): Promise<ChangeMemberOutcome>;
  /** Refused when it would remove the last Owner. */
  abstract removeMember(
    organisationId: string,
    accountId: string,
  ): Promise<ChangeMemberOutcome>;
}

/** Every method takes the organisation: a project id alone never finds anything (SEC-50). */
export abstract class OrgProjectRepositoryPort {
  abstract list(organisationId: string): Promise<readonly OrgProjectRecord[]>;
  abstract find(
    organisationId: string,
    id: string,
  ): Promise<OrgProjectRecord | null>;
  abstract create(project: OrgProjectRecord): Promise<void>;
  /** False when the organisation has no such project. */
  abstract delete(organisationId: string, id: string): Promise<boolean>;
}
