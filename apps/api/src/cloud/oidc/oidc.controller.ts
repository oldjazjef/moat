import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../../config/env';
import type { Principal } from '../auth/application/auth.commands';
import { CurrentPrincipal, Public } from '../auth/auth.http';
import { LinkOidcDto } from '../auth/dto/auth.dto';
import {
  readCookie,
  sessionCookie,
  sessionCookieName,
} from '../auth/domain/session';
import { clearedOidcCookie, oidcCookie, oidcCookieName } from './domain/cookie';
import type { OidcProviderView } from './application/oidc.commands';
import { OidcService } from './oidc.service';

function clientAddress(request: Request): string {
  return request.ip ?? 'unknown';
}

/** A query value that is one plain string, or ''. Extra parameters (`iss`, `scope`, …) are ignored. */
function param(request: Request, name: string): string {
  const value = request.query[name];
  return typeof value === 'string' && value.length <= 2048 ? value : '';
}

/**
 * Single sign-in with OpenID Connect (authz-matrix: `/api/auth/oidc/…`, SEC-51, T-104 to T-106).
 * Starting and finishing are plain GET navigations of the browser, so they answer with redirects
 * to fixed places on this site — never to an address the request supplied.
 */
@Controller('auth/oidc')
export class OidcController {
  private readonly secure: boolean;

  constructor(
    private readonly oidc: OidcService,
    config: ConfigService<Env, true>,
  ) {
    this.secure = config.get('MOAT_COOKIE_SECURE', { infer: true }) === 'true';
  }

  @Public()
  @Get('providers')
  async providers(
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ providers: readonly OidcProviderView[] }> {
    response.setHeader('Cache-Control', 'no-store');
    return { providers: await this.oidc.providers() };
  }

  /** Sends the browser to the provider; the secret cookie binds the way back to it. */
  @Public()
  @Get('callback')
  async callback(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const result =
      param(request, 'error') !== ''
        ? ({ status: 'failed', code: 'failed', purpose: 'login' } as const)
        : await this.oidc.finish(
            param(request, 'state'),
            param(request, 'code'),
            readCookie(request.headers.cookie, oidcCookieName(this.secure)),
            readCookie(request.headers.cookie, sessionCookieName(this.secure)),
            clientAddress(request),
          );
    const cookies = [clearedOidcCookie(this.secure)];
    let target: string;
    if (result.status === 'signed_in') {
      cookies.push(
        sessionCookie(
          result.session.token,
          this.secure,
          result.session.maxAgeSeconds,
        ),
      );
      target = '/app';
    } else if (result.status === 'linked') {
      target = '/app/account?sso=linked';
    } else {
      target =
        result.purpose === 'link'
          ? `/app/account?sso=${result.code}`
          : `/login?sso=${result.code}`;
    }
    response.setHeader('Set-Cookie', cookies);
    response.redirect(302, target);
  }

  @Public()
  @Get(':provider/start')
  async start(
    @Param('provider') provider: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.oidc.startLogin(provider, clientAddress(request));
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'rate_limited') {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException({ statusCode: 429, error: 'rate_limited' }, 429);
    }
    if (result.status === 'unavailable') {
      response.redirect(302, '/login?sso=failed');
      return;
    }
    response.setHeader(
      'Set-Cookie',
      oidcCookie(result.browserSecret, this.secure),
    );
    response.redirect(302, result.url);
  }

  /** A signed-in person links a provider to the account: the password again, then the address to go to. */
  @Post(':provider/link')
  @HttpCode(200)
  async link(
    @CurrentPrincipal() principal: Principal,
    @Param('provider') provider: string,
    @Body() body: LinkOidcDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ url: string }> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.oidc.startLink(
      principal.accountId,
      body.password,
      provider,
      clientAddress(request),
    );
    switch (result.status) {
      case 'ok':
        response.setHeader(
          'Set-Cookie',
          oidcCookie(result.browserSecret, this.secure),
        );
        return { url: result.url };
      case 'not_found':
        throw new NotFoundException();
      case 'rate_limited':
        response.setHeader('Retry-After', String(result.retryAfterSeconds));
        throw new HttpException(
          { statusCode: 429, error: 'rate_limited' },
          429,
        );
      case 'unavailable':
        throw new HttpException(
          { statusCode: 502, error: 'sso_unavailable' },
          502,
        );
      case 'refused':
        throw new UnauthorizedException({
          statusCode: 401,
          error: result.code,
        });
    }
  }
}
