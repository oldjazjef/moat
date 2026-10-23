import { Injectable } from '@nestjs/common';
import {
  AccountRepositoryPort,
  type AccountRecord,
  AccountTokenPort,
  type AccountTokenPurpose,
  type AccountTokenRecord,
  type ChallengePurpose,
  type ChallengeRecord,
  MAX_PASSKEYS,
  type PasskeyRecord,
  PasskeyRepositoryPort,
  RateLimitPort,
  type SessionRecord,
  SessionRepositoryPort,
  type TotpRecord,
} from '../../cloud/auth/ports/auth.ports';
import { iso } from '../../cloud/common/clock';
import { CloudDatabase } from './cloud-database';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'P2002';
}

@Injectable()
export class PrismaAccountRepository extends AccountRepositoryPort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  findByEmail(email: string): Promise<AccountRecord | null> {
    return this.db.account.findUnique({ where: { email } });
  }

  findById(id: string): Promise<AccountRecord | null> {
    return this.db.account.findUnique({ where: { id } });
  }

  async create(account: AccountRecord): Promise<'created' | 'email_taken'> {
    try {
      await this.db.account.create({ data: { ...account } });
      return 'created';
    } catch (error) {
      if (isUniqueViolation(error)) return 'email_taken';
      throw error;
    }
  }

  async changePassword(
    id: string,
    passwordHash: string,
    at: string,
  ): Promise<void> {
    await this.db.account.update({
      where: { id },
      data: { passwordHash, passwordChangedAt: at },
    });
  }

  async markEmailVerified(id: string, at: string): Promise<void> {
    await this.db.account.updateMany({
      where: { id, emailVerifiedAt: null },
      data: { emailVerifiedAt: at },
    });
  }

  async rehashPassword(id: string, passwordHash: string): Promise<void> {
    await this.db.account.update({ where: { id }, data: { passwordHash } });
  }

  async totp(accountId: string): Promise<TotpRecord | null> {
    return this.db.accountTotp.findUnique({
      where: { accountId },
      select: {
        accountId: true,
        sealedSecret: true,
        enabledAt: true,
        lastStep: true,
      },
    });
  }

  savePendingTotp(
    accountId: string,
    sealedSecret: string,
    at: string,
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.accountTotp.findUnique({
        where: { accountId },
      });
      if (existing !== null && existing.enabledAt !== null) return false;
      await tx.accountTotp.upsert({
        where: { accountId },
        create: {
          accountId,
          sealedSecret,
          enabledAt: null,
          lastStep: 0,
          createdAt: at,
        },
        update: { sealedSecret, lastStep: 0, createdAt: at },
      });
      return true;
    });
  }

  enableTotp(
    accountId: string,
    step: number,
    at: string,
    recoveryCodes: readonly { id: string; hash: string }[],
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const updated = await tx.accountTotp.updateMany({
        where: { accountId, enabledAt: null },
        data: { enabledAt: at, lastStep: step },
      });
      if (updated.count !== 1) return false;
      await tx.recoveryCode.deleteMany({ where: { accountId } });
      for (const code of recoveryCodes)
        await tx.recoveryCode.create({
          data: { id: code.id, accountId, codeHash: code.hash, createdAt: at },
        });
      return true;
    });
  }

  async advanceTotpStep(accountId: string, step: number): Promise<boolean> {
    const updated = await this.db.accountTotp.updateMany({
      where: { accountId, enabledAt: { not: null }, lastStep: { lt: step } },
      data: { lastStep: step },
    });
    return updated.count === 1;
  }

  async removeTotp(accountId: string): Promise<void> {
    await this.db.$transaction([
      this.db.recoveryCode.deleteMany({ where: { accountId } }),
      this.db.accountTotp.deleteMany({ where: { accountId } }),
    ]);
  }

  async useRecoveryCode(
    accountId: string,
    hash: string,
    at: string,
  ): Promise<boolean> {
    const updated = await this.db.recoveryCode.updateMany({
      where: { accountId, codeHash: hash, usedAt: null },
      data: { usedAt: at },
    });
    return updated.count === 1;
  }
}

