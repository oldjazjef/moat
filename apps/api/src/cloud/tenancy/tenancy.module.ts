import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TENANCY_HANDLERS } from './application/tenancy.handlers';
import { TenancyController } from './tenancy.controller';
import { TenancyService } from './tenancy.service';

@Module({
  imports: [CqrsModule],
  controllers: [TenancyController],
  providers: [TenancyService, ...TENANCY_HANDLERS],
})
export class TenancyModule {}
