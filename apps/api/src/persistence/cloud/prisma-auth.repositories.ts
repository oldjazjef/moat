import { Injectable } from '@nestjs/common';
import {
  AccountRepositoryPort,
  type AccountRecord,
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
