import { ConfigService } from '@nestjs/config';
import { Command, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  DATA_FOLDER,
  answersLikeGate,
  classifyProbes,
  inspectProbe,
  probePaths,
  type DesktopExternalResult,
  type GateProbeAnswer,
  type ProbeAnswer,
} from '@moat/core';
import type { Env } from '../../config/env';
import { ProjectRegistryPort } from '../../project/ports/project-registry.port';
import { PROJECT_ID } from '../../project/project.types';
import {
  GateClientPort,
  type GateFailure,
  type ProbeReply,
} from '../ports/gate-client.port';
import { GateTestConfirmationPort } from '../ports/gate-test-confirmation.port';
import { gateTestTarget } from './gate-test-target';

export type HardeningCheckRefusal =
  /** Not the https:// URL of a `.php` gate file (gateTestTarget, plus the file name). */
  | 'url_invalid'
  /** Not `moat-data-<32 hex>`, the name `php moat-gate.php install` printed. */
  | 'folder_invalid'
  /** The person did not confirm the address in the desktop's own dialog (T-59). */
  | 'not_confirmed'
  /** Another check is still running: one at a time. */
  | 'busy';

/** The whole check, all probes together; what is left unchecked then makes it `failed`. */
export const CHECK_DEADLINE_MS = 60_000;
/** The gate's answer to `/moat-check` is a short JSON error; more is not read as text. */
const GATE_BODY_CHARS = 256;

/**
 * What the page learns: the result, the names of the reachable data files and, when the gate
 * itself did not answer, why. Never a probe's body (it may hold key bytes).
 */
export interface HardeningCheckReport {
  readonly result: DesktopExternalResult;
  readonly reachable: readonly string[];
  readonly reason: GateFailure | null;
}

export type HardeningCheckResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: HardeningCheckRefusal }
  | { readonly status: 'checked'; readonly report: HardeningCheckReport };

/**
 * The check from outside (DT-07, SEC-49) from Moat Desktop: GETs the gate's `/moat-check`, its
 * data folder and every data file over the public URL, the way anyone on the internet could, and
 * reports which came back readable. Only after the person confirmed the address outside the page
 * (T-59); the probes are GETs without a body, cookies or credentials, to the gate's own folder.
 */
export class HardeningCheckCommand extends Command<HardeningCheckResult> {
  constructor(
    readonly id: string,
    readonly url: string,
    readonly dataFolder: string,
    /** The page's language, for the confirmation dialog only. */
    readonly locale: string,
  ) {
    super();
  }
}

@CommandHandler(HardeningCheckCommand)
export class HardeningCheckHandler implements ICommandHandler<HardeningCheckCommand> {
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

  async execute(command: HardeningCheckCommand): Promise<HardeningCheckResult> {
    if (!PROJECT_ID.test(command.id) || this.registry.get(command.id) === null)
      return { status: 'not_found' };
    const gate = gateTestTarget(command.url, '/moat-check', this.allowLoopback);
    if (
      gate === null ||
      !/\/[A-Za-z0-9._~-]+\.php\/moat-check$/.test(gate.pathname)
    )
      return { status: 'refused', code: 'url_invalid' };
    if (!DATA_FOLDER.test(command.dataFolder))
      return { status: 'refused', code: 'folder_invalid' };
    if (this.running) return { status: 'refused', code: 'busy' };
    this.running = true;
    try {
      if (!(await this.confirmation.confirm(gate, command.locale)))
        return { status: 'refused', code: 'not_confirmed' };
      return {
        status: 'checked',
        report: await this.probeAll(gate, command.dataFolder),
      };
    } finally {
      this.running = false;
    }
  }

  private async probeAll(
    gate: URL,
    dataFolder: string,
  ): Promise<HardeningCheckReport> {
    const deadline = Date.now() + CHECK_DEADLINE_MS;
    const first = await this.client.probe(gate);
    if (first.status === 'failed')
      return { result: 'failed', reachable: [], reason: first.reason };
    const answer: GateProbeAnswer = {
      status: first.httpStatus,
      body: first.body.subarray(0, GATE_BODY_CHARS).toString('utf8'),
    };
    first.body.fill(0);
    // Not a gate: nothing more is sent to that site.
    if (!answersLikeGate(answer))
      return { result: 'not_gate', reachable: [], reason: null };
    // The folder the gate file lies in: `…/moat-gate.php/moat-check` → `…/`.
    const base = new URL(gate.href.replace(/[^/]+\/moat-check$/, ''));
    const paths = probePaths(dataFolder);
    const answers: ProbeAnswer[] = [];
    for (const path of [paths.folder, ...paths.files]) {
      // A host that stops answering is not asked again; what is left counts as unchecked.
      if (Date.now() > deadline) break;
      const reply = await this.client.probe(new URL(path, base));
      answers.push(answerOf(reply));
      if (reply.status === 'failed') break;
    }
    const [folder = null, ...files] = answers;
    const { result, reachable } = classifyProbes(answer, folder, files);
    return { result, reachable, reason: null };
  }
}

/**
 * Only what the bytes show (marker, a listed data file), then the bytes wiped: a readable data
 * file holds key material. A compressed body hides them, so it counts as no answer.
 */
function answerOf(reply: ProbeReply): ProbeAnswer {
  if (reply.status === 'failed') return null;
  const encoding = (reply.contentEncoding ?? 'identity').trim().toLowerCase();
  const answer =
    encoding === 'identity' ? inspectProbe(reply.httpStatus, reply.body) : null;
  reply.body.fill(0);
  return answer;
}