@Injectable()
export class PrismaSessionRepository extends SessionRepositoryPort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  async create(session: SessionRecord): Promise<void> {
    await this.db.session.create({ data: { ...session } });
  }

  find(id: string): Promise<SessionRecord | null> {
    return this.db.session.findUnique({ where: { id } });
  }

  async touch(id: string, lastSeenAt: string): Promise<void> {
    await this.db.session.updateMany({ where: { id }, data: { lastSeenAt } });
  }

  async revoke(id: string, at: string): Promise<void> {
    await this.db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  async revokeAllOf(
    accountId: string,
    at: string,
    exceptId?: string,
  ): Promise<void> {
    await this.db.session.updateMany({
      where: {
        accountId,
        revokedAt: null,
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      data: { revokedAt: at },
    });
  }
}

@Injectable()
export class PrismaRateLimit extends RateLimitPort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  async count(key: string, now: Date): Promise<number> {
    const row = await this.db.rateLimit.findUnique({ where: { key } });
    return row !== null && row.windowEnd > iso(now) ? row.count : 0;
  }

  async windowEnd(key: string, now: Date): Promise<Date | null> {
    const row = await this.db.rateLimit.findUnique({ where: { key } });
    return row !== null && row.windowEnd > iso(now)
      ? new Date(row.windowEnd)
      : null;
  }

  async increment(key: string, windowMs: number, now: Date): Promise<number> {
    const at = iso(now);
    // The common case, atomic: still inside the window → +1.
    const bumped = await this.db.rateLimit.updateMany({
      where: { key, windowEnd: { gt: at } },
      data: { count: { increment: 1 } },
    });
    if (bumped.count === 1) {
      const row = await this.db.rateLimit.findUnique({ where: { key } });
      return row?.count ?? 1;
    }
    // A new window. Expired rows go with it, so the table stays bounded by the live windows.
    await this.db.rateLimit.deleteMany({ where: { windowEnd: { lte: at } } });
    const windowEnd = iso(new Date(now.getTime() + windowMs));
    await this.db.rateLimit.upsert({
      where: { key },
      create: { key, windowEnd, count: 1 },
      update: { windowEnd, count: 1 },
    });
    return 1;
  }
}

@Injectable()
export class PrismaAccountTokenRepository extends AccountTokenPort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  async issue(token: AccountTokenRecord): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.accountToken.updateMany({
        where: {
          accountId: token.accountId,
          purpose: token.purpose,
          usedAt: null,
        },
        data: { usedAt: token.createdAt },
      });
      await tx.accountToken.create({ data: { ...token } });
    });
  }

  async consume(
    id: string,
    purpose: AccountTokenPurpose,
    now: string,
  ): Promise<string | null> {
    // One statement decides: only one of two racing requests gets the row.
    const used = await this.db.accountToken.updateMany({
      where: { id, purpose, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count !== 1) return null;
    const row = await this.db.accountToken.findUnique({ where: { id } });
    return row?.accountId ?? null;
  }

  async revokeAll(
    accountId: string,
    purpose: AccountTokenPurpose,
    at: string,
  ): Promise<void> {
    await this.db.accountToken.updateMany({
      where: { accountId, purpose, usedAt: null },
      data: { usedAt: at },
    });
  }
}

@Injectable()
export class PrismaPasskeyRepository extends PasskeyRepositoryPort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  list(accountId: string): Promise<readonly PasskeyRecord[]> {
    return this.db.accountPasskey.findMany({
      where: { accountId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  findByCredential(credentialId: string): Promise<PasskeyRecord | null> {
    return this.db.accountPasskey.findUnique({ where: { credentialId } });
  }

  async add(
    passkey: PasskeyRecord,
  ): Promise<'ok' | 'limit' | 'credential_taken'> {
    try {
      return await this.db.$transaction(async (tx) => {
        const count = await tx.accountPasskey.count({
          where: { accountId: passkey.accountId },
        });
        if (count >= MAX_PASSKEYS) return 'limit' as const;
        await tx.accountPasskey.create({ data: { ...passkey } });
        return 'ok' as const;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'credential_taken';
      throw error;
    }
  }

  async remove(accountId: string, id: string): Promise<boolean> {
    const removed = await this.db.accountPasskey.deleteMany({
      where: { accountId, id },
    });
    return removed.count === 1;
  }

  async recordUse(id: string, signCount: number, at: string): Promise<boolean> {
    // One statement decides: the counter must rise, unless the authenticator keeps none (0 → 0).
    const updated = await this.db.accountPasskey.updateMany({
      where: {
        id,
        OR: [
          { signCount: { lt: signCount } },
          ...(signCount === 0 ? [{ signCount: 0 }] : []),
        ],
      },
      data: { signCount, lastUsedAt: at },
    });
    return updated.count === 1;
  }

  async issueChallenge(challenge: ChallengeRecord): Promise<void> {
    await this.db.$transaction([
      this.db.webauthnChallenge.deleteMany({
        where: {
          accountId: challenge.accountId,
          expiresAt: { lte: challenge.createdAt },
        },
      }),
      this.db.webauthnChallenge.create({ data: { ...challenge } }),
    ]);
  }

  async consumeChallenge(
    id: string,
    accountId: string,
    purpose: ChallengePurpose,
    now: string,
  ): Promise<boolean> {
    const used = await this.db.webauthnChallenge.deleteMany({
      where: { id, accountId, purpose, expiresAt: { gt: now } },
    });
    return used.count === 1;
  }
}
