import { Injectable } from '@nestjs/common';
import { type AuditEvent, chainAudit } from '@moat/core';
import { Clock, iso } from '../../common/clock';
import { AuditLogPort } from '../ports/audit.ports';

const ATTEMPTS = 8;

/**
 * What the handlers call after a change (SEC-53): chains one row to the organisation's log. Not a
 * CQRS surface — it is invoked from inside other handlers (as etx' AuditLogService). Two writers at
 * once pick the same seq; the loser's append reports `conflict` and it reads the head again.
 *
 * The change itself and its row are two writes, not one transaction: if the row cannot be written
 * the request fails (500) although the change stands. The log never claims what did not happen,
 * but a change can lack its row in that case (T-87, "Not yet").
 */
@Injectable()
export class AuditTrail {
  constructor(
    private readonly log: AuditLogPort,
    private readonly clock: Clock,
  ) {}

  async record(
    organisationId: string,
    actorId: string,
    event: AuditEvent,
  ): Promise<void> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const head = await this.log.head(organisationId);
      const row = await chainAudit(
        head === null ? null : { seq: head.seq, hash: head.hash },
        organisationId,
        iso(this.clock.now()),
        actorId,
        event,
      );
      if ((await this.log.append(row)) === 'ok') return;
    }
    throw new Error('The audit log could not be written');
  }
}
