import { AccountMails } from '../auth/application/account-mails';
import { RateLimiter } from '../auth/application/rate-limiter';
import { AuditTrail } from '../audit/application/audit-trail';
import { Clock } from '../common/clock';
import { MailerPort, MailLinks, type MailMessage } from '../mail/mail.ports';
import { MailOutbox } from '../mail/smtp-mailer';
import { InvitationRedeemer } from '../tenancy/application/invitation-redeemer';
import {
  InMemoryAccounts,
  InMemoryAccountTokens,
  InMemoryInvitations,
  InMemoryOrganisations,
  InMemoryRateLimit,
} from './in-memory';

export const PUBLIC_URL = 'https://moat.example.org';

/** A mail server that keeps what it was given (and can be told to fail). */
export class RecordingMailer extends MailerPort {
  readonly sent: MailMessage[] = [];
  failing = false;
  constructor(readonly enabled: boolean) {
    super();
  }
  send(message: MailMessage): Promise<void> {
    if (this.failing) return Promise.reject(new Error('down'));
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** Everything the e-mail flows need, over in-memory ports. */
export function mailKit(
  enabled: boolean,
  accounts: InMemoryAccounts,
  organisations: InMemoryOrganisations,
  clock: Clock,
  audit: AuditTrail,
  rate: InMemoryRateLimit = new InMemoryRateLimit(),
) {
  const mailer = new RecordingMailer(enabled);
  const outbox = new MailOutbox(mailer);
  const tokens = new InMemoryAccountTokens();
  const invitations = new InMemoryInvitations();
  const links = new MailLinks(PUBLIC_URL);
  const limiter = new RateLimiter(rate, clock);
  const mails = new AccountMails(outbox, tokens, limiter, clock, links);
  const redeemer = new InvitationRedeemer(
    invitations,
    organisations,
    audit,
    clock,
  );
  return {
    accounts,
    mailer,
    outbox,
    tokens,
    invitations,
    links,
    limiter,
    mails,
    redeemer,
  };
}

/** The token inside the link of a mail (`…#token=<43 characters>`). */
export function tokenIn(message: MailMessage | undefined): string {
  const match = /#token=([A-Za-z0-9_-]{43})/.exec(message?.text ?? '');
  if (match?.[1] === undefined) throw new Error('no link in the mail');
  return match[1];
}
