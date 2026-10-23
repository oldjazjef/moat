import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Principal } from '../auth/application/auth.commands';
import { CurrentPrincipal } from '../auth/auth.http';
import { ConfigEditDto, toConfigEdit } from '../../project/dto/config-edit.dto';
import type {
  ConfigView,
  GateView,
  ReleasePreview,
  SecretView,
} from './application/gates.commands';
import type { SignerInfo } from './application/cloud-signer';
import {
  AddGateDto,
  PutSecretDto,
  ReleaseDto,
  SetConfigDto,
  UploadBundleDto,
} from './dto/gates.dto';
import { GatesService } from './gates.service';

type Refusal =
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'changed' }
  | {
      status: 'refused';
      code: string;
      fields?: readonly string[];
      secrets?: readonly string[];
    };

/** 404 for what the caller may not know exists (SEC-50), 403 for a member who may not (SEC-52). */
function refuse(result: Refusal, changedAs = 'changed'): never {
  if (result.status === 'not_found') throw new NotFoundException();
  if (result.status === 'forbidden')
    throw new ForbiddenException({ statusCode: 403, error: 'forbidden' });
  if (result.status === 'changed')
    throw new ConflictException({ statusCode: 409, error: changedAs });
  throw new UnprocessableEntityException({
    statusCode: 422,
    error: result.code,
    ...(result.fields === undefined ? {} : { fields: result.fields }),
    ...(result.secrets === undefined ? {} : { secrets: result.secrets }),
  });
}

/**
 * Config, gates, secrets and releases of a Cloud project (authz-matrix:
 * `/api/orgs/:orgId/projects/:projectId/…`). Moat Cloud never reads a secret (SEC-31): the
 * secrets arrive sealed and leave only inside a signed bundle.
 */
@Controller('orgs/:orgId/projects/:projectId')
export class GatesController {
  constructor(private readonly gates: GatesService) {}

  @Get('config')
  @Header('Cache-Control', 'no-store')
  async config(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
  ): Promise<ConfigView> {
    const r = await this.gates.getConfig(me.accountId, org, project);
    if (r.status !== 'ok') refuse(r);
    return { text: r.text, revision: r.revision, hash: r.hash };
  }

  /** Replaces moat.yaml as a whole; 409 `config_changed` when it changed since `base`. */
  @Put('config')
  @Header('Cache-Control', 'no-store')
  async setConfig(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Body() body: SetConfigDto,
  ): Promise<ConfigView> {
    const r = await this.gates.setConfig(
      me.accountId,
      org,
      project,
      body.text,
      body.base,
    );
    if (r.status !== 'ok') refuse(r, 'config_changed');
    return { text: r.text, revision: r.revision, hash: r.hash };
  }

  /** One edit of the closed list (the same as Moat Desktop's). */
  @Post('config/edits')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async edit(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Body() body: ConfigEditDto,
  ): Promise<ConfigView> {
    const edit = toConfigEdit(body);
    if (edit === null)
      throw new BadRequestException({ error: 'edit_incomplete' });
    const r = await this.gates.editConfig(
      me.accountId,
      org,
      project,
      body.base,
      edit,
    );
    if (r.status !== 'ok') refuse(r, 'config_changed');
    return { text: r.text, revision: r.revision, hash: r.hash };
  }

  @Get('gates')
  @Header('Cache-Control', 'no-store')
  async list(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
  ): Promise<{ gates: readonly GateView[]; signer: SignerInfo | null }> {
    const r = await this.gates.listGates(me.accountId, org, project);
    if (r.status !== 'ok') refuse(r);
    return { gates: r.gates, signer: r.signer };
  }

  @Post('gates')
  async add(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Body() body: AddGateDto,
  ): Promise<{ gate: GateView }> {
    const r = await this.gates.addGate(me.accountId, org, project, {
      name: body.name,
      gateId: body.gateId,
      boxKey: body.boxKey,
      fingerprint: body.fingerprint,
      signerKey: body.signerKey ?? null,
    });
    if (r.status !== 'ok') refuse(r);
    return { gate: r.gate };
  }

  /** Deletes the gate with its sealed secrets, bundles and pull address (moat.yaml stays). */
  @Delete('gates/:gate')
  @HttpCode(204)
  async removeGate(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Param('gate') gate: string,
  ): Promise<void> {
    const r = await this.gates.removeGate(me.accountId, org, project, gate);
    if (r.status !== 'ok') refuse(r);
  }

  /** The address is shown once; creating a new one ends the old. */
  @Post('gates/:gate/pull-address')
  @Header('Cache-Control', 'no-store')
  async pullAddress(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Param('gate') gate: string,
  ): Promise<{ url: string }> {
    const r = await this.gates.createPullAddress(
      me.accountId,
      org,
      project,
      gate,
    );
    if (r.status !== 'ok') refuse(r);
    return { url: r.url };
  }

  @Get('gates/:gate/secrets')
  @Header('Cache-Control', 'no-store')
  async secrets(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Param('gate') gate: string,
  ): Promise<{ secrets: readonly SecretView[] }> {
    const r = await this.gates.listSecrets(me.accountId, org, project, gate);
    if (r.status !== 'ok') refuse(r);
    return { secrets: r.secrets };
  }

  /** A secret sealed on the client (`moat secret seal`): the Cloud keeps the ciphertext only. */
  @Put('gates/:gate/secrets/:name')
  async putSecret(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Param('gate') gate: string,
    @Param('name') name: string,
    @Body() body: PutSecretDto,
  ): Promise<{ secret: SecretView }> {
    const r = await this.gates.putSecret(
      me.accountId,
      org,
      project,
      gate,
      name,
      body.sealed,
    );
    if (r.status !== 'ok') refuse(r);
    return { secret: r.secret };
  }

  @Get('gates/:gate/release')
  @Header('Cache-Control', 'no-store')
  async preview(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Param('gate') gate: string,
  ): Promise<{ preview: ReleasePreview }> {
    const r = await this.gates.previewRelease(me.accountId, org, project, gate);
    if (r.status !== 'ok') refuse(r);
    return { preview: r.preview };
  }

  /** Moat Cloud signs the next bundle of a managed gate; needs the release permission. */
  @Post('gates/:gate/releases')
  async release(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Param('gate') gate: string,
    @Body() body: ReleaseDto,
  ): Promise<{ version: number; kid: string; sha256: string }> {
    const r = await this.gates.release(
      me.accountId,
      org,
      project,
      gate,
      body.digest,
    );
    if (r.status !== 'ok') refuse(r);
    return { version: r.version, kid: r.kid, sha256: r.sha256 };
  }

  /** A bundle signed elsewhere, for a gate with its customer's key pinned. */
  @Post('gates/:gate/bundles')
  async upload(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Param('gate') gate: string,
    @Body() body: UploadBundleDto,
  ): Promise<{ version: number; sha256: string }> {
    const r = await this.gates.uploadBundle(
      me.accountId,
      org,
      project,
      gate,
      body.envelope,
    );
    if (r.status !== 'ok') refuse(r);
    return { version: r.version, sha256: r.sha256 };
  }
}
