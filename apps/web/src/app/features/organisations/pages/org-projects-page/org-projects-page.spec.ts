import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { ActiveOrganisation } from '../../../../core/auth/active-organisation.service';
import {
  ORG_ID,
  OWNER_ACCESS,
  VIEWER_ACCESS,
  entry,
  openCloudPage,
  refuse,
  sent,
  settle,
  submitForm,
  text,
  typeInto,
} from '../../../../../testing/cloud-harness';
import type { MyAccess } from '../../../../core/auth/account.types';
import { OrgProjectsPage } from './org-projects-page';

const ROUTES = [
  { path: 'app/organisations/:orgId/projects', component: OrgProjectsPage },
  { path: 'app/organisations/:orgId/members', children: [] },
];
const PROJECTS = [
  {
    id: 'PPPPPPPPPPPPPPPPPPPPP1',
    name: 'Website',
    createdAt: '2026-10-15T08:00:00.000Z',
  },
  {
    id: 'PPPPPPPPPPPPPPPPPPPPP2',
    name: 'Newsletter',
    createdAt: '2026-10-16T08:00:00.000Z',
  },
];

const open = (access: MyAccess = OWNER_ACCESS, projects = PROJECTS) =>
  openCloudPage(`/app/organisations/${ORG_ID}/projects`, ROUTES, {
    [`/api/orgs/${ORG_ID}`]: entry(access),
    [`/api/orgs/${ORG_ID}/projects`]: { projects },
  });

describe('OrgProjectsPage (Projekte der Organisation)', () => {
  afterEach(() => localStorage.clear());

  it('lists the projects of the organisation and makes it the one in the sidebar', async () => {
    const { el } = await open();
    expect(text(el, 'mt-page-header')).toContain('Muster AG');
    expect(
      [...el.querySelectorAll('[data-project-name]')].map((td) =>
        td.textContent?.trim(),
      ),
    ).toEqual(['Website', 'Newsletter']);
    expect(TestBed.inject(ActiveOrganisation).id()).toBe(ORG_ID);
    expect(el.querySelector('[data-tab="members"]')?.getAttribute('href')).toBe(
      `/app/organisations/${ORG_ID}/members`,
    );
  });

  it('says so when there is no project yet', async () => {
    const { el } = await open(OWNER_ACCESS, []);
    expect(el.querySelector('[data-no-project]')).not.toBeNull();
  });

  it('creates a project and reads the list again', async () => {
    const { el, harness } = await open();
    typeInto(el, '#project-name', '  Shop  ');
    submitForm(el, '[data-project-form]');
    const request = await sent('POST', `/api/orgs/${ORG_ID}/projects`);
    expect(request.request.body).toEqual({ name: 'Shop' });
    request.flush({
      project: {
        id: 'PPPPPPPPPPPPPPPPPPPPP3',
        name: 'Shop',
        createdAt: '2026-10-17T08:00:00.000Z',
      },
    });
    await new Promise((resolve) => setTimeout(resolve));
    harness.detectChanges();
    TestBed.inject(HttpTestingController)
      .expectOne(`/api/orgs/${ORG_ID}/projects`)
      .flush({
        projects: [
          ...PROJECTS,
          {
            id: 'PPPPPPPPPPPPPPPPPPPPP3',
            name: 'Shop',
            createdAt: '2026-10-17T08:00:00.000Z',
          },
        ],
      });
    await settle(harness);
    expect(el.querySelectorAll('[data-project]').length).toBe(3);
    expect((el.querySelector('#project-name') as HTMLInputElement).value).toBe(
      '',
    );
  });

  it("shows the API's refusal of a name", async () => {
    const { el, harness } = await open();
    typeInto(el, '#project-name', 'x');
    submitForm(el, '[data-project-form]');
    refuse(
      await sent('POST', `/api/orgs/${ORG_ID}/projects`),
      422,
      'name_invalid',
    );
    await settle(harness);
    expect(text(el, '[data-create-error]')).toContain(
      'Dieser Name ist nicht möglich',
    );
  });

  it('a viewer sees the list, no form, and why', async () => {
    const { el } = await open(VIEWER_ACCESS);
    expect(el.querySelector('[data-project-form]')).toBeNull();
    expect(text(el, '[data-cannot-create]')).toBe(
      'Deine Rolle darf keine Projekte anlegen.',
    );
    expect(el.querySelectorAll('[data-project]').length).toBe(2);
  });

  it('a foreign organisation is one plain "not found" (SEC-50)', async () => {
    const { el } = await openCloudPage(
      `/app/organisations/${ORG_ID}/projects`,
      ROUTES,
      {
        [`/api/orgs/${ORG_ID}`]: { failStatus: 404 },
        [`/api/orgs/${ORG_ID}/projects`]: { failStatus: 404 },
      },
    );
    expect(text(el, '[data-not-found]')).toContain('Nicht gefunden');
    expect(el.querySelector('[data-projects]')).toBeNull();
    expect(TestBed.inject(ActiveOrganisation).id()).toBeNull();
  });
});
