import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { DryRunResult, GateSetupIdentity, Policy } from '@moat/core';
import { DryRunQuery } from './application/dry-run.handler';
import {
  SuggestPolicyQuery,
  TestGateCommand,
} from './application/gate-test.handlers';
import {
  HardeningCheckCommand,
  type HardeningCheckReport,
} from './application/hardening-check.handler';
import { GateSetupCommand } from './application/gate-setup.handler';
import {
  DryRunDto,
  GateSetupDto,
  GateTestDto,
  HardeningCheckDto,
} from './dto/gate-test.dto';
import type { GateAnswer, GateFailure } from './ports/gate-client.port';

/**
 * What the wizard's recipe step needs to bring a gate to life (FR-73): the local policy to
 * install on it, and one test request through it. Moat Desktop only (authz-matrix): the Cloud
 * gets «Testen» only with its own egress rules (T-59).
 */
@Controller('projects')
export class GateTestController {
  constructor(
    private readonly queries: QueryBus,
    private readonly commands: CommandBus,
  ) {}

  /** The policy `moat policy suggest` would print for this project (SEC-14), to review and install. */
  @Get(':id/policy')
  @Header('Cache-Control', 'no-store')
  async policy(@Param('id') id: string): Promise<Policy> {
    const result = await this.queries.execute(new SuggestPolicyQuery(id));
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'refused')
      throw new UnprocessableEntityException({ error: result.code });
    return result.policy;
  }

  /**
   * Sends the route's request with `body` to the gate at `url` and answers with what came back:
   * the gate's status and the start of its body, or why no answer came (GateFailure). 422 when
   * nothing was sent (GateTestRefusal).
   */
  @Post(':id/test-request')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async test(
    @Param('id') id: string,
    @Body() body: GateTestDto,
  ): Promise<GateAnswer> {
    const result = await this.commands.execute(
      new TestGateCommand(
        id,
        body.url,
        body.route,
        body.body,
        body.locale ?? '',
      ),
    );
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'refused')
      throw new UnprocessableEntityException({ error: result.code });
    return result.answer;
  }

  /**
   * The check from outside (DT-07, SEC-49): probes the gate's data folder and files over the
   * public URL and answers which came back readable, never their content. 422 when nothing was
   * sent (HardeningCheckRefusal).
   */
  @Post(':id/hardening-check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async hardeningCheck(
    @Param('id') id: string,
    @Body() body: HardeningCheckDto,
  ): Promise<HardeningCheckReport> {
    const result = await this.commands.execute(
      new HardeningCheckCommand(
        id,
        body.url,
        body.dataFolder,
        body.locale ?? '',
      ),
    );
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'refused')
      throw new UnprocessableEntityException({ error: result.code });
    return result.report;
  }

  /**
   * Reads a gate's identity from its setup mode (SEC-28, SEC-32, T-73): gate id, box key and the
   * fingerprints to compare, so the gate can be pinned without a shell on the server. 422 when
   * nothing was read (GateSetupRefusal, `setup_off` when the gate answered 404); 200 with
   * `status: 'failed'` and the reason when the gate could not be reached.
   */
  @Post(':id/gates/setup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async gateSetup(
    @Param('id') id: string,
    @Body() body: GateSetupDto,
  ): Promise<
    | { status: 'read'; identity: GateSetupIdentity }
    | { status: 'failed'; reason: GateFailure }
  > {
    const result = await this.commands.execute(
      new GateSetupCommand(id, body.url, body.token, body.locale ?? ''),
    );
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'refused')
      throw new UnprocessableEntityException({ error: result.code });
    return result;
  }

  /**
   * The test console (FR-42): what the gate would answer to this request, from the project's
   * config and the suggested policy, without sending anything or opening a secret. 422 when the
   * config is missing or invalid or the gate is unknown (DryRunPlanErrorCode).
   */
  @Post(':id/dry-run')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async dryRun(
    @Param('id') id: string,
    @Body() body: DryRunDto,
  ): Promise<DryRunResult> {
    const result = await this.queries.execute(
      new DryRunQuery(id, body.gate ?? null, {
        method: body.method,
        path: body.path,
        origin: body.origin ?? null,
        contentType: body.contentType ?? null,
        requestMethod: body.requestMethod ?? null,
        body: body.body,
      }),
    );
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'refused')
      throw new UnprocessableEntityException({ error: result.code });
    return result.result;
  }
}
