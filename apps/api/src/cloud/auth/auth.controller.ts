import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../../config/env';
import type {
  AccountView,
  Principal,
  SessionGrant,
} from './application/auth.commands';
import { CurrentPrincipal, Public } from './auth.http';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  ConfirmTotpDto,
  DisableTotpDto,
  EmailOnlyDto,
  EnrolTotpDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  TokenDto,
} from './dto/auth.dto';
import {
  clearedSessionCookie,
  csrfTokenOf,
  readCookie,
  sessionCookie,
  sessionCookieName,
} from './domain/session';

interface Refusal {
  readonly code: string;
  readonly retryAfterSeconds?: number;
}

/**
 * The same error shape everywhere: `{ statusCode, error }` with a stable code, never a message
 * that could carry a value (SEC-34).
 */
function refuse(response: Response, refusal: Refusal): never {
  switch (refusal.code) {
    case 'rate_limited':
      response.setHeader(
        'Retry-After',
        String(refusal.retryAfterSeconds ?? 60),
      );
      throw new HttpException({ statusCode: 429, error: 'rate_limited' }, 429);
    case 'invalid_credentials':
    case 'mfa_required':
    case 'invalid_code':
      throw new UnauthorizedException({
        statusCode: 401,
        error: refusal.code,
      });
    case 'email_not_verified':
      throw new ForbiddenException({ statusCode: 403, error: refusal.code });
    case 'already_enabled':
    case 'not_pending':
    case 'not_enabled':
      throw new ConflictException({ statusCode: 409, error: refusal.code });
    default:
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: refusal.code,
      });
  }
}

/** The address a request came from; behind proxies `MOAT_TRUST_PROXY` tells Express how many. */
function clientAddress(request: Request): string {
  return request.ip ?? 'unknown';
}

/** Routes under `/api/auth` (authz-matrix). Register, login and the four mail flows are the public ones. */
@Controller('auth')
export class AuthController {
  private readonly secure: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.secure = config.get('MOAT_COOKIE_SECURE', { infer: true }) === 'true';
  }

  /** 202 whether the address was new or taken: nothing tells them apart (T-79). */
  @Public()
  @Post('register')
  @HttpCode(202)
  async register(
    @Body() body: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'accepted' }> {
    const result = await this.auth.register(
      body.email,
      body.password,
      clientAddress(request),
    );
    if (result.status === 'refused') refuse(response, result);
    return { status: 'accepted' };
  }

  /** 200 or one plain `invalid_token`: expired, used and never-issued look the same. */
  @Public()
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body() body: TokenDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'ok' }> {
    const result = await this.auth.verifyEmail(
      body.token,
      clientAddress(request),
    );
    if (result.status === 'refused') refuse(response, result);
    return { status: 'ok' };
  }

  /** 202 for every address (T-79); a mail goes out only for an unverified account. */
  @Public()
  @Post('resend-verification')
  @HttpCode(202)
  async resendVerification(
    @Body() body: EmailOnlyDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'accepted' }> {
    const result = await this.auth.resendVerification(
      body.email,
      clientAddress(request),
    );
    if (result.status === 'refused') refuse(response, result);
    return { status: 'accepted' };
  }

  /** 202 for every address (T-79). */
  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(
    @Body() body: EmailOnlyDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'accepted' }> {
    const result = await this.auth.forgotPassword(
      body.email,
      clientAddress(request),
    );
    if (result.status === 'refused') refuse(response, result);
    return { status: 'accepted' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(
    @Body() body: ResetPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'ok' }> {
    const result = await this.auth.resetPassword(
      body.token,
      body.newPassword,
      clientAddress(request),
    );
    if (result.status === 'refused') refuse(response, result);
    return { status: 'ok' };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ account: AccountView; csrfToken: string }> {
    const result = await this.auth.login(
      body.email,
      body.password,
      body.code,
      clientAddress(request),
      readCookie(request.headers.cookie, sessionCookieName(this.secure)),
    );
    if (result.status === 'refused') refuse(response, result);
    this.setSession(response, result.session);
    return { account: result.account, csrfToken: result.session.csrfToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(principal.sessionId);
    response.setHeader('Set-Cookie', clearedSessionCookie(this.secure));
  }

  /** The caller, and the CSRF token to send with every state-changing request. */
  @Get('me')
  async me(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ account: AccountView; csrfToken: string }> {
    const account = await this.auth.me(principal.accountId);
    if (account === null) throw new UnauthorizedException();
    return { account, csrfToken: csrfTokenOf(principal.sessionToken) };
  }

  /** Ends every session of the account and signs this device in again with a fresh one. */
  @Post('password')
  @HttpCode(200)
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body() body: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ csrfToken: string }> {
    const result = await this.auth.changePassword(
      principal.accountId,
      body.currentPassword,
      body.newPassword,
    );
    if (result.status === 'refused') refuse(response, result);
    this.setSession(response, result.session);
    return { csrfToken: result.session.csrfToken };
  }

  /** The secret is in this answer and nowhere else, ever again. */
  @Post('totp/enrol')
  @HttpCode(200)
  async enrolTotp(
    @CurrentPrincipal() principal: Principal,
    @Body() body: EnrolTotpDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const result = await this.auth.enrolTotp(
      principal.accountId,
      body.password,
    );
    if (result.status === 'refused') refuse(response, result);
    return { secret: result.secret, otpauthUri: result.otpauthUri };
  }

  /** The recovery codes are in this answer and nowhere else, ever again. */
  @Post('totp/confirm')
  @HttpCode(200)
  async confirmTotp(
    @CurrentPrincipal() principal: Principal,
    @Body() body: ConfirmTotpDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ recoveryCodes: readonly string[] }> {
    const result = await this.auth.confirmTotp(principal.accountId, body.code);
    if (result.status === 'refused') refuse(response, result);
    return { recoveryCodes: result.recoveryCodes };
  }

  @Post('totp/disable')
  @HttpCode(204)
  async disableTotp(
    @CurrentPrincipal() principal: Principal,
    @Body() body: DisableTotpDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.auth.disableTotp(
      principal.accountId,
      principal.sessionId,
      body.password,
      body.code,
    );
    if (result.status === 'refused') refuse(response, result);
  }

  private setSession(response: Response, session: SessionGrant): void {
    response.setHeader(
      'Set-Cookie',
      sessionCookie(session.token, this.secure, session.maxAgeSeconds),
    );
  }
}
