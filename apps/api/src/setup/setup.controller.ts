import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Patch,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { SetupResult, SetupView } from './application/setup.handlers';
import { UpdateSetupDto } from './dto/setup.dto';
import { SetupService } from './setup.service';

function answer(result: SetupResult): SetupView {
  if (result.status === 'refused')
    throw new UnprocessableEntityException({
      error: result.code,
      ...(result.missing === undefined ? {} : { missing: result.missing }),
    });
  return result.view;
}

/** FR-73: the setup wizard's progress (authz-matrix: `/api/setup…`), kept so it can be resumed. */
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(): Promise<SetupView> {
    return this.setup.get();
  }

  /** Step states and the step on screen. 422 `step_required`, `step_incomplete`. */
  @Patch()
  @Header('Cache-Control', 'no-store')
  async update(@Body() body: UpdateSetupDto): Promise<SetupView> {
    return answer(
      await this.setup.update({
        ...(body.currentStep === undefined
          ? {}
          : { currentStep: body.currentStep }),
        ...(body.states === undefined ? {} : { states: body.states }),
      }),
    );
  }

  /** «Fertig». 422 `setup_incomplete` with the `missing` steps. */
  @Post('complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async complete(): Promise<SetupView> {
    return answer(await this.setup.complete(new Date()));
  }
}
