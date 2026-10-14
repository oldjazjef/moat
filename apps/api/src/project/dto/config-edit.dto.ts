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
import {
  MAX_BUDGET_TOKENS,
  MAX_USAGE_TOKENS,
  METHODS,
  QUOTA_PERIODS,
  RECIPE_IDS,
  type RecipeId,
  USAGE_FORMATS,
  type UsageFormat,
  type QuotaPeriod,
  type RouteInput,
  type UpstreamAuthInput,
  type UpstreamInput,
} from '@moat/core';
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

/** FR-31: requests per calendar day or month. */
export class QuotaDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  requests!: number;

  @IsIn(QUOTA_PERIODS)
  period!: QuotaPeriod;
}

/** FR-31: decimal amounts as text ("5.00"); the core's schema checks their form and range. */
export class CostDto {
  @IsString()
  @MaxLength(32)
  limit!: string;

  @IsString()
  @MaxLength(32)
  inputPerMillion!: string;

  @IsString()
  @MaxLength(32)
  outputPerMillion!: string;
}

/** FR-31: tokens and/or cost per calendar day or month, for an AI API. */
export class BudgetDto {
  @IsIn(USAGE_FORMATS)
  usage!: UsageFormat;

  @IsIn(QUOTA_PERIODS)
  period!: QuotaPeriod;

  /** The highest output cap (`max_tokens` & co.) a request may ask for; others are refused. */
  @IsInt()
  @Min(1)
  @Max(MAX_USAGE_TOKENS)
  maxOutputTokens!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BUDGET_TOKENS)
  tokens?: number;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CostDto)
  cost?: CostDto;
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

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => QuotaDto)
  quota?: QuotaDto;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => BudgetDto)
  budget?: BudgetDto;
}

export const AUTH_TYPES = ['bearer', 'header', 'query'] as const;

/** `secret` names a sealed secret; the value never travels here (SEC-31). */
export class UpstreamAuthDto {
  @IsIn(AUTH_TYPES)
  type!: (typeof AUTH_TYPES)[number];

  @IsString()
  @Matches(NAME)
  secret!: string;

  /** The header, for `type: header`. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;

  /** The query parameter, for `type: query`. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  param?: string;
}

/** An upstream as the desktop's form sends it; the core's schema decides the values. */
export class UpstreamDto {
  @IsString()
  @MaxLength(MAX_VALUE)
  origin!: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpstreamAuthDto)
  auth?: UpstreamAuthDto;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  timeout?: string;
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

  @IsOptional()
  @IsString()
  @Matches(NAME)
  upstream?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UpstreamDto)
  upstreamDefinition?: UpstreamDto;

  @IsOptional()
  @IsIn(RECIPE_IDS)
  recipe?: RecipeId;

  /** applyRecipe: where the website runs (FR-15); the core's schema checks each origin. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(MAX_VALUE, { each: true })
  origins?: string[];
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
    ...(dto.quota === undefined
      ? {}
      : {
          quota: { requests: dto.quota.requests, period: dto.quota.period },
        }),
    ...(dto.budget === undefined ? {} : { budget: budgetInput(dto.budget) }),
  };
}

function budgetInput(dto: BudgetDto): NonNullable<RouteInput['budget']> {
  return {
    usage: dto.usage,
    period: dto.period,
    maxOutputTokens: dto.maxOutputTokens,
    ...(dto.tokens === undefined ? {} : { tokens: dto.tokens }),
    ...(dto.cost === undefined
      ? {}
      : {
          cost: {
            limit: dto.cost.limit,
            inputPerMillion: dto.cost.inputPerMillion,
            outputPerMillion: dto.cost.outputPerMillion,
          },
        }),
  };
}

/** The auth the DTO describes, or null when it has a key its type does not take or lacks one. */
function authInput(dto: UpstreamAuthDto): UpstreamAuthInput | null {
  const { type, secret, name, param } = dto;
  if (type === 'bearer')
    return name === undefined && param === undefined ? { type, secret } : null;
  if (type === 'header')
    return name !== undefined && param === undefined
      ? { type, name, secret }
      : null;
  return param !== undefined && name === undefined
    ? { type, param, secret }
    : null;
}

function upstreamInput(dto: UpstreamDto): UpstreamInput | null {
  const auth = dto.auth === undefined ? undefined : authInput(dto.auth);
  if (auth === null) return null;
  return {
    origin: dto.origin,
    ...(auth === undefined ? {} : { auth }),
    ...(dto.timeout === undefined ? {} : { timeout: dto.timeout }),
  };
}

/**
 * The edit the DTO describes, or null when a field its operation needs is missing or one it does
 * not take is present (400).
 */
export function toConfigEdit(dto: ConfigEditDto): ConfigEdit | null {
  const { op, environment, gate, route, definition } = dto;
  const { upstream, upstreamDefinition, recipe, origins } = dto;
  const only = (...given: readonly unknown[]) =>
    [
      environment,
      gate,
      route,
      definition,
      upstream,
      upstreamDefinition,
      recipe,
      origins,
    ].filter((value) => value !== undefined).length === given.length &&
    given.every((value) => value !== undefined);
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
    case 'addUpstream':
    case 'updateUpstream': {
      if (
        upstream === undefined ||
        upstreamDefinition === undefined ||
        !only(upstream, upstreamDefinition)
      )
        return null;
      const input = upstreamInput(upstreamDefinition);
      return input === null
        ? null
        : { op, upstream, upstreamDefinition: input };
    }
    case 'removeUpstream':
      return upstream !== undefined && only(upstream) ? { op, upstream } : null;
    case 'applyRecipe':
      if (recipe === undefined) return null;
      if (origins === undefined) return only(recipe) ? { op, recipe } : null;
      return only(recipe, origins)
        ? { op, recipe, origins: [...origins] }
        : null;
  }
}
