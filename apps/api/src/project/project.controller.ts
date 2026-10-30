import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { HistoryCheck } from '@moat/core';
import type { GateRefusal } from './application/gate.commands';
import {
  HistoryService,
  type HistoryView,
} from './application/history.service';
import type { ConfigText } from './application/config-text';
import { ConfigEditDto, toConfigEdit } from './dto/config-edit.dto';
import { ReplaceConfigDto } from './dto/config-text.dto';
import { GateDto, toGateInput } from './dto/gate.dto';
import { ProjectService } from './project.service';
import type { ProjectSummary, ProjectView } from './project.types';

/** 409 for a name in use, 422 for everything else the core refused. */
function gateRefusal(code: GateRefusal): never {
  if (code === 'gate_exists' || code === 'gate_id_exists')
    throw new ConflictException({ error: code });
  throw new UnprocessableEntityException({ error: code });
}

/**
 * The projects (authz-matrix: `/api/projects…`). There is no route that adds a project: a folder
 * is chosen only in the desktop's own dialog (DT-08, see AddProjectCommand).
 */
@Controller('projects')
export class ProjectController {
  constructor(
    private readonly projects: ProjectService,
    private readonly history: HistoryService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(): Promise<readonly ProjectSummary[]> {
    return this.projects.list();
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@Param('id') id: string): Promise<ProjectView> {
    const view = await this.projects.get(id);
    if (view === null) throw new NotFoundException();
    return view;
  }

  /** Takes the project off the list; the folder and its files stay as they are. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    if (!(await this.projects.remove(id))) throw new NotFoundException();
  }

  /** moat.yaml as text for the editor, with the hash the next save names as its base. */
  @Get(':id/config')
  @Header('Cache-Control', 'no-store')
  async configText(@Param('id') id: string): Promise<ConfigText> {
    const config = await this.projects.configText(id);
    if (config === null) throw new NotFoundException();
    return config;
  }

  /**
   * The editor's «Speichern»: moat.yaml as a whole (ReplaceConfigCommand). 422 `config_invalid`
   * with `issues` (code, path, line, column) when the core refuses the text; 409
   * `config_changed` when the file changed since `base`. Nothing is written in either case.
   */
  @Put(':id/config')
  @Header('Cache-Control', 'no-store')
  async replaceConfig(
    @Param('id') id: string,
    @Body() body: ReplaceConfigDto,
  ): Promise<ConfigText> {
    const result = await this.projects.replaceConfig(id, body.base, body.text);
    switch (result.status) {
      case 'not_found':
        throw new NotFoundException();
      case 'changed':
        throw new ConflictException({ error: 'config_changed' });
      case 'refused':
        throw new UnprocessableEntityException({
          error: result.code,
          ...(result.issues === undefined ? {} : { issues: result.issues }),
        });
      case 'saved':
        return result.config;
    }
  }

  /**
   * One edit of moat.yaml (EditConfigCommand), answered with the project as it is afterwards.
   * 409 `config_changed`: the file changed since `base`, nothing written. 422: the edit was
   * refused, `error` says why (ConfigEditRefusal).
   */
  @Post(':id/config/edits')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async edit(
    @Param('id') id: string,
    @Body() body: ConfigEditDto,
  ): Promise<ProjectView> {
    const edit = toConfigEdit(body);
    if (edit === null)
      throw new BadRequestException({ error: 'edit_incomplete' });
    const result = await this.projects.editConfig(id, body.base, edit);
    switch (result.status) {
      case 'not_found':
        throw new NotFoundException();
      case 'changed':
        throw new ConflictException({ error: 'config_changed' });
      case 'refused':
        throw new UnprocessableEntityException({
          error: result.code,
          ...(result.fields === undefined ? {} : { fields: result.fields }),
        });
      case 'saved':
        break;
    }
    const view = await this.projects.get(id);
    if (view === null) throw new NotFoundException();
    return view;
  }

  /**
   * A gate as it would be pinned, with the fingerprint of its box key to compare with what the
   * gate printed (SEC-32). Writes nothing.
   */
  @Post(':id/gates/check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async checkGate(@Param('id') id: string, @Body() body: GateDto) {
    const result = await this.projects.checkGate(id, toGateInput(body));
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'refused') gateRefusal(result.code);
    return result.preview;
  }

  /**
   * Pins the gate (`gates/<name>.json`) when `fingerprint` is the one `check` showed, and answers
   * with the project as it is afterwards. Never replaces a gate (409 `gate_exists`).
   */
  @Post(':id/gates')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async addGate(
    @Param('id') id: string,
    @Body() body: GateDto,
  ): Promise<ProjectView> {
    if (body.fingerprint === undefined)
      throw new BadRequestException({ error: 'fingerprint_missing' });
    const result = await this.projects.addGate(
      id,
      toGateInput(body),
      body.fingerprint,
    );
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'refused') gateRefusal(result.code);
    const view = await this.projects.get(id);
    if (view === null) throw new NotFoundException();
    return view;
  }

  /** «Verlauf» (DT-03): whether the project keeps a history, and its rows. */
  @Get(':id/history')
  @Header('Cache-Control', 'no-store')
  async getHistory(@Param('id') id: string): Promise<HistoryView> {
    const view = await this.history.view(id);
    if (view === null) throw new NotFoundException();
    return view;
  }

  /**
   * Switches the history on (a local SQLite file in the API's data folder, never in the project
   * folder). Idempotent; there is no route that switches it off or removes a row.
   */
  @Post(':id/history')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async enableHistory(@Param('id') id: string): Promise<HistoryView> {
    const view = await this.history.enable(id);
    if (view === null) throw new NotFoundException();
    return view;
  }

  /** «Prüfen»: the hash chain and the anchor (core verifyHistory); writes nothing. */
  @Post(':id/history/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async verifyHistory(@Param('id') id: string): Promise<HistoryCheck> {
    const check = await this.history.verify(id);
    if (check === null) throw new NotFoundException();
    return check;
  }
}
