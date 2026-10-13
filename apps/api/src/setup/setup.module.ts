import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import {
  CompleteSetupHandler,
  GetSetupHandler,
  UpdateSetupHandler,
} from './application/setup.handlers';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  imports: [CqrsModule],
  controllers: [SetupController],
  providers: [
    SetupService,
    GetSetupHandler,
    UpdateSetupHandler,
    CompleteSetupHandler,
  ],
})
export class SetupModule {}
