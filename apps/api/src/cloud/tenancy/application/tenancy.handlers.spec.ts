import { describe, expect, it } from 'vitest';
import { mailKit } from '../../testing/mail-kit';
import { newId } from '../../common/clock';
import { AuditTrail } from '../../audit/application/audit-trail';
import {
  FixedClock,
  InMemoryAccounts,
  InMemoryAudit,
  InMemoryOrganisations,
  InMemoryOrgProjects,
} from '../../testing/in-memory';
import type { Role } from '../domain/permissions';
import {
  AddMemberCommand,
  ChangeMemberCommand,
  CreateOrganisationCommand,
  CreateProjectCommand,
  DeleteProjectCommand,
  GetOrganisationQuery,
  GetProjectQuery,
  ListMembersQuery,
  ListOrganisationsQuery,
  ListProjectsQuery,
  RemoveMemberCommand,
} from './tenancy.commands';
import {
  AddMemberHandler,
  ChangeMemberHandler,
  cleanName,
  CreateOrganisationHandler,
  CreateProjectHandler,
  DeleteProjectHandler,
  GetOrganisationHandler,
  GetProjectHandler,
  ListMembersHandler,
  ListOrganisationsHandler,
  ListProjectsHandler,
  RemoveMemberHandler,
} from './tenancy.handlers';

async function setup() {
  const accounts = new InMemoryAccounts();
  const organisations = new InMemoryOrganisations(accounts);
  const projects = new InMemoryOrgProjects();
  const clock = new FixedClock();
  const auditLog = new InMemoryAudit();
  const audit = new AuditTrail(auditLog, clock);
  const kit = mailKit(false, accounts, organisations, clock, audit);
  const person = async (name: string) => {
    const id = newId();
    await accounts.create({
      id,
      email: `${name}@example.ch`,
      passwordHash: '$argon2id$x',
      passwordChangedAt: clock.now().toISOString(),
      createdAt: clock.now().toISOString(),
      emailVerifiedAt: clock.now().toISOString(),
    });
    return id;
  };
  const ids = {
    owner: await person('owner'),
    admin: await person('admin'),
    editor: await person('editor'),
    viewer: await person('viewer'),
    billing: await person('billing'),
    stranger: await person('stranger'),
  };
  const created = await new CreateOrganisationHandler(
    organisations,
    clock,
    audit,
  ).execute(new CreateOrganisationCommand(ids.owner, 'Acme AG'));
  if (created.status !== 'ok') throw new Error('org');
  const org = created.organisation.id;
  const add = new AddMemberHandler(
    organisations,
    clock,
    audit,
    kit.invitations,
    kit.outbox,
    kit.limiter,
    kit.links,
  );
  const change = new ChangeMemberHandler(organisations, audit);
  for (const role of ['admin', 'editor', 'viewer', 'billing'] as const)
    await add.execute(
      new AddMemberCommand(ids.owner, org, `${role}@example.ch`, role),
    );
  // The founder grants the release permission to the Editor.
  await change.execute(
    new ChangeMemberCommand(ids.owner, org, ids.editor, undefined, true),
  );
  const foreign = await new CreateOrganisationHandler(
    organisations,
    clock,
    audit,
  ).execute(new CreateOrganisationCommand(ids.stranger, 'Other GmbH'));
  if (foreign.status !== 'ok') throw new Error('org');
  return {
    ids,
    org,
    foreignOrg: foreign.organisation.id,
    organisations,
    projects,
    add,
    change,
    auditLog,
    audit,
    clock,
    remove: new RemoveMemberHandler(organisations, audit),
    members: new ListMembersHandler(organisations),
    get: new GetOrganisationHandler(organisations),
    list: new ListOrganisationsHandler(organisations),
    createProject: new CreateProjectHandler(
      organisations,
      projects,
      clock,
      audit,
    ),
    getProject: new GetProjectHandler(organisations, projects),
    listProjects: new ListProjectsHandler(organisations, projects),
    deleteProject: new DeleteProjectHandler(organisations, projects, audit),
    roleOf: async (account: string, o = org) =>
      (await organisations.membership(o, account))?.role,
    releaseOf: async (account: string) =>
      (await organisations.membership(org, account))?.releaseGranted,
  };
}

