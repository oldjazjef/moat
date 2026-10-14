import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env';
import { PersistenceModule } from '../persistence/persistence.module';
import { ProjectModule } from '../project/project.module';
import { SetupModule } from '../setup/setup.module';
import { GateTestModule } from '../gate-test/gate-test.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      // The desktop shell sets every variable itself before it loads this module; a stray .env in
      // whatever directory it was started from must not leak in.
      ignoreEnvFile: true,
    }),
    // Global: every storage port → its adapter.
    PersistenceModule,
    ProjectModule,
    SetupModule,
    GateTestModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
