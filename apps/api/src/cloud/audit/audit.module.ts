import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AUDIT_HANDLERS } from './application/audit.handlers';
import { AuditTrail } from './application/audit-trail';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** Global: the tenancy handlers write through `AuditTrail`, the controller reads the log. */
@Global()
@Module({
  imports: [CqrsModule],
  controllers: [AuditController],
  providers: [AuditService, AuditTrail, ...AUDIT_HANDLERS],
  exports: [AuditTrail],
})
export class AuditModule {}
