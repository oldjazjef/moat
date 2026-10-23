import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudProjectStorePort } from '../../cloud/gates/ports/gates.ports';
import { AuditLogPort } from '../../cloud/audit/ports/audit.ports';
import {
  AccountRepositoryPort,
  AccountTokenPort,
  PasskeyRepositoryPort,
  RateLimitPort,
  SessionRepositoryPort,
} from '../../cloud/auth/ports/auth.ports';
import {
  InvitationRepositoryPort,
  OrganisationRepositoryPort,
  OrgProjectRepositoryPort,
} from '../../cloud/tenancy/ports/tenancy.ports';
import type { Env } from '../../config/env';
import { CloudDatabase } from './cloud-database';
import { PrismaCloudProjectStore } from './prisma-gates.repository';
import { PrismaAuditLogRepository } from './prisma-audit.repository';
import {
  PrismaAccountRepository,
  PrismaAccountTokenRepository,
  PrismaPasskeyRepository,
  PrismaRateLimit,
  PrismaSessionRepository,
} from './prisma-auth.repositories';
import {
  PrismaInvitationRepository,
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
    { provide: AccountTokenPort, useClass: PrismaAccountTokenRepository },
    { provide: PasskeyRepositoryPort, useClass: PrismaPasskeyRepository },
    { provide: InvitationRepositoryPort, useClass: PrismaInvitationRepository },
    { provide: RateLimitPort, useClass: PrismaRateLimit },
    {
      provide: OrganisationRepositoryPort,
      useClass: PrismaOrganisationRepository,
    },
    { provide: OrgProjectRepositoryPort, useClass: PrismaOrgProjectRepository },
    { provide: AuditLogPort, useClass: PrismaAuditLogRepository },
    { provide: CloudProjectStorePort, useClass: PrismaCloudProjectStore },
  ],
  exports: [
    CloudDatabase,
    AccountRepositoryPort,
    SessionRepositoryPort,
    AccountTokenPort,
    PasskeyRepositoryPort,
    InvitationRepositoryPort,
    RateLimitPort,
    OrganisationRepositoryPort,
    OrgProjectRepositoryPort,
    AuditLogPort,
    CloudProjectStorePort,
  ],
})
export class CloudPersistenceModule {}
