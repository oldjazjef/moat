import { Injectable } from '@nestjs/common';
import { Clock, iso } from '../../common/clock';
import {
  hashRecoveryCode,
  parseRecoveryCode,
  parseTotpCode,
  verifyTotp,
} from '../domain/totp';
import { AccountRepositoryPort, type TotpRecord } from '../ports/auth.ports';
import { TotpVault } from './totp-vault';

/** Checks what a person typed as the second factor: a TOTP code or one recovery code. */
@Injectable()
export class SecondFactor {
  constructor(
    private readonly accounts: AccountRepositoryPort,
    private readonly vault: TotpVault,
    private readonly clock: Clock,
  ) {}

  /** True once: a TOTP step and a recovery code each work a single time. */
  async verify(
    accountId: string,
    totp: TotpRecord,
    input: string,
  ): Promise<boolean> {
    const recovery = parseRecoveryCode(input);
    if (recovery !== null)
      return this.accounts.useRecoveryCode(
        accountId,
        hashRecoveryCode(recovery),
        iso(this.clock.now()),
      );
    const step = await this.stepOf(accountId, totp, input);
    return step !== null && this.accounts.advanceTotpStep(accountId, step);
  }

  /** The step a TOTP code is valid for (not yet recorded), or null. */
  async stepOf(
    accountId: string,
    totp: TotpRecord,
    input: string,
  ): Promise<number | null> {
    const code = parseTotpCode(input);
    if (code === null) return null;
    const secret = await this.vault.open(totp.sealedSecret, accountId);
    if (secret === null) return null;
    try {
      return verifyTotp(
        secret,
        code,
        this.clock.now().getTime(),
        totp.lastStep,
      );
    } finally {
      secret.fill(0);
    }
  }
}
