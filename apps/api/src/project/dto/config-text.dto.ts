import { IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

/**
 * The editor's «Speichern» (`PUT /api/projects/:id/config`): moat.yaml as a whole and the hash it
 * was loaded with. The size is checked again in bytes by the handler (MAX_YAML_BYTES).
 */
export class ReplaceConfigDto {
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  base!: string | null;

  @IsString()
  @MaxLength(300_000)
  text!: string;
}
