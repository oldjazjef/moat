import { Injectable } from '@nestjs/common';
import { AuditTrail } from '../../audit/application/audit-trail';
import { Clock, iso } from '../../common/clock';
import {
  InvitationRepositoryPort,
  OrganisationRepositoryPort,
} from '../ports/tenancy.ports';

/** How long an invitation to an unknown address waits for that address to be verified. */
export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Applies the invitations that wait for an address, once that address belongs to a verified
 * account (a link from its mailbox was opened, or the deployment has no mail and the account was
 * just created). An invitation is taken exactly once, with no release permission (SEC-52: that
 * is granted separately), and each membership it creates is written to the organisation's audit log.
 */
@Injectable()
export class InvitationRedeemer {
  constructor(
    private readonly invitations: InvitationRepositoryPort,
    private readonly organisations: OrganisationRepositoryPort,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
  ) {}

  async redeem(accountId: string, email: string): Promise<void> {
    const now = iso(this.clock.now());
    for (const invitation of await this.invitations.takeAllFor(email, now)) {
      const outcome = await this.organisations.addMember({
        organisationId: invitation.organisationId,
        accountId,
        role: invitation.role,
        releaseGranted: false,
        createdAt: now,
      });
      if (outcome === 'added')
        await this.audit.record(invitation.organisationId, accountId, {
          action: 'member.join',
          target: accountId,
          details: { role: invitation.role },
        });
    }
  }
}
