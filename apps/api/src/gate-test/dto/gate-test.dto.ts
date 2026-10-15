import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { MAX_DRY_RUN_BODY, MAX_PATH_LENGTH, METHODS } from '@moat/core';
import { MAX_GATE_URL } from '../application/gate-test-target';
import { MAX_TEST_BODY } from '../application/gate-test.handlers';

/** `POST /api/projects/:id/test-request`. */
export class GateTestDto {
  /** The gate's address as the person typed it; gateTestTarget decides. */
  @IsString()
  @MaxLength(MAX_GATE_URL)
  url!: string;

  @IsString()
  @Matches(/^[a-z][a-z0-9-]{0,62}$/)
  route!: string;

  /** JSON text for POST/PUT/PATCH routes, empty for the others. */
  @IsString()
  @MaxLength(MAX_TEST_BODY)
  body!: string;

  /** The page's language, for the desktop's confirmation dialog. */
  @IsOptional()
  @IsIn(['de-CH', 'en'])
  locale?: 'de-CH' | 'en';
}

/** `POST /api/projects/:id/hardening-check` (DT-07). */
export class HardeningCheckDto {
  /** The URL of the gate file as the website calls it; the handler decides. */
  @IsString()
  @MaxLength(MAX_GATE_URL)
  url!: string;

  /** `moat-data-<32 hex>`, as `php moat-gate.php install` printed it. */
  @IsString()
  @Matches(/^moat-data-[0-9a-f]{32}$/)
  dataFolder!: string;

  /** The page's language, for the desktop's confirmation dialog. */
  @IsOptional()
  @IsIn(['de-CH', 'en'])
  locale?: 'de-CH' | 'en';
}

/** `POST /api/projects/:id/gates/setup` (SEC-28, T-73). */
export class GateSetupDto {
  /** The URL of the gate file (`.../moat-gate.php`); gateSetupTarget decides. */
  @IsString()
  @MaxLength(MAX_GATE_URL)
  url!: string;

  /** The setup token `php moat-gate.php setup` printed; the handler checks its shape. */
  @IsString()
  @MaxLength(256)
  token!: string;

  /** The page's language, for the desktop's confirmation dialog. */
  @IsOptional()
  @IsIn(['de-CH', 'en'])
  locale?: 'de-CH' | 'en';
}

/** `POST /api/projects/:id/dry-run` (FR-42): a request as a client would send it to the gate. */
export class DryRunDto {
  /** The gate whose lock and sealed secrets count; null for the config alone. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{0,62}$/)
  gate?: string | null;

  @IsIn([...METHODS, 'OPTIONS', 'HEAD'])
  method!: string;

  /** What follows the gate file in the URL (`/newsletter`). */
  @IsString()
  @MaxLength(MAX_PATH_LENGTH + 1024)
  path!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  origin?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  contentType?: string | null;

  /** `Access-Control-Request-Method` of a preflight. */
  @IsOptional()
  @IsIn([...METHODS, 'OPTIONS', 'HEAD'])
  requestMethod?: string | null;

  @IsString()
  @MaxLength(MAX_DRY_RUN_BODY)
  body!: string;
}
