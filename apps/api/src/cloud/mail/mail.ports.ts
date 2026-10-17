/** A plain-text mail to one recipient. Nothing else can be sent: no HTML, no attachment, no Cc. */
export interface MailMessage {
  /** A normalised address (see `normaliseEmail`). */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Why a mail was not sent. Fixed names only: an address or a server text never travels in one. */
export type MailFailure =
  | 'connect'
  | 'timeout'
  | 'protocol'
  | 'starttls_unavailable'
  | 'auth_failed'
  | 'rejected'
  | 'invalid_message';

export class MailError extends Error {
  constructor(readonly failure: MailFailure) {
    super(failure);
    this.name = 'MailError';
  }
}

/** The outgoing mail, behind a port so the handlers never name SMTP (and tests need no server). */
export abstract class MailerPort {
  /** False when no SMTP server is configured: nothing is sent and nothing may depend on it. */
  abstract readonly enabled: boolean;
  /** Throws a `MailError`. */
  abstract send(message: MailMessage): Promise<void>;
}

/** Where this installation is reached: the base of every link in a mail (`MOAT_PUBLIC_URL`). */
export class MailLinks {
  constructor(readonly publicUrl: string) {}
}
