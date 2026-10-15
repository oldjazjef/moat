import { Controller, Get, Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env';
import { CloudPersistenceModule } from '../persistence/cloud/cloud-persistence.module';
import { Public } from './auth/auth.http';
import { AuthModule } from './auth/auth.module';
import { Clock, SystemClock } from './common/clock';
import { TenancyModule } from './tenancy/tenancy.module';

@Controller('health')
class CloudHealthController {
  /** Liveness for the load balancer (authz-matrix: `GET /api/health`). Says nothing else. */
  @Public()
  @Get()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
class ClockModule {}

/**
 * The root module of `AUTH_MODE=cloud`: accounts, sessions and organisations, on the Cloud's own
 * database. It shares nothing with the desktop's AppModule (no project folders, no key files, no
 * gate calls): a Cloud process has no code path to a customer's folder or secret.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      ignoreEnvFile: true,
    }),
    ClockModule,
    CloudPersistenceModule,
    AuthModule,
    TenancyModule,
  ],
  controllers: [CloudHealthController],
})
export class CloudAppModule {}
