import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** Liveness for the desktop shell (authz-matrix: `GET /api/health`). Says nothing else. */
  @Get()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
