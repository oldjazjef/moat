import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { AccountMails } from '../auth/application/account-mails';
import { RateLimiter } from '../auth/application/rate-limiter';
import { InvitationRedeemer } from '../tenancy/application/invitation-redeemer';
import { MailerPort, MailLinks } from './mail.ports';
import { MailOutbox, NoMailer, SmtpMailer } from './smtp-mailer';
import type { SmtpSecurity } from './smtp-client';

/** The default SMTP port of each security mode. */
const DEFAULT_PORT: Record<SmtpSecurity, number> = {
  tls: 465,
  starttls: 587,
  none: 25,
};

/**
 * Global: the mail server (or none), the background outbox, the links and the flows both the
 * auth and the tenancy handlers use. With no `MOAT_SMTP_HOST` the mailer is `NoMailer` and every
 * flow that needs a mail is off (`enabled` is false).
 */
@Global()
@Module({
  providers: [
    {
      provide: MailerPort,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): MailerPort => {
        const host = config.get('MOAT_SMTP_HOST', { infer: true });
        const from = config.get('MOAT_MAIL_FROM', { infer: true });
        if (host === undefined || from === undefined) return new NoMailer();
        const security = config.get('MOAT_SMTP_SECURITY', { infer: true });
        const port = config.get('MOAT_SMTP_PORT', { infer: true });
        const user = config.get('MOAT_SMTP_USER', { infer: true });
        const password = config.get('MOAT_SMTP_PASSWORD', { infer: true });
        return new SmtpMailer({
          host,
          port: port === undefined ? DEFAULT_PORT[security] : Number(port),
          security,
          from,
          ...(user !== undefined && password !== undefined
            ? { user, password }
            : {}),
        });
      },
    },
    {
      provide: MailLinks,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new MailLinks(config.get('MOAT_PUBLIC_ORIGIN', { infer: true })),
    },
    MailOutbox,
    RateLimiter,
    AccountMails,
    InvitationRedeemer,
  ],
  exports: [
    MailerPort,
    MailLinks,
    MailOutbox,
    RateLimiter,
    AccountMails,
    InvitationRedeemer,
  ],
})
export class AccountMailModule {}
