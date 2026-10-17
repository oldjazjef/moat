import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.http';
import { GatesService } from './gates.service';

/**
 * What a gate's lazy pull fetches (DT-11): the latest signed bundle, as signed. No session: the
 * address holds a 256-bit token and is the credential of that one gate. Unknown token, no bundle
 * and a malformed token all answer the same 404. The gate verifies the bytes itself, so this
 * serves nothing it could not check; the answer carries no cookie and is never cached.
 */
@Controller('pull')
export class PullController {
  constructor(private readonly gates: GatesService) {}

  @Public()
  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async pull(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const bundle = await this.gates.pull(token);
    if (bundle === null) throw new NotFoundException();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return bundle;
  }
}
