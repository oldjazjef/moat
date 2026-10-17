import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const HASH = /^[0-9a-f]{64}$/;

/** `base`: the hash of the moat.yaml the editor was opened on; null = it was a new file. */
export class SetConfigDto {
  @IsString()
  @MaxLength(262_144)
  text!: string;

  @IsOptional()
  @IsString()
  @Matches(HASH)
  base: string | null = null;
}

export class AddGateDto {
  @IsString()
  @Matches(NAME)
  name!: string;

  /** As `php moat-gate.php install` printed it. */
  @IsString()
  @MaxLength(64)
  gateId!: string;

  @IsString()
  @MaxLength(64)
  boxKey!: string;

  /** The `MOAT-…` fingerprint the person compared with the gate's own display (SEC-32). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  fingerprint!: string;

  /** Ed25519 public key (base64url): makes it a gate the customer signs for; absent = managed. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  signerKey?: string;
}

export class SealedSecretDto {
  @IsInt()
  v!: number;

  @IsString()
  @MaxLength(64)
  alg!: string;

  @IsInt()
  @Min(1)
  @Max(999_999_999)
  secretVersion!: number;

  @IsString()
  @MaxLength(64)
  epk!: string;

  @IsString()
  @MaxLength(64)
  nonce!: string;

  @IsString()
  @MaxLength(21_846)
  ct!: string;
}

export class PutSecretDto {
  @ValidateNested()
  @Type(() => SealedSecretDto)
  sealed!: SealedSecretDto;
}

export class ReleaseDto {
  @IsString()
  @Matches(HASH)
  digest!: string;
}

export class UploadBundleDto {
  /** The signed envelope exactly as `moat build` wrote it. */
  @IsString()
  @MaxLength(1_048_576)
  envelope!: string;
}
