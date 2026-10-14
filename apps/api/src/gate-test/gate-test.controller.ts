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
import type { Policy } from '@moat/core';
import {
  SuggestPolicyQuery,
  TestGateCommand,
} from './application/gate-test.handlers';
import { GateTestDto } from './dto/gate-test.dto';
import type { GateAnswer } from './ports/gate-client.port';

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
      new TestGateCommand(id, body.url, body.route, body.body),
    );
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'refused')
      throw new UnprocessableEntityException({ error: result.code });
    return result.answer;
  }
}
