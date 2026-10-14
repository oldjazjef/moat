import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import {
  SuggestPolicyHandler,
  TestGateHandler,
} from './application/gate-test.handlers';
import { DryRunHandler } from './application/dry-run.handler';
import { HardeningCheckHandler } from './application/hardening-check.handler';
import { GateTestController } from './gate-test.controller';
import { RecipesController } from './recipes.controller';
import { HttpsGateClient } from './infrastructure/https-gate-client';
import { GateClientPort } from './ports/gate-client.port';
import {
  GateTestConfirmationPort,
  MainProcessConfirmation,
} from './ports/gate-test-confirmation.port';

@Module({
  imports: [CqrsModule],
  controllers: [GateTestController, RecipesController],
  providers: [
    TestGateHandler,
    SuggestPolicyHandler,
    HardeningCheckHandler,
    DryRunHandler,
    { provide: GateClientPort, useClass: HttpsGateClient },
    MainProcessConfirmation,
    { provide: GateTestConfirmationPort, useExisting: MainProcessConfirmation },
  ],
})
export class GateTestModule {}
