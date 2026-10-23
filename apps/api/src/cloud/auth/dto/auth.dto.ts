import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Request bodies of the auth routes. The global ValidationPipe (whitelist, forbidNonWhitelisted)
 * refuses any other field (API3, mass assignment). The lengths are only a first bound: the real
 * rules (password 12–256 characters, address shape) live in domain/credentials.ts.
 */
export class RegisterDto {
  @IsString()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MaxLength(1024)
  password!: string;
}

/** What `navigator.credentials.get` returned, each part as base64url (sizes are checked again by the handler). */
export class PasskeyAssertionDto {
  @IsString()
  @MaxLength(1400)
  credentialId!: string;

  @IsString()
  @MaxLength(1400)
  authenticatorData!: string;

  @IsString()
  @MaxLength(2800)
  clientDataJSON!: string;

  @IsString()
  @MaxLength(120)
  signature!: string;
}

export class LoginDto {
  @IsString()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MaxLength(1024)
  password!: string;

  /** A TOTP code or a recovery code; only when the account has a second factor. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  /** A passkey assertion as the second factor, instead of `code`. */
  @IsOptional()
  @ValidateNested()
  @Type(() => PasskeyAssertionDto)
  passkey?: PasskeyAssertionDto;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(1024)
  currentPassword!: string;

  @IsString()
  @MaxLength(1024)
  newPassword!: string;
}

export class EnrolTotpDto {
  @IsString()
  @MaxLength(1024)
  password!: string;
}

export class ConfirmTotpDto {
  @IsString()
  @MaxLength(64)
  code!: string;
}

export class DisableTotpDto {
  @IsString()
  @MaxLength(1024)
  password!: string;

  @IsString()
  @MaxLength(64)
  code!: string;
}

export class EmailOnlyDto {
  @IsString()
  @MaxLength(320)
  email!: string;
}

export class TokenDto {
  @IsString()
  @MaxLength(64)
  token!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MaxLength(64)
  token!: string;

  @IsString()
  @MaxLength(1024)
  newPassword!: string;
}

export class PasskeyChallengeDto {
  @IsString()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MaxLength(1024)
  password!: string;
}

export class BeginPasskeyDto {
  @IsString()
  @MaxLength(1024)
  password!: string;
}

export class FinishPasskeyDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(22000)
  attestationObject!: string;

  @IsString()
  @MaxLength(2800)
  clientDataJSON!: string;
}

export class RemovePasskeyDto {
  @IsString()
  @MaxLength(1024)
  password!: string;
}
