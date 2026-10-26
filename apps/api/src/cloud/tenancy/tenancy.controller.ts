import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Principal } from '../auth/application/auth.commands';
import { CurrentPrincipal } from '../auth/auth.http';
import type {
  Forbidden,
  MemberView,
  MyAccess,
  NotFound,
  OrganisationView,
  ProjectView,
} from './application/tenancy.commands';
import {
  AddMemberDto,
  ChangeMemberDto,
  CreateOrganisationDto,
  CreateOrgProjectDto,
  RevokeInvitationDto,
} from './dto/tenancy.dto';
import { TenancyService } from './tenancy.service';

type Refused = NotFound | Forbidden | { status: 'refused'; code: string };

/** 404 for what the caller may not know exists (SEC-50), 403 for a member who may not (SEC-52). */
function refuse(result: Refused): never {
  if (result.status === 'not_found') throw new NotFoundException();
  if (result.status === 'forbidden')
    throw new ForbiddenException({ statusCode: 403, error: 'forbidden' });
  throw new UnprocessableEntityException({
    statusCode: 422,
    error: result.code,
  });
}

/** Organisations, members and projects (authz-matrix: `/api/orgs…`). */
@Controller('orgs')
export class TenancyController {
  constructor(private readonly tenancy: TenancyService) {}

  @Get()
  async list(
    @CurrentPrincipal() me: Principal,
  ): Promise<{ organisation: OrganisationView; access: MyAccess }[]> {
    return [...(await this.tenancy.listOrganisations(me.accountId))];
  }

  @Post()
  async create(
    @CurrentPrincipal() me: Principal,
    @Body() body: CreateOrganisationDto,
  ): Promise<{ organisation: OrganisationView; access: MyAccess }> {
    const result = await this.tenancy.createOrganisation(
      me.accountId,
      body.name,
    );
    if (result.status !== 'ok') refuse(result);
    return { organisation: result.organisation, access: result.access };
  }

  @Get(':orgId')
  async get(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
  ): Promise<{ organisation: OrganisationView; access: MyAccess }> {
    const result = await this.tenancy.getOrganisation(me.accountId, orgId);
    if (result.status !== 'ok') refuse(result);
    return { organisation: result.organisation, access: result.access };
  }

  @Get(':orgId/members')
  async members(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
  ): Promise<{ members: readonly MemberView[] }> {
    const result = await this.tenancy.listMembers(me.accountId, orgId);
    if (result.status !== 'ok') refuse(result);
    return { members: result.members };
  }

  /** 204 whether or not an account with that address exists (T-79). */
  @Post(':orgId/members')
  @HttpCode(204)
  async addMember(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Body() body: AddMemberDto,
  ): Promise<void> {
    const result = await this.tenancy.addMember(
      me.accountId,
      orgId,
      body.email,
      body.role,
    );
    if (result.status !== 'ok') refuse(result);
  }

  /** 204 whether or not an invitation for that address existed (T-79); there is no list. */
  @Post(':orgId/invitations/revoke')
  @HttpCode(204)
  async revokeInvitation(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Body() body: RevokeInvitationDto,
  ): Promise<void> {
    const result = await this.tenancy.revokeInvitation(
      me.accountId,
      orgId,
      body.email,
    );
    if (result.status !== 'ok') refuse(result);
  }

  @Patch(':orgId/members/:accountId')
  async changeMember(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Param('accountId') accountId: string,
    @Body() body: ChangeMemberDto,
  ): Promise<{ member: MemberView }> {
    if (body.role === undefined && body.releaseGranted === undefined)
      throw new BadRequestException({ statusCode: 400, error: 'empty_change' });
    const result = await this.tenancy.changeMember(
      me.accountId,
      orgId,
      accountId,
      body.role,
      body.releaseGranted,
    );
    if (result.status !== 'ok') refuse(result);
    return { member: result.member };
  }

  @Delete(':orgId/members/:accountId')
  @HttpCode(204)
  async removeMember(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Param('accountId') accountId: string,
  ): Promise<void> {
    const result = await this.tenancy.removeMember(
      me.accountId,
      orgId,
      accountId,
    );
    if (result.status !== 'ok') refuse(result);
  }

  @Get(':orgId/projects')
  async projects(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
  ): Promise<{ projects: readonly ProjectView[] }> {
    const result = await this.tenancy.listProjects(me.accountId, orgId);
    if (result.status !== 'ok') refuse(result);
    return { projects: result.projects };
  }

  @Post(':orgId/projects')
  async createProject(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Body() body: CreateOrgProjectDto,
  ): Promise<{ project: ProjectView }> {
    const result = await this.tenancy.createProject(
      me.accountId,
      orgId,
      body.name,
    );
    if (result.status !== 'ok') refuse(result);
    return { project: result.project };
  }

  @Get(':orgId/projects/:projectId')
  async project(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<{ project: ProjectView }> {
    const result = await this.tenancy.getProject(
      me.accountId,
      orgId,
      projectId,
    );
    if (result.status !== 'ok') refuse(result);
    return { project: result.project };
  }

  @Delete(':orgId/projects/:projectId')
  @HttpCode(204)
  async deleteProject(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    const result = await this.tenancy.deleteProject(
      me.accountId,
      orgId,
      projectId,
    );
    if (result.status !== 'ok') refuse(result);
  }
}
