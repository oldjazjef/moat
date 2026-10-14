import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import {
  SuggestPolicyHandler,
  TestGateHandler,
} from './application/gate-test.handlers';
import { GateTestController } from './gate-test.controller';
import { RecipesController } from './recipes.controller';
import { HttpsGateClient } from './infrastructure/https-gate-client';
import { GateClientPort } from './ports/gate-client.port';

@Module({
  imports: [CqrsModule],
  controllers: [GateTestController, RecipesController],
  providers: [
    TestGateHandler,
    SuggestPolicyHandler,
    { provide: GateClientPort, useClass: HttpsGateClient },
  ],
})
export class GateTestModule {}
