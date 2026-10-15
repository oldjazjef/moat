import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../../config/env';
import type { Principal } from './application/auth.commands';
import { AuthService } from './auth.service';
import {
  CSRF_HEADER,
  csrfMatches,
  readCookie,
  sessionCookieName,
} from './domain/session';

/** A request after authentication: who is calling (never serialised). */
export interface AuthedRequest extends Request {
  principal?: Principal;
}

const PUBLIC = 'moat:public';
/** The route needs no session (register, login, health). Everything else does: fail closed. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC, true);

/** The signed-in caller; only on routes that are not `@Public()`. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = context
      .switchToHttp()
      .getRequest<AuthedRequest>().principal;
    if (principal === undefined) throw new UnauthorizedException();
    return principal;
  },
);

/** The one body for every unauthenticated answer: no hint whether a cookie was missing or stale. */
function unauthenticated(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    error: 'unauthenticated',
  });
}

/**
 * Authentication, global (APP_GUARD): the session cookie → a live session → `request.principal`.
 * A missing, malformed, unknown, revoked, expired or idle session all end in the same 401.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly cookie: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.cookie = sessionCookieName(
      config.get('MOAT_COOKIE_SECURE', { infer: true }) === 'true',
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readCookie(request.headers.cookie, this.cookie);
    const principal =
      token === null ? null : await this.auth.authenticate(token);
    if (principal === null) throw unauthenticated();
    request.principal = principal;
    return true;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF, second global guard (T-78): every state-changing request of a signed-in caller must carry
 * the session's CSRF token in `x-moat-csrf`. It runs after authentication (an anonymous caller
 * gets 401, not a hint about tokens) and before any authorisation.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (request.principal === undefined || SAFE_METHODS.has(request.method))
      return true;
    if (
      !csrfMatches(request.principal.sessionToken, request.headers[CSRF_HEADER])
    )
      throw new ForbiddenException({ statusCode: 403, error: 'csrf_invalid' });
    return true;
  }
}

/**
 * Cross-site requests, before routing (T-78): an unsafe request whose `Origin` is not the
 * dashboard's own, or that a browser marks `Sec-Fetch-Site: cross-site|same-site`, is refused —
 * login and register included, which have no session to carry a token yet. A client without
 * either header (the CLI, curl) has no ambient cookies to abuse and passes.
 */
export function requireSameOrigin(expectedOrigin: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      const site = request.headers['sec-fetch-site'];
      const crossOrigin =
        (origin !== undefined && origin !== expectedOrigin) ||
        (site !== undefined && site !== 'same-origin' && site !== 'none');
      if (crossOrigin) {
        response.status(403).json({ statusCode: 403, error: 'origin_invalid' });
        return;
      }
    }
    next();
  };
}
