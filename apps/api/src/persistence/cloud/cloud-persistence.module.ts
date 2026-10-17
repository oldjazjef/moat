import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogPort } from '../../cloud/audit/ports/audit.ports';
import {
  AccountRepositoryPort,
  RateLimitPort,
  SessionRepositoryPort,
} from '../../cloud/auth/ports/auth.ports';
import {
  OrganisationRepositoryPort,
  OrgProjectRepositoryPort,
} from '../../cloud/tenancy/ports/tenancy.ports';
import type { Env } from '../../config/env';
import { CloudDatabase } from './cloud-database';
import { PrismaAuditLogRepository } from './prisma-audit.repository';
import {
  PrismaAccountRepository,
  PrismaRateLimit,
  PrismaSessionRepository,
} from './prisma-auth.repositories';
import {
  PrismaOrganisationRepository,
  PrismaOrgProjectRepository,
} from './prisma-tenancy.repositories';

/** Global: every Cloud port → its Prisma adapter (AUTH_MODE=cloud only). */
@Global()
@Module({
  providers: [
    {
      provide: CloudDatabase,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        CloudDatabase.open({
          provider: config.get('MOAT_DB_PROVIDER', { infer: true }),
          dataDir: config.get('MOAT_DATA_DIR', { infer: true }),
          databaseUrl: config.get('MOAT_DATABASE_URL', { infer: true }),
        }),
    },
    { provide: AccountRepositoryPort, useClass: PrismaAccountRepository },
    { provide: SessionRepositoryPort, useClass: PrismaSessionRepository },
    { provide: RateLimitPort, useClass: PrismaRateLimit },
    {
      provide: OrganisationRepositoryPort,
      useClass: PrismaOrganisationRepository,
    },
    { provide: OrgProjectRepositoryPort, useClass: PrismaOrgProjectRepository },
    { provide: AuditLogPort, useClass: PrismaAuditLogRepository },
  ],
  exports: [
    CloudDatabase,
    AccountRepositoryPort,
    SessionRepositoryPort,
    RateLimitPort,
    OrganisationRepositoryPort,
    OrgProjectRepositoryPort,
    AuditLogPort,
  ],
})
export class CloudPersistenceModule {}
