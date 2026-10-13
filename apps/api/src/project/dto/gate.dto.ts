import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { GateInput } from '../application/gate.commands';

/**
 * A gate as `php moat-gate.php install` printed it (`POST /api/projects/:id/gates[/check]`).
 * Only shapes here; the core (planGate) checks the values and answers with a code (422).
 */
export class GateDto {
  @IsString()
  @MaxLength(64)
  name!: string;

  @IsString()
  @MaxLength(64)
  gateId!: string;

  @IsString()
  @MaxLength(128)
  boxKey!: string;

  /** The fingerprint the person confirmed; required to pin, ignored by `check`. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  fingerprint?: string;
}

export function toGateInput(dto: GateDto): GateInput {
  return { name: dto.name, gateId: dto.gateId, boxKey: dto.boxKey };
}
