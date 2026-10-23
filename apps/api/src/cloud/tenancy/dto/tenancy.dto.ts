import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ROLES, type Role } from '../domain/permissions';

/** Request bodies (whitelist + forbidNonWhitelisted: no mass assignment, API3). */
export class CreateOrganisationDto {
  @IsString()
  @MaxLength(400)
  name!: string;
}

export class CreateOrgProjectDto {
  @IsString()
  @MaxLength(400)
  name!: string;
}

export class AddMemberDto {
  @IsString()
  @MaxLength(320)
  email!: string;

  @IsIn(ROLES)
  role!: Role;
}

export class RevokeInvitationDto {
  @IsString()
  @MaxLength(320)
  email!: string;
}

export class ChangeMemberDto {
  @IsOptional()
  @IsIn(ROLES)
  role?: Role;

  /** The separate sign/release permission (SEC-52); only an Owner may change it. */
  @IsOptional()
  @IsBoolean()
  releaseGranted?: boolean;
}
