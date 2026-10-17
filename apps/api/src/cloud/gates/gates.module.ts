import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import type { Env } from '../../config/env';
import { CloudSigner } from './application/cloud-signer';
import { GATES_HANDLERS } from './application/gates.handlers';
import { GatesController } from './gates.controller';
import { GatesService } from './gates.service';
import { PullController } from './pull.controller';

@Global()
@Module({
  imports: [CqrsModule],
  controllers: [GatesController, PullController],
  providers: [
    GatesService,
    {
      provide: CloudSigner,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        CloudSigner.fromConfig(config),
    },
    ...GATES_HANDLERS,
  ],
  exports: [CloudSigner],
})
export class GatesModule {}
