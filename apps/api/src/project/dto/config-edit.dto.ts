import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { METHODS, type RouteInput } from '@moat/core';
import {
  CONFIG_EDIT_OPS,
  type ConfigEdit,
  type ConfigEditOp,
} from '../project.types';

/** Route, upstream, secret, environment and gate names (CLAUDE.md, YAML standards). */
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
/** Longer than any path, origin, size or duration the schema takes; the core checks the rest. */
const MAX_VALUE = 2048;

export class RateLimitDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  requests!: number;

  @IsString()
  @MaxLength(16)
  window!: string;

  @IsOptional()
  @IsIn(['ip', 'route'])
  per?: 'ip' | 'route';
}

/**
 * A route as the desktop's form sends it. Types and lengths only: whether a path, origin, size or
 * duration is valid is decided by the core's schema, the same one every moat.yaml passes.
 */
export class RouteDto {
  @IsIn(METHODS)
  method!: (typeof METHODS)[number];

  @IsString()
  @MaxLength(MAX_VALUE)
  path!: string;

  @IsString()
  @Matches(NAME)
  upstream!: string;

  @IsString()
  @MaxLength(MAX_VALUE)
  upstreamPath!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  maxBodySize?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(MAX_VALUE, { each: true })
  origins?: string[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RateLimitDto)
  rateLimit?: RateLimitDto;
}

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

  @IsOptional()
  @IsString()
  @Matches(NAME)
  route?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RouteDto)
  definition?: RouteDto;
}

/** Plain data for the core: no class instances, no keys the DTO does not name. */
function routeInput(dto: RouteDto): RouteInput {
  return {
    method: dto.method,
    path: dto.path,
    upstream: dto.upstream,
    upstreamPath: dto.upstreamPath,
    ...(dto.maxBodySize === undefined ? {} : { maxBodySize: dto.maxBodySize }),
    ...(dto.origins === undefined ? {} : { origins: [...dto.origins] }),
    ...(dto.rateLimit === undefined
      ? {}
      : {
          rateLimit: {
            requests: dto.rateLimit.requests,
            window: dto.rateLimit.window,
            ...(dto.rateLimit.per === undefined
              ? {}
              : { per: dto.rateLimit.per }),
          },
        }),
  };
}

/**
 * The edit the DTO describes, or null when a field its operation needs is missing or one it does
 * not take is present (400).
 */
export function toConfigEdit(dto: ConfigEditDto): ConfigEdit | null {
  const { op, environment, gate, route, definition } = dto;
  const only = (...given: readonly unknown[]) =>
    [environment, gate, route, definition].filter(
      (value) => value !== undefined,
    ).length === given.length && given.every((value) => value !== undefined);
  switch (op) {
    case 'addEnvironment':
    case 'lockEnvironment':
    case 'unlockEnvironment':
      return environment !== undefined && only(environment)
        ? { op, environment }
        : null;
    case 'lockGate':
    case 'unlockGate':
      return gate !== undefined && only(gate) ? { op, gate } : null;
    case 'assignGate':
      return gate !== undefined &&
        environment !== undefined &&
        only(gate, environment)
        ? { op, gate, environment }
        : null;
    case 'addRoute':
    case 'updateRoute':
      return route !== undefined &&
        definition !== undefined &&
        only(route, definition)
        ? { op, route, definition: routeInput(definition) }
        : null;
    case 'removeRoute':
    case 'enableRoute':
    case 'disableRoute':
      return route !== undefined && only(route) ? { op, route } : null;
  }
}
