import { Injectable } from '@nestjs/common';
import { Clock, iso } from '../../common/clock';
import {
  csrfTokenOf,
  newSessionToken,
  SESSION_ABSOLUTE_MS,
  sessionExpiry,
  sessionIdOf,
} from '../domain/session';
import { SessionRepositoryPort } from '../ports/auth.ports';
import type { SessionGrant } from './auth.commands';

/** Starts sessions. Always a fresh token, so a token that came with the request is never kept. */
@Injectable()
export class SessionIssuer {
  constructor(
    private readonly sessions: SessionRepositoryPort,
    private readonly clock: Clock,
  ) {}

  async issue(accountId: string): Promise<SessionGrant> {
    const now = this.clock.now();
    const token = newSessionToken();
    await this.sessions.create({
      id: sessionIdOf(token),
      accountId,
      createdAt: iso(now),
      lastSeenAt: iso(now),
      expiresAt: iso(sessionExpiry(now)),
      revokedAt: null,
    });
    return {
      token,
      csrfToken: csrfTokenOf(token),
      maxAgeSeconds: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    };
  }
}
