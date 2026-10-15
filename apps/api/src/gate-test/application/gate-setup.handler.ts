import { ConfigService } from '@nestjs/config';
import { Command, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  parseSetupAnswer,
  SETUP_TOKEN,
  SetupAnswerError,
  type GateSetupIdentity,
} from '@moat/core';
import type { Env } from '../../config/env';
import { ProjectRegistryPort } from '../../project/ports/project-registry.port';
import { PROJECT_ID } from '../../project/project.types';
import { GateClientPort, type GateFailure } from '../ports/gate-client.port';
import { GateTestConfirmationPort } from '../ports/gate-test-confirmation.port';
import { gateSetupTarget } from './gate-test-target';

export type GateSetupRefusal =
  /** Not the https:// URL of a `.php` gate file (gateSetupTarget). */
  | 'url_invalid'
  /** Not 32 bytes as base64url, as `php moat-gate.php setup` printed it. */
  | 'token_invalid'
  /** The person did not confirm the address in the desktop's own dialog (T-59). */
  | 'not_confirmed'
  /** Another read is still running: one at a time. */
  | 'busy'
  /**
   * The gate answered with its plain 404: the setup mode is off, has expired, or the token is
   * wrong. The gate does not tell which (T-73), and neither does this.
   */
  | 'setup_off'
  /** The gate answered, but not with a well-formed identity (or the fingerprint did not match). */
  | 'answer_invalid';

export type GateSetupResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: GateSetupRefusal }
  | { readonly status: 'read'; readonly identity: GateSetupIdentity }
  | { readonly status: 'failed'; readonly reason: GateFailure };

/**
 * Reads a gate's public identity from its setup mode (SEC-28, SEC-32, T-73) so a person without a
 * shell on the server can pin the gate: gate id, box key and the fingerprints to compare. One GET
 * to the gate file with `?moat-setup` and the token in a header, only after the person confirmed
 * the address outside the page (T-59). The answer is read strictly and the box key's fingerprint
 * is computed here, not taken from the gate. The token appears in no result and no error.
 */
export class GateSetupCommand extends Command<GateSetupResult> {
  constructor(
    readonly id: string,
    readonly url: string,
    readonly token: string,
    /** The page's language, for the confirmation dialog only. */
    readonly locale: string,
  ) {
    super();
  }
}

@CommandHandler(GateSetupCommand)
export class GateSetupHandler implements ICommandHandler<GateSetupCommand> {
  private readonly allowLoopback: boolean;

  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly client: GateClientPort,
    private readonly confirmation: GateTestConfirmationPort,
    config: ConfigService<Env, true>,
  ) {
    this.allowLoopback =
      config.get('MOAT_GATE_TEST_LOOPBACK', { infer: true }) === 'true';
  }

  private running = false;

  async execute(command: GateSetupCommand): Promise<GateSetupResult> {
    if (!PROJECT_ID.test(command.id) || this.registry.get(command.id) === null)
      return { status: 'not_found' };
    const target = gateSetupTarget(command.url, this.allowLoopback);
    if (target === null) return { status: 'refused', code: 'url_invalid' };
    if (!SETUP_TOKEN.test(command.token))
      return { status: 'refused', code: 'token_invalid' };
    if (this.running) return { status: 'refused', code: 'busy' };
    this.running = true;
    try {
      if (!(await this.confirmation.confirm(target, command.locale)))
        return { status: 'refused', code: 'not_confirmed' };
      const reply = await this.client.setup(target, command.token);
      if (reply.status === 'failed')
        return { status: 'failed', reason: reply.reason };
      try {
        const encoding = (reply.contentEncoding ?? 'identity')
          .trim()
          .toLowerCase();
        if (reply.httpStatus === 404)
          return { status: 'refused', code: 'setup_off' };
        if (reply.httpStatus !== 200 || encoding !== 'identity')
          return { status: 'refused', code: 'answer_invalid' };
        return {
          status: 'read',
          identity: await parseSetupAnswer(reply.body),
        };
      } catch (error) {
        if (error instanceof SetupAnswerError)
          return { status: 'refused', code: 'answer_invalid' };
        throw error;
      } finally {
        reply.body.fill(0);
      }
    } finally {
      this.running = false;
    }
  }
}