describe('organisations', () => {
  it('makes the founder an Owner with the release permission, and lists only their own', async () => {
    const t = await setup();
    expect(await t.roleOf(t.ids.owner)).toBe('owner');
    expect(await t.releaseOf(t.ids.owner)).toBe(true);
    expect(await t.releaseOf(t.ids.admin)).toBe(false);
    const mine = await t.list.execute(new ListOrganisationsQuery(t.ids.viewer));
    expect(mine.map((m) => m.organisation.id)).toEqual([t.org]);
    expect(mine[0]?.access).toMatchObject({
      role: 'viewer',
      releaseGranted: false,
    });
  });

  it('validates names', () => {
    expect(cleanName('  Acme  ')).toBe('Acme');
    for (const bad of ['', '   ', 'x'.repeat(101), 'a\u0000b', 'a\nb', 'a‮b'])
      expect(cleanName(bad)).toBeNull();
  });

  it('answers 404 (not_found) for a foreign or non-existent organisation, whatever the role (SEC-50)', async () => {
    const t = await setup();
    for (const actor of Object.values(t.ids)) {
      if (actor === t.ids.stranger) continue;
      const q = await t.get.execute(
        new GetOrganisationQuery(actor, t.foreignOrg),
      );
      expect(q).toEqual({ status: 'not_found' });
      expect(
        await t.members.execute(new ListMembersQuery(actor, t.foreignOrg)),
      ).toEqual({ status: 'not_found' });
      expect(
        await t.listProjects.execute(
          new ListProjectsQuery(actor, t.foreignOrg),
        ),
      ).toEqual({ status: 'not_found' });
      expect(
        await t.createProject.execute(
          new CreateProjectCommand(actor, t.foreignOrg, 'x'),
        ),
      ).toEqual({ status: 'not_found' });
    }
    expect(
      await t.get.execute(new GetOrganisationQuery(t.ids.owner, newId())),
    ).toEqual({ status: 'not_found' });
    expect(
      await t.get.execute(new GetOrganisationQuery(t.ids.owner, '../etc')),
    ).toEqual({ status: 'not_found' });
  });
});

