import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TRAFFIC_HANDLERS } from './application/traffic.handlers';
import { ReportController, TrafficController } from './traffic.controller';

/** Traffic reports of gates (FR-50, FR-51, T-110). */
@Module({
  imports: [CqrsModule],
  controllers: [TrafficController, ReportController],
  providers: [...TRAFFIC_HANDLERS],
})
export class TrafficModule {}
