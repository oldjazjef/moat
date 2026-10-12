import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import {
  CONFIG_EDIT_OPS,
  type ConfigEdit,
  type ConfigEditOp,
} from '../project.types';

/** Route, upstream, secret, environment and gate names (CLAUDE.md, YAML standards). */
const NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** `POST /api/projects/:id/config/edits`: one edit, based on the moat.yaml the window showed. */
export class ConfigEditDto {
  /** ProjectView.configHash of the version the edit is based on. */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  base!: string;

  @IsIn(CONFIG_EDIT_OPS)
  op!: ConfigEditOp;

  @IsOptional()
  @IsString()
  @Matches(NAME)
  environment?: string;

  @IsOptional()
  @IsString()
  @Matches(NAME)
  gate?: string;
}

/** The edit the DTO describes, or null when a name its operation needs is missing (400). */
export function toConfigEdit(dto: ConfigEditDto): ConfigEdit | null {
  const { op, environment, gate } = dto;
  switch (op) {
    case 'addEnvironment':
    case 'lockEnvironment':
    case 'unlockEnvironment':
      return environment !== undefined && gate === undefined
        ? { op, environment }
        : null;
    case 'lockGate':
    case 'unlockGate':
      return gate !== undefined && environment === undefined
        ? { op, gate }
        : null;
    case 'assignGate':
      return gate !== undefined && environment !== undefined
        ? { op, gate, environment }
        : null;
  }
}
