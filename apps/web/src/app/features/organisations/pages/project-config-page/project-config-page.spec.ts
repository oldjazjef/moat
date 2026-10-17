import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import {
  ORG_ID,
  OWNER_ACCESS,
  VIEWER_ACCESS,
  click,
  entry,
  openCloudPage,
  refuse,
  sent,
  settle,
  text,
} from '../../../../../testing/cloud-harness';
import type { MyAccess } from '../../../../core/auth/account.types';
import type { ConfigView } from '../../../../core/api/gates.types';
import { ProjectConfigPage } from './project-config-page';

const PROJECT = 'PPPPPPPPPPPPPPPPPPPPP1';
const BASE = `/api/orgs/${ORG_ID}/projects/${PROJECT}`;
const ROUTES = [
  {
    path: 'app/organisations/:orgId/projects/:projectId/config',
    component: ProjectConfigPage,
  },
  { path: 'app/organisations/:orgId/projects/:projectId', children: [] },
  { path: 'app/organisations/:orgId/projects', children: [] },
  { path: 'app/organisations/:orgId/members', children: [] },
];
const HASH = 'h'.repeat(64);
const FILE: ConfigView = { text: 'version: 1\n', revision: 1, hash: HASH };

const open = (access: MyAccess = OWNER_ACCESS, config: ConfigView = FILE) =>
  openCloudPage(
    `/app/organisations/${ORG_ID}/projects/${PROJECT}/config`,
    ROUTES,
    {
      [`/api/orgs/${ORG_ID}`]: entry(access),
      [BASE]: { project: { id: PROJECT, name: 'Shop' } },
      [`${BASE}/config`]: config,
    },
  );

function edit(el: HTMLElement, value: string) {
  const area = el.querySelector<HTMLTextAreaElement>('[data-config-text]');
  if (!area) throw new Error('no editor');
  area.value = value;
  area.dispatchEvent(new Event('input'));
}

const tick = async (harness: { detectChanges(): void }) => {
  await new Promise((resolve) => setTimeout(resolve));
  harness.detectChanges();
};

describe('ProjectConfigPage (Konfiguration eines Cloud-Projekts)', () => {
  afterEach(() => localStorage.clear());

  it('shows moat.yaml, and saves only what changed, naming the hash it started from', async () => {
    const { el, harness } = await open();
    const area = el.querySelector<HTMLTextAreaElement>('[data-config-text]');
    expect(area?.value).toBe('version: 1\n');
    expect(el.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(
      true,
    );
    edit(el, 'version: 1\n# changed\n');
    harness.detectChanges();
    expect(el.querySelector<HTMLButtonElement>('[data-save]')?.disabled).toBe(
      false,
    );
    click(el, '[data-save]');
    const request = await sent('PUT', `${BASE}/config`);
    expect(request.request.body).toEqual({
      text: 'version: 1\n# changed\n',
      base: HASH,
    });
    request.flush({
      text: 'version: 1\n# changed\n',
      revision: 2,
      hash: 'i'.repeat(64),
    });
    await tick(harness);
    TestBed.inject(HttpTestingController)
      .expectOne(`${BASE}/config`)
      .flush({
        text: 'version: 1\n# changed\n',
        revision: 2,
        hash: 'i'.repeat(64),
      });
    await tick(harness);
    expect(text(el, '[data-saved]')).toBe('Gespeichert.');
  });

  it('creates the file when there is none (no base)', async () => {
    const { el, harness } = await open(OWNER_ACCESS, {
      text: null,
      revision: 0,
      hash: null,
    });
    expect(el.querySelector('[data-no-config]')).not.toBeNull();
    edit(el, 'version: 1\n');
    harness.detectChanges();
    click(el, '[data-save]');
    const request = await sent('PUT', `${BASE}/config`);
    expect(request.request.body).toEqual({ text: 'version: 1\n' });
    request.flush({ text: 'version: 1\n', revision: 1, hash: HASH });
    await tick(harness);
    TestBed.inject(HttpTestingController)
      .expectOne(`${BASE}/config`)
      .flush({ text: 'version: 1\n', revision: 1, hash: HASH });
    await settle(harness);
  });

  it("shows the API's refusal of an invalid file and keeps the text", async () => {
    const { el, harness } = await open();
    edit(el, 'version: [');
    harness.detectChanges();
    click(el, '[data-save]');
    refuse(await sent('PUT', `${BASE}/config`), 422, 'config_invalid');
    await settle(harness);
    expect(text(el, '[data-save-error]')).toContain('nicht gültig');
    expect(
      el.querySelector<HTMLTextAreaElement>('[data-config-text]')?.value,
    ).toBe('version: [');
  });

  it('says when the file changed meanwhile, and offers to reload', async () => {
    const { el, harness } = await open();
    edit(el, 'version: 1\n# mine\n');
    harness.detectChanges();
    click(el, '[data-save]');
    refuse(await sent('PUT', `${BASE}/config`), 409, 'config_changed');
    await settle(harness);
    expect(text(el, '[data-save-error]')).toContain('inzwischen geändert');
    click(el, '[data-reload]');
    await tick(harness);
    TestBed.inject(HttpTestingController)
      .expectOne(`${BASE}/config`)
      .flush({
        text: 'version: 1\n# theirs\n',
        revision: 2,
        hash: 'j'.repeat(64),
      });
    await settle(harness);
    expect(
      el.querySelector<HTMLTextAreaElement>('[data-config-text]')?.value,
    ).toBe('version: 1\n# theirs\n');
    expect(el.querySelector('[data-save-error]')).toBeNull();
  });

  it('a viewer reads it, cannot change it, and is told', async () => {
    const { el } = await open(VIEWER_ACCESS);
    expect(el.querySelector('[data-save]')).toBeNull();
    expect(
      el.querySelector<HTMLTextAreaElement>('[data-config-text]')?.readOnly,
    ).toBe(true);
    expect(text(el, '[data-read-only]')).toContain('lesen');
  });

  it('a foreign project is one plain "not found" (SEC-50)', async () => {
    const { el } = await openCloudPage(
      `/app/organisations/${ORG_ID}/projects/${PROJECT}/config`,
      ROUTES,
      {
        [`/api/orgs/${ORG_ID}`]: entry(OWNER_ACCESS),
        [BASE]: { failStatus: 404 },
        [`${BASE}/config`]: { failStatus: 404 },
      },
    );
    expect(text(el, '[data-not-found]')).toContain('Nicht gefunden');
    expect(el.querySelector('[data-config-text]')).toBeNull();
  });
});
