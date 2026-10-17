import { Injectable, Logger } from '@nestjs/common';
import { MailError, MailerPort, type MailMessage } from './mail.ports';
import { sendSmtp, type SmtpSettings } from './smtp-client';

/** The configured SMTP server. */
@Injectable()
export class SmtpMailer extends MailerPort {
  readonly enabled = true;

  constructor(private readonly settings: SmtpSettings) {
    super();
  }

  send(message: MailMessage): Promise<void> {
    return sendSmtp(this.settings, message);
  }
}

/** No SMTP server: nothing is sent, and the flows that need a mail are switched off by `enabled`. */
@Injectable()
export class NoMailer extends MailerPort {
  readonly enabled = false;

  send(): Promise<void> {
    return Promise.reject(new MailError('connect'));
  }
}

/**
 * Sends in the background and in order, so that a slow or broken mail server never slows or
 * fails a request (and a request cannot tell, by its duration, whether a mail went out: an
 * unknown address and a known one cost the same, T-79). Bounded: when the queue is full, new
 * mails are dropped and counted. A failure is logged as its fixed name, never with an address.
 */
@Injectable()
export class MailOutbox {
  private readonly log = new Logger('MailOutbox');
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  static readonly MAX_PENDING = 100;

  constructor(private readonly mailer: MailerPort) {}

  get enabled(): boolean {
    return this.mailer.enabled;
  }

  enqueue(message: MailMessage): void {
    if (!this.mailer.enabled) return;
    if (this.pending >= MailOutbox.MAX_PENDING) {
      this.log.warn('mail queue full, a mail was dropped');
      return;
    }
    this.pending += 1;
    this.tail = this.tail.then(async () => {
      try {
        await this.mailer.send(message);
      } catch (error) {
        const failure = error instanceof MailError ? error.failure : 'unknown';
        this.log.warn(`mail not sent: ${failure}`);
      } finally {
        this.pending -= 1;
      }
    });
  }

  /** Resolves when everything queued so far was tried (shutdown and tests). */
  async drain(): Promise<void> {
    await this.tail;
  }
}
