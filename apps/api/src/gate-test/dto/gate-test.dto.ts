import { IsString, Matches, MaxLength } from 'class-validator';
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
}
