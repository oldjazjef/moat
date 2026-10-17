import { type AuditRow, verifyAudit } from '@moat/core';
import { describe, expect, it } from 'vitest';
import { newId } from '../../common/clock';
import {
  AddMemberCommand,
  ChangeMemberCommand,
  CreateProjectCommand,
  DeleteProjectCommand,
  RemoveMemberCommand,
} from '../../tenancy/application/tenancy.commands';
import { InMemoryAudit } from '../../testing/in-memory';
import { AuditTrail } from './audit-trail';
import {
  ExportAuditQuery,
  ListAuditQuery,
  VerifyAuditQuery,
} from './audit.commands';
import {
  ExportAuditHandler,
  ListAuditHandler,
  VerifyAuditHandler,
} from './audit.handlers';
import {
  AddMemberHandler,
  ChangeMemberHandler,
  CreateOrganisationHandler,
  CreateProjectHandler,
  DeleteProjectHandler,
  RemoveMemberHandler,
} from '../../tenancy/application/tenancy.handlers';
import { CreateOrganisationCommand } from '../../tenancy/application/tenancy.commands';
import {
  FixedClock,
  InMemoryAccounts,
  InMemoryOrganisations,
  InMemoryOrgProjects,
} from '../../testing/in-memory';
import { auditCsv, csvCell } from '../domain/audit-export';