describe('role escalation (SEC-52, T-81)', () => {
  const lower: Role[] = ['editor', 'viewer', 'billing'];

  it('keeps an Editor from granting the release permission, to anybody, themselves included', async () => {
    const t = await setup();
    for (const target of [t.ids.editor, t.ids.viewer, t.ids.admin]) {
      const r = await t.change.execute(
        new ChangeMemberCommand(t.ids.editor, t.org, target, undefined, true),
      );
      expect(r).toEqual({ status: 'forbidden' });
    }
    expect(await t.releaseOf(t.ids.viewer)).toBe(false);
  });

  it('keeps Editor, Viewer and Billing from changing, adding or removing members', async () => {
    const t = await setup();
    for (const actor of [t.ids.editor, t.ids.viewer, t.ids.billing]) {
      expect(
        await t.change.execute(
          new ChangeMemberCommand(actor, t.org, actor, 'owner', undefined),
        ),
      ).toEqual({ status: 'forbidden' });
      expect(
        await t.add.execute(
          new AddMemberCommand(actor, t.org, 'stranger@example.ch', 'viewer'),
        ),
      ).toEqual({ status: 'forbidden' });
      expect(
        await t.remove.execute(
          new RemoveMemberCommand(actor, t.org, t.ids.owner),
        ),
      ).toEqual({ status: 'forbidden' });
    }
    expect(await t.roleOf(t.ids.editor)).toBe('editor');
  });

  it('keeps an Admin from touching Owners or Admins, from making them, and from granting release', async () => {
    const t = await setup();
    const admin = t.ids.admin;
    expect(
      await t.change.execute(
        new ChangeMemberCommand(admin, t.org, admin, 'owner', undefined),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.change.execute(
        new ChangeMemberCommand(admin, t.org, t.ids.viewer, 'admin', undefined),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.change.execute(
        new ChangeMemberCommand(admin, t.org, t.ids.owner, 'viewer', undefined),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.change.execute(
        new ChangeMemberCommand(admin, t.org, t.ids.viewer, undefined, true),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.change.execute(
        new ChangeMemberCommand(admin, t.org, t.ids.editor, undefined, false),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.remove.execute(
        new RemoveMemberCommand(admin, t.org, t.ids.owner),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.add.execute(
        new AddMemberCommand(admin, t.org, 'stranger@example.ch', 'admin'),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(await t.roleOf(t.ids.owner)).toBe('owner');
    expect(await t.releaseOf(t.ids.editor)).toBe(true);
  });

  it('lets an Admin manage Editor, Viewer and Billing', async () => {
    const t = await setup();
    for (const role of lower) {
      const r = await t.change.execute(
        new ChangeMemberCommand(
          t.ids.admin,
          t.org,
          t.ids.viewer,
          role,
          undefined,
        ),
      );
      expect(r).toMatchObject({ status: 'ok', member: { role } });
    }
    expect(
      await t.add.execute(
        new AddMemberCommand(
          t.ids.admin,
          t.org,
          'stranger@example.ch',
          'viewer',
        ),
      ),
    ).toEqual({ status: 'ok' });
    expect(
      await t.remove.execute(
        new RemoveMemberCommand(t.ids.admin, t.org, t.ids.viewer),
      ),
    ).toEqual({ status: 'ok' });
  });

  it('lets only an Owner grant release, and only to roles that can hold it', async () => {
    const t = await setup();
    const ok = await t.change.execute(
      new ChangeMemberCommand(t.ids.owner, t.org, t.ids.admin, undefined, true),
    );
    expect(ok).toMatchObject({
      status: 'ok',
      member: { releaseGranted: true },
    });
    for (const target of [t.ids.viewer, t.ids.billing])
      expect(
        await t.change.execute(
          new ChangeMemberCommand(t.ids.owner, t.org, target, undefined, true),
        ),
      ).toEqual({ status: 'refused', code: 'release_not_applicable' });
  });

  it('takes the release permission away when the role cannot hold it', async () => {
    const t = await setup();
    const r = await t.change.execute(
      new ChangeMemberCommand(
        t.ids.owner,
        t.org,
        t.ids.editor,
        'viewer',
        undefined,
      ),
    );
    expect(r).toMatchObject({
      status: 'ok',
      member: { role: 'viewer', releaseGranted: false },
    });
  });

  it('never removes or demotes the last Owner', async () => {
    const t = await setup();
    expect(
      await t.change.execute(
        new ChangeMemberCommand(
          t.ids.owner,
          t.org,
          t.ids.owner,
          'admin',
          undefined,
        ),
      ),
    ).toEqual({ status: 'refused', code: 'last_owner' });
    expect(
      await t.remove.execute(
        new RemoveMemberCommand(t.ids.owner, t.org, t.ids.owner),
      ),
    ).toEqual({ status: 'refused', code: 'last_owner' });
    await t.change.execute(
      new ChangeMemberCommand(
        t.ids.owner,
        t.org,
        t.ids.admin,
        'owner',
        undefined,
      ),
    );
    expect(
      await t.remove.execute(
        new RemoveMemberCommand(t.ids.owner, t.org, t.ids.owner),
      ),
    ).toEqual({ status: 'ok' });
  });

  it('lets anybody leave, and no member remove somebody in another organisation', async () => {
    const t = await setup();
    expect(
      await t.remove.execute(
        new RemoveMemberCommand(t.ids.billing, t.org, t.ids.billing),
      ),
    ).toEqual({ status: 'ok' });
    expect(
      await t.remove.execute(
        new RemoveMemberCommand(t.ids.owner, t.foreignOrg, t.ids.stranger),
      ),
    ).toEqual({ status: 'not_found' });
    expect(await t.roleOf(t.ids.stranger, t.foreignOrg)).toBe('owner');
  });

  it('answers adding an unknown address like adding a known one (T-79)', async () => {
    const t = await setup();
    const known = await t.add.execute(
      new AddMemberCommand(t.ids.owner, t.org, 'stranger@example.ch', 'viewer'),
    );
    const unknown = await t.add.execute(
      new AddMemberCommand(t.ids.owner, t.org, 'ghost@example.ch', 'viewer'),
    );
    const again = await t.add.execute(
      new AddMemberCommand(t.ids.owner, t.org, 'stranger@example.ch', 'admin'),
    );
    expect(unknown).toEqual(known);
    expect(again).toEqual(known);
    // Adding twice does not change the role, and the new member has no release permission.
    expect(await t.roleOf(t.ids.stranger)).toBe('viewer');
    expect(await t.releaseOf(t.ids.stranger)).toBe(false);
    expect(
      await t.add.execute(
        new AddMemberCommand(t.ids.owner, t.org, 'not-an-address', 'viewer'),
      ),
    ).toEqual({ status: 'refused', code: 'email_invalid' });
  });
});

describe('projects belong to an organisation (SEC-50)', () => {
  it('lets Owner, Admin and Editor create, everybody but Billing read, Owner and Admin delete', async () => {
    const t = await setup();
    const made = await t.createProject.execute(
      new CreateProjectCommand(t.ids.editor, t.org, 'Shop'),
    );
    if (made.status !== 'ok') throw new Error('create');
    const id = made.project.id;
    expect(
      await t.createProject.execute(
        new CreateProjectCommand(t.ids.viewer, t.org, 'x'),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.createProject.execute(
        new CreateProjectCommand(t.ids.billing, t.org, 'x'),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.createProject.execute(
        new CreateProjectCommand(t.ids.owner, t.org, ' '),
      ),
    ).toEqual({ status: 'refused', code: 'name_invalid' });
    expect(
      await t.listProjects.execute(new ListProjectsQuery(t.ids.viewer, t.org)),
    ).toMatchObject({ status: 'ok' });
    expect(
      await t.listProjects.execute(new ListProjectsQuery(t.ids.billing, t.org)),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.deleteProject.execute(
        new DeleteProjectCommand(t.ids.editor, t.org, id),
      ),
    ).toEqual({ status: 'forbidden' });
    expect(
      await t.deleteProject.execute(
        new DeleteProjectCommand(t.ids.admin, t.org, id),
      ),
    ).toEqual({ status: 'ok' });
  });

  it('never finds a project through another organisation, by id or in a list (IDOR)', async () => {
    const t = await setup();
    const made = await t.createProject.execute(
      new CreateProjectCommand(t.ids.owner, t.org, 'Shop'),
    );
    if (made.status !== 'ok') throw new Error('create');
    const id = made.project.id;
    // The stranger owns another organisation and names the foreign project id there.
    expect(
      await t.getProject.execute(
        new GetProjectQuery(t.ids.stranger, t.foreignOrg, id),
      ),
    ).toEqual({ status: 'not_found' });
    expect(
      await t.deleteProject.execute(
        new DeleteProjectCommand(t.ids.stranger, t.foreignOrg, id),
      ),
    ).toEqual({ status: 'not_found' });
    // … or names the real organisation.
    expect(
      await t.getProject.execute(
        new GetProjectQuery(t.ids.stranger, t.org, id),
      ),
    ).toEqual({ status: 'not_found' });
    expect(
      await t.deleteProject.execute(
        new DeleteProjectCommand(t.ids.stranger, t.org, id),
      ),
    ).toEqual({ status: 'not_found' });
    expect(
      await t.listProjects.execute(
        new ListProjectsQuery(t.ids.stranger, t.foreignOrg),
      ),
    ).toEqual({ status: 'ok', projects: [] });
    expect(t.projects.projects).toHaveLength(1);
  });
});
