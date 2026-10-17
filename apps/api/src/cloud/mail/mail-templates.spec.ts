import { describe, expect, it } from 'vitest';
import {
  alreadyRegisteredMail,
  invitationMail,
  resetPasswordMail,
  verifyEmailMail,
} from './mail-templates';

const LINKS = { publicUrl: 'https://moat.example.org' };
const TOKEN = 'T'.repeat(43);

describe('mail templates', () => {
  it('carry the token in the fragment of a link to this installation, in German and English', () => {
    for (const mail of [
      verifyEmailMail('a@example.ch', LINKS, TOKEN),
      resetPasswordMail('a@example.ch', LINKS, TOKEN),
    ]) {
      const links = mail.text.match(/https:\/\/[^\s]+/g) ?? [];
      expect(links).toHaveLength(2);
      for (const link of links)
        expect(link).toMatch(
          /^https:\/\/moat\.example\.org\/(verify-email|reset-password)#token=T{43}$/,
        );
      expect(mail.text).toContain('Guten Tag');
      expect(mail.text).toContain('Hello');
      expect(mail.to).toBe('a@example.ch');
    }
  });

  it('have no variable but the link: nothing a person typed can reach a stranger', () => {
    const mails = [
      verifyEmailMail('a@example.ch', LINKS, TOKEN),
      resetPasswordMail('a@example.ch', LINKS, TOKEN),
      alreadyRegisteredMail('a@example.ch', LINKS),
      invitationMail('a@example.ch', LINKS),
    ];
    for (const mail of mails) {
      // The recipient's own address is only the envelope, not the text.
      expect(mail.text).not.toContain('a@example.ch');
      expect(mail.subject).not.toContain('a@example.ch');
    }
    expect(invitationMail('a@example.ch', LINKS).text).not.toMatch(/#token=/);
    expect(alreadyRegisteredMail('a@example.ch', LINKS).text).not.toMatch(
      /#token=/,
    );
  });
});
