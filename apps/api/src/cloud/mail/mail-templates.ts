import type { MailMessage } from './mail.ports';

/**
 * The mails Moat Cloud sends. Fixed texts in German and English; the only variable is a link the
 * server builds itself. **Nothing a person typed goes into a mail** (no organisation name, no
 * display name): a mail from this address must not be a way to put someone's words in a stranger's
 * inbox (phishing, T-97). The token sits in the link's fragment, so it reaches no server log and
 * no Referer header; the page reads it and posts it.
 */
export interface MailLinks {
  /** The public address of this installation, e.g. `https://moat.example.org` (no trailing slash). */
  readonly publicUrl: string;
}

const tokenLink = (links: MailLinks, path: string, token: string): string =>
  `${links.publicUrl}${path}#token=${token}`;

export function verifyEmailMail(
  to: string,
  links: MailLinks,
  token: string,
): MailMessage {
  const link = tokenLink(links, '/verify-email', token);
  return {
    to,
    subject: 'Moat: E-Mail-Adresse bestätigen / Confirm your e-mail address',
    text: [
      'Guten Tag',
      '',
      'Bitte bestätige deine E-Mail-Adresse für Moat Cloud. Der Link gilt 24 Stunden und nur einmal:',
      link,
      '',
      'Wenn du dich nicht registriert hast, kannst du diese Nachricht ignorieren.',
      '',
      '---',
      '',
      'Hello',
      '',
      'Please confirm your e-mail address for Moat Cloud. The link works once and for 24 hours:',
      link,
      '',
      'If you did not register, you can ignore this message.',
    ].join('\n'),
  };
}

export function resetPasswordMail(
  to: string,
  links: MailLinks,
  token: string,
): MailMessage {
  const link = tokenLink(links, '/reset-password', token);
  return {
    to,
    subject: 'Moat: Passwort zurücksetzen / Reset your password',
    text: [
      'Guten Tag',
      '',
      'Für dein Konto wurde ein neues Passwort angefordert. Der Link gilt 1 Stunde und nur einmal:',
      link,
      '',
      'Beim Zurücksetzen werden alle angemeldeten Sitzungen beendet. Wenn du das nicht angefordert hast, ignoriere diese Nachricht: dein Passwort bleibt, wie es ist.',
      '',
      '---',
      '',
      'Hello',
      '',
      'A new password was requested for your account. The link works once and for 1 hour:',
      link,
      '',
      'Resetting ends every signed-in session. If you did not request it, ignore this message: your password stays as it is.',
    ].join('\n'),
  };
}

/** Sent when someone registers with an address that has an account already (the page says nothing, T-79). */
export function alreadyRegisteredMail(
  to: string,
  links: MailLinks,
): MailMessage {
  return {
    to,
    subject: 'Moat: Du hast schon ein Konto / You already have an account',
    text: [
      'Guten Tag',
      '',
      `Jemand hat versucht, mit dieser E-Mail-Adresse ein Konto bei Moat Cloud (${links.publicUrl}) anzulegen. Du hast schon eins. Wenn du dein Passwort vergessen hast, kannst du es auf der Anmeldeseite zurücksetzen. Wenn du das nicht warst, musst du nichts tun.`,
      '',
      '---',
      '',
      'Hello',
      '',
      `Someone tried to create an account at Moat Cloud (${links.publicUrl}) with this e-mail address. You already have one. If you forgot your password, you can reset it on the sign-in page. If this was not you, you do not need to do anything.`,
    ].join('\n'),
  };
}

/** Sent to an address that was added to an organisation: it names no organisation and no person. */
export function invitationMail(to: string, links: MailLinks): MailMessage {
  return {
    to,
    subject: 'Moat: Einladung / Invitation',
    text: [
      'Guten Tag',
      '',
      `Du wurdest zu einer Organisation bei Moat Cloud eingeladen (${links.publicUrl}). Registriere dich mit dieser E-Mail-Adresse oder melde dich damit an und bestätige die Adresse: Die Einladung wird dann angewendet. Sie gilt 14 Tage.`,
      '',
      'Wenn du nichts damit anfangen kannst, ignoriere diese Nachricht.',
      '',
      '---',
      '',
      'Hello',
      '',
      `You were invited to an organisation at Moat Cloud (${links.publicUrl}). Register with this e-mail address, or sign in with it and confirm the address: the invitation is applied then. It is valid for 14 days.`,
      '',
      'If this means nothing to you, ignore this message.',
    ].join('\n'),
  };
}
