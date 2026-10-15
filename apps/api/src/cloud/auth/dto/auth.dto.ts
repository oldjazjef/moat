import { IsOptional, IsString, MaxLength } from 'class-validator';

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
