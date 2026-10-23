import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import type { Env } from '../../config/env';
import { relyingPartyOf } from './domain/passkey';
import { AUTH_HANDLERS } from './application/auth.handlers';
import { LoginGate } from './application/login-gate';
import { MAIL_HANDLERS } from './application/mail.handlers';
import { PASSKEY_HANDLERS } from './application/passkey.handlers';
import { PasskeyRp, PasskeyService } from './application/passkey-service';
import { PasswordHasher } from './application/password-hasher';
import { SecondFactor } from './application/second-factor';
import { SessionIssuer } from './application/session-issuer';
import { TotpVault } from './application/totp-vault';
import { AuthController } from './auth.controller';
import { AuthGuard, CsrfGuard } from './auth.http';
import { AuthService } from './auth.service';

@Module({
  imports: [CqrsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    ...AUTH_HANDLERS,
    ...MAIL_HANDLERS,
    ...PASSKEY_HANDLERS,
    SessionIssuer,
    SecondFactor,
    LoginGate,
    PasskeyService,
    {
      provide: PasskeyRp,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new PasskeyRp(
          relyingPartyOf(config.get('MOAT_PUBLIC_ORIGIN', { infer: true })),
        ),
    },
    {
      provide: PasswordHasher,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new PasswordHasher(config.get('MOAT_PASSWORD_COST', { infer: true })),
    },
    {
      provide: TotpVault,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        TotpVault.create(config.get('MOAT_ACCOUNT_KEY', { infer: true })),
    },
    // Order matters: authenticate first, then the CSRF token of that session.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