async function setup() {
  const accounts = new InMemoryAccounts();
  const organisations = new InMemoryOrganisations(accounts);
  const projects = new InMemoryOrgProjects();
  const clock = new FixedClock();
  const log = new InMemoryAudit();
  const trail = new AuditTrail(log, clock);
  const person = async (name: string) => {
    const id = newId();
    await accounts.create({
      id,
      email: `${name}@example.ch`,
      passwordHash: '$argon2id$x',
      passwordChangedAt: clock.now().toISOString(),
      createdAt: clock.now().toISOString(),
    });
    return id;
  };
  const ids = {
    owner: await person('owner'),
    admin: await person('admin'),
    editor: await person('editor'),
    viewer: await person('viewer'),
    stranger: await person('stranger'),
  };
  const create = new CreateOrganisationHandler(organisations, clock, trail);
  const made = await create.execute(
    new CreateOrganisationCommand(ids.owner, 'Acme AG'),
  );
  if (made.status !== 'ok') throw new Error('org');
  const org = made.organisation.id;
  const other = await create.execute(
    new CreateOrganisationCommand(ids.stranger, 'Other GmbH'),
  );
  if (other.status !== 'ok') throw new Error('org');
  return {
    ids,
    org,
    foreign: other.organisation.id,
    log,
    clock,
    add: new AddMemberHandler(organisations, clock, trail),
    change: new ChangeMemberHandler(organisations, trail),
    remove: new RemoveMemberHandler(organisations, trail),
    createProject: new CreateProjectHandler(
      organisations,
      projects,
      clock,
      trail,
    ),
    deleteProject: new DeleteProjectHandler(organisations, projects, trail),
    list: new ListAuditHandler(organisations, log),
    verify: new VerifyAuditHandler(organisations, log),
    export: new ExportAuditHandler(organisations, log),
    trail,
  };
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

describe('audit log of an organisation (SEC-53)', () => {
  it('records the founding, every member change and every project change, in one chain', async () => {
    const t = await setup();
    await t.add.execute(
      new AddMemberCommand(t.ids.owner, t.org, 'admin@example.ch', 'admin'),
    );
    await t.change.execute(
      new ChangeMemberCommand(t.ids.owner, t.org, t.ids.admin, 'editor', true),
    );
    const made = await t.createProject.execute(
      new CreateProjectCommand(t.ids.owner, t.org, 'Shop'),
    );
    if (made.status !== 'ok') throw new Error('project');
    await t.deleteProject.execute(
      new DeleteProjectCommand(t.ids.owner, t.org, made.project.id),
    );
    await t.remove.execute(
      new RemoveMemberCommand(t.ids.owner, t.org, t.ids.admin),
    );
    const rows = t.log.rows.filter((r) => r.organisationId === t.org);
    expect(rows.map((r) => r.action)).toEqual([
      'org.create',
      'member.add_requested',
      'member.change',
      'project.create',
      'project.delete',
      'member.remove',
    ]);
    expect(rows.every((r) => r.actor === t.ids.owner)).toBe(true);
    expect(rows[2]).toMatchObject({ target: t.ids.admin });
    expect(JSON.parse(must(rows[2]).details)).toEqual({
      fromRole: 'admin',
      toRole: 'editor',
      fromRelease: false,
      toRelease: true,
    });
    expect(await verifyAudit(t.org, rows, null)).toMatchObject({
      status: 'intact',
      entries: 6,
    });
  });

  it('records a refused change nowhere: nothing happened, nothing is logged', async () => {
    const t = await setup();
    // The Admin is not an Owner: the last-owner rule and role rules refuse these.
    await t.add.execute(
      new AddMemberCommand(t.ids.owner, t.org, 'admin@example.ch', 'admin'),
    );
    const before = t.log.rows.length;
    await t.change.execute(
      new ChangeMemberCommand(
        t.ids.owner,
        t.org,
        t.ids.owner,
        'viewer',
        undefined,
      ),
    );
    await t.remove.execute(
      new RemoveMemberCommand(t.ids.admin, t.org, t.ids.owner),
    );
    await t.createProject.execute(
      new CreateProjectCommand(t.ids.stranger, t.org, 'x'),
    );
    await t.createProject.execute(
      new CreateProjectCommand(t.ids.owner, t.org, ''),
    );
    expect(t.log.rows.length).toBe(before);
  });

  it('records the address of a member request as a hash only, and the same row for an unknown address (T-79)', async () => {
    const t = await setup();
    await t.add.execute(
      new AddMemberCommand(t.ids.owner, t.org, 'Admin@Example.ch', 'viewer'),
    );
    await t.add.execute(
      new AddMemberCommand(t.ids.owner, t.org, 'nobody@example.ch', 'viewer'),
    );
    const rows = t.log.rows.filter((r) => r.action === 'member.add_requested');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.target).toBeNull();
      expect(row.details).not.toContain('example');
      expect(Object.keys(JSON.parse(row.details) as object).sort()).toEqual([
        'emailHash',
        'role',
      ]);
    }
    expect(JSON.parse(must(rows[0]).details)).not.toEqual(
      JSON.parse(must(rows[1]).details),
    );
  });

  it('keeps one gap-free chain per organisation, whatever the interleaving', async () => {
    const t = await setup();
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) =>
        t.createProject.execute(
          new CreateProjectCommand(t.ids.owner, t.org, `P${i}`),
        ),
      ),
    ]);
    const mine = t.log.rows
      .filter((r) => r.organisationId === t.org)
      .sort((a, b) => a.seq - b.seq);
    expect(mine.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await verifyAudit(t.org, mine, null)).toMatchObject({
      status: 'intact',
    });
    expect(
      t.log.rows.filter((r) => r.organisationId === t.foreign),
    ).toHaveLength(1);
  });

  it('lets only Owner and Admin read, list, verify and export; a foreign or unknown organisation is a 404 (SEC-50, SEC-52)', async () => {
    const t = await setup();
    for (const role of ['admin', 'editor', 'viewer'] as const)
      await t.add.execute(
        new AddMemberCommand(t.ids.owner, t.org, `${role}@example.ch`, role),
      );
    for (const who of [t.ids.owner, t.ids.admin]) {
      expect(
        (await t.list.execute(new ListAuditQuery(who, t.org, 0, 50))).status,
      ).toBe('ok');
      expect(
        (await t.verify.execute(new VerifyAuditQuery(who, t.org, null))).status,
      ).toBe('ok');
      expect(
        (await t.export.execute(new ExportAuditQuery(who, t.org, 0))).status,
      ).toBe('ok');
    }
    for (const who of [t.ids.editor, t.ids.viewer]) {
      expect(
        (await t.list.execute(new ListAuditQuery(who, t.org, 0, 50))).status,
      ).toBe('forbidden');
      expect(
        (await t.verify.execute(new VerifyAuditQuery(who, t.org, null))).status,
      ).toBe('forbidden');
      expect(
        (await t.export.execute(new ExportAuditQuery(who, t.org, 0))).status,
      ).toBe('forbidden');
    }
    for (const org of [t.foreign, 'not-an-id', newId()]) {
      expect(
        (await t.list.execute(new ListAuditQuery(t.ids.owner, org, 0, 50)))
          .status,
      ).toBe('not_found');
      expect(
        (await t.verify.execute(new VerifyAuditQuery(t.ids.owner, org, null)))
          .status,
      ).toBe('not_found');
      expect(
        (await t.export.execute(new ExportAuditQuery(t.ids.owner, org, 0)))
          .status,
      ).toBe('not_found');
    }
  });

  it("pages with next, and never returns another organisation's rows", async () => {
    const t = await setup();
    for (let i = 0; i < 5; i += 1)
      await t.createProject.execute(
        new CreateProjectCommand(t.ids.owner, t.org, `P${i}`),
      );
    const first = await t.list.execute(
      new ListAuditQuery(t.ids.owner, t.org, 0, 4),
    );
    if (first.status !== 'ok') throw new Error('list');
    expect(first.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(first.next).toBe(4);
    const second = await t.list.execute(
      new ListAuditQuery(t.ids.owner, t.org, 4, 4),
    );
    if (second.status !== 'ok') throw new Error('list');
    expect(second.entries.map((e) => e.seq)).toEqual([5, 6]);
    expect(second.next).toBeNull();
    expect(
      [...first.entries, ...second.entries].every(
        (e) => e.organisationId === t.org,
      ),
    ).toBe(true);
  });

  it('verify reports a tampered row, a cut tail and a wrong head', async () => {
    const t = await setup();
    for (let i = 0; i < 3; i += 1)
      await t.createProject.execute(
        new CreateProjectCommand(t.ids.owner, t.org, `P${i}`),
      );
    const ok = await t.verify.execute(
      new VerifyAuditQuery(t.ids.owner, t.org, null),
    );
    if (ok.status !== 'ok') throw new Error('verify');
    expect(ok.check).toMatchObject({ status: 'intact', entries: 4 });
    const head = must(ok.head);
    expect(head.seq).toBe(4);

    // The tail is cut off after the auditor wrote the head down.
    const mine = t.log.rows.filter((r) => r.organisationId === t.org);
    t.log.rows.splice(t.log.rows.indexOf(must(mine[3])), 1);
    const cut = await t.verify.execute(
      new VerifyAuditQuery(t.ids.owner, t.org, head),
    );
    expect(cut).toMatchObject({ check: { status: 'broken', reason: 'head' } });

    // A row is edited in place (the database would refuse; a restored backup would not).
    const i = t.log.rows.indexOf(must(mine[1]));
    t.log.rows[i] = { ...must(mine[1]), actor: newId() } as AuditRow;
    const edited = await t.verify.execute(
      new VerifyAuditQuery(t.ids.owner, t.org, null),
    );
    expect(edited).toMatchObject({
      check: { status: 'broken', seq: 2, reason: 'hash' },
    });
  });

  it('exports CSV that no spreadsheet runs as a formula, and with every field a verifier needs', async () => {
    const t = await setup();
    await t.createProject.execute(
      new CreateProjectCommand(t.ids.owner, t.org, 'Shop'),
    );
    const result = await t.export.execute(
      new ExportAuditQuery(t.ids.owner, t.org, 0),
    );
    if (result.status !== 'ok') throw new Error('export');
    const csv = auditCsv(result.entries);
    const [header, ...lines] = csv.trimEnd().split('\r\n');
    expect(header).toBe(
      'seq,organisationId,at,actor,action,target,details,prevHash,hash',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('project.create');
    expect(lines[1]).toContain('"{}"'.replace('"{}"', '{}'));
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@a')).toBe("'@a");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(7)).toBe('7');
  });

  it('gives up with an error, not silently, when the log keeps refusing a row', async () => {
    const t = await setup();
    t.log.append = () => Promise.resolve('conflict');
    await expect(
      t.trail.record(t.org, t.ids.owner, {
        action: 'project.create',
        target: newId(),
        details: {},
      }),
    ).rejects.toThrow('audit log');
  });
});
