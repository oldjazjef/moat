import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import {
  ADMIN_ACCESS,
  ORG_ID,
  OWNER_ACCESS,
  VIEWER_ACCESS,
  click,
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
import type { GateView } from '../../../../core/api/gates.types';
import { ProjectGatesPage } from './project-gates-page';

const PROJECT = 'PPPPPPPPPPPPPPPPPPPPP1';
const BASE = `/api/orgs/${ORG_ID}/projects/${PROJECT}`;
const ROUTES = [
  {
    path: 'app/organisations/:orgId/projects/:projectId',
    component: ProjectGatesPage,
  },
  { path: 'app/organisations/:orgId/projects/:projectId/config', children: [] },
  { path: 'app/organisations/:orgId/projects', children: [] },
  { path: 'app/organisations/:orgId/members', children: [] },
];
const SIGNER = {
  kid: 'K'.repeat(22),
  publicKey: 'P'.repeat(43),
  fingerprint: 'MOAT-AAAA-BBBB',
};
const gate = (patch: Partial<GateView> = {}): GateView => ({
  name: 'site',
  gateId: 'G'.repeat(22),
  mode: 'managed',
  boxKeyFingerprint: 'MOAT-BOX1-2222',
  signerFingerprint: SIGNER.fingerprint,
  hasPullAddress: false,
  latestVersion: 0,
  createdAt: '2026-10-18T08:00:00.000Z',
  ...patch,
});

const open = (
  access: MyAccess = OWNER_ACCESS,
  gates: GateView[] = [gate()],
  signer: typeof SIGNER | null = SIGNER,
) =>
  openCloudPage(`/app/organisations/${ORG_ID}/projects/${PROJECT}`, ROUTES, {
    [`/api/orgs/${ORG_ID}`]: entry(access),
    [BASE]: { project: { id: PROJECT, name: 'Shop' } },
    [`${BASE}/gates`]: { gates, signer },
  });

const tick = async (harness: { detectChanges(): void }) => {
  await new Promise((resolve) => setTimeout(resolve));
  harness.detectChanges();
};

const flushNext = async (
  harness: Parameters<typeof settle>[0],
  url: string,
  body: object,
) => {
  TestBed.inject(HttpTestingController).expectOne(url).flush(body);
  await settle(harness);
};

describe('ProjectGatesPage (Gates eines Cloud-Projekts)', () => {
  afterEach(() => localStorage.clear());

  it('shows the gates with their trust mode and the honest sentence, and the signing key to pin', async () => {
    const { el } = await open();
    expect(text(el, 'mt-page-header')).toContain('Shop');
    expect(text(el, '[data-signer-fingerprint]')).toBe(SIGNER.fingerprint);
    expect(text(el, '[data-signer-key]')).toBe(SIGNER.publicKey);
    const card = el.querySelector('[data-gate-name="site"]');
    expect(
      card?.querySelector('[data-trust-mode]')?.getAttribute('data-mode'),
    ).toBe('convenient');
    expect(text(el, '[data-trust-mode]')).toContain('Bequem');
    // §2.9, word for word: the sentence is there, and nothing stronger is claimed.
    expect(text(el, '[data-trust-if-hacked]')).toContain(
      'Wenn Moat Cloud gehackt wird … kann ein Angreifer deine Routen innerhalb der lokalen Grenzen deines Gates ändern.',
    );
    expect(text(el, '[data-recommend]')).toContain('Signiert');
    expect(text(el, '[data-version]')).toBe('noch keines');
  });

  it('a gate the customer signs for is "Signiert" and offers an upload, not a signature', async () => {
    const { el } = await open(OWNER_ACCESS, [
      gate({ mode: 'signed', signerFingerprint: 'MOAT-CUST-0000' }),
    ]);
    expect(
      el.querySelector('[data-trust-mode]')?.getAttribute('data-mode'),
    ).toBe('signed');
    expect(el.querySelector('[data-recommend]')).toBeNull();
    expect(el.querySelector('[data-preview]')).toBeNull();
    expect(el.querySelector('[data-upload-form]')).not.toBeNull();
  });

  it('says when this Moat Cloud has no signing key', async () => {
    const { el } = await open(OWNER_ACCESS, [], null);
    expect(text(el, '[data-no-signer]')).toContain('keinen Signaturschlüssel');
    expect(el.querySelector('[data-no-gate]')).not.toBeNull();
  });

  it('a viewer reads, and sees neither the forms nor the release button, and why', async () => {
    const { el } = await open(VIEWER_ACCESS);
    expect(el.querySelector('[data-gate]')).not.toBeNull();
    expect(el.querySelector('[data-gate-form]')).toBeNull();
    expect(el.querySelector('[data-secret-form]')).toBeNull();
    expect(el.querySelector('[data-pull-create]')).toBeNull();
    expect(text(el, '[data-cannot-manage]')).toContain('keine Gates anlegen');
  });

  it('enrols a gate with the fingerprint the person compared', async () => {
    const { el, harness } = await open();
    typeInto(el, '#gate-name', 'shop');
    typeInto(el, '#gate-id', 'I'.repeat(22));
    typeInto(el, '#gate-box-key', 'B'.repeat(43));
    typeInto(el, '#gate-fingerprint', ' MOAT-BOX1-2222 ');
    submitForm(el, '[data-gate-form]');
    const request = await sent('POST', `${BASE}/gates`);
    expect(request.request.body).toEqual({
      name: 'shop',
      gateId: 'I'.repeat(22),
      boxKey: 'B'.repeat(43),
      fingerprint: 'MOAT-BOX1-2222',
    });
    request.flush({ gate: gate({ name: 'shop' }) });
    await tick(harness);
    await flushNext(harness, `${BASE}/gates`, {
      gates: [gate(), gate({ name: 'shop' })],
      signer: SIGNER,
    });
    expect(el.querySelectorAll('[data-gate]').length).toBe(2);
  });

  it("sends the customer's public key when there is one, and refuses a malformed form before asking", async () => {
    const { el } = await open();
    typeInto(el, '#gate-name', 'Bad Name');
    submitForm(el, '[data-gate-form]');
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.inject(HttpTestingController).expectNone(`${BASE}/gates`);
  });

  it("shows the API's refusal of a fingerprint that does not match", async () => {
    const { el, harness } = await open();
    typeInto(el, '#gate-name', 'shop');
    typeInto(el, '#gate-id', 'I'.repeat(22));
    typeInto(el, '#gate-box-key', 'B'.repeat(43));
    typeInto(el, '#gate-fingerprint', 'MOAT-WRONG');
    submitForm(el, '[data-gate-form]');
    refuse(await sent('POST', `${BASE}/gates`), 422, 'fingerprint_mismatch');
    await settle(harness);
    expect(text(el, '[data-add-error]')).toContain('Fingerabdruck passt nicht');
  });

  it('shows the preview, signs exactly that bundle, and says the version', async () => {
    const { el, harness } = await open();
    click(el, '[data-preview]');
    await flushNext(harness, `${BASE}/gates/site/release`, {
      preview: {
        gate: 'site',
        version: 2,
        previousVersion: 1,
        locked: false,
        digest: 'd'.repeat(64),
        changes: [
          { kind: 'route', name: 'newsletter', change: 'added', fields: [] },
          {
            kind: 'secret',
            name: 'hubspot-token',
            change: 'changed',
            fields: [],
          },
        ],
      },
    });
    expect(text(el, '[data-preview-result]')).toContain('Version 2');
    expect(el.querySelectorAll('[data-changes] li').length).toBe(2);
    expect(text(el, '[data-changes]')).toContain('Route newsletter: neu');
    click(el, '[data-release-submit]');
    const request = await sent('POST', `${BASE}/gates/site/releases`);
    expect(request.request.body).toEqual({ digest: 'd'.repeat(64) });
    request.flush({ version: 2, kid: SIGNER.kid, sha256: 'a'.repeat(64) });
    await tick(harness);
    await flushNext(harness, `${BASE}/gates`, {
      gates: [gate({ latestVersion: 2 })],
      signer: SIGNER,
    });
    expect(text(el, '[data-done]')).toContain('Version 2 wurde signiert');
  });

  it('shows what is missing when secrets are not stored, and that a changed input was not signed', async () => {
    const { el, harness } = await open();
    click(el, '[data-preview]');
    TestBed.inject(HttpTestingController)
      .expectOne(`${BASE}/gates/site/release`)
      .flush(
        {
          statusCode: 422,
          error: 'secrets_missing',
          secrets: ['hubspot-token'],
        },
        { status: 422, statusText: 'Error' },
      );
    await settle(harness);
    expect(text(el, '[data-gate-error]')).toContain('braucht Secrets');
    expect(text(el, '[data-missing-secrets]')).toBe('hubspot-token');
  });

  it('without the release permission the preview has no button to sign', async () => {
    const { el, harness } = await open(ADMIN_ACCESS);
    click(el, '[data-preview]');
    await flushNext(harness, `${BASE}/gates/site/release`, {
      preview: {
        gate: 'site',
        version: 1,
        previousVersion: 0,
        locked: false,
        digest: 'd'.repeat(64),
        changes: [],
      },
    });
    expect(el.querySelector('[data-release-submit]')).toBeNull();
    expect(text(el, '[data-no-release]')).toContain('Recht zur Freigabe');
    expect(el.querySelector('[data-no-change]')).not.toBeNull();
  });

  it('lists the secrets by name and version only, and stores a sealed one', async () => {
    const { el, harness } = await open();
    click(el, '[data-load-secrets]');
    await flushNext(harness, `${BASE}/gates/site/secrets`, { secrets: [] });
    expect(el.querySelector('[data-no-secret]')).not.toBeNull();
    typeInto(el, '#secret-name-site', 'hubspot-token');
    const sealed = {
      v: 1,
      alg: 'x',
      secretVersion: 1,
      epk: 'e',
      nonce: 'n',
      ct: 'c',
    };
    const area = el.querySelector<HTMLTextAreaElement>('#secret-sealed-site');
    if (!area) throw new Error('no textarea');
    area.value = JSON.stringify(sealed);
    area.dispatchEvent(new Event('input'));
    submitForm(el, '[data-secret-form]');
    const request = await sent(
      'PUT',
      `${BASE}/gates/site/secrets/hubspot-token`,
    );
    expect(request.request.body).toEqual({ sealed });
    request.flush({
      secret: { name: 'hubspot-token', secretVersion: 1, updatedAt: 'x' },
    });
    await tick(harness);
    await flushNext(harness, `${BASE}/gates/site/secrets`, {
      secrets: [{ name: 'hubspot-token', secretVersion: 1, updatedAt: 'x' }],
    });
    expect(text(el, '[data-secret]')).toContain('hubspot-token');
    expect(text(el, '[data-secret-saved]')).toContain('hubspot-token');
  });

  it('refuses text that is not JSON without asking the API (nothing typed here is a secret)', async () => {
    const { el, harness } = await open();
    typeInto(el, '#secret-name-site', 'hubspot-token');
    const area = el.querySelector<HTMLTextAreaElement>('#secret-sealed-site');
    if (!area) throw new Error('no textarea');
    area.value = 'my-real-api-token';
    area.dispatchEvent(new Event('input'));
    submitForm(el, '[data-secret-form]');
    await settle(harness);
    TestBed.inject(HttpTestingController).expectNone(
      `${BASE}/gates/site/secrets/hubspot-token`,
    );
    expect(text(el, '[data-gate-error]')).toContain('kein versiegeltes Secret');
  });

  it('shows the pull address once, and only says it exists afterwards', async () => {
    const { el, harness } = await open();
    click(el, '[data-pull-create]');
    const request = await sent('POST', `${BASE}/gates/site/pull-address`);
    request.flush({
      url: `https://moat.example.ch/api/pull/${'T'.repeat(43)}`,
    });
    await tick(harness);
    await flushNext(harness, `${BASE}/gates`, {
      gates: [gate({ hasPullAddress: true })],
      signer: SIGNER,
    });
    expect(text(el, '[data-address]')).toContain('/api/pull/');
    expect(text(el, '[data-pull]')).toContain('nur einmal angezeigt');
  });

  it('only says an address exists when the page is opened later', async () => {
    const { el } = await open(OWNER_ACCESS, [gate({ hasPullAddress: true })]);
    expect(el.querySelector('[data-address]')).toBeNull();
    expect(text(el, '[data-has-address]')).toContain(
      'nicht noch einmal angezeigt',
    );
  });

  it('uploads a bundle for a gate the customer signs', async () => {
    const { el, harness } = await open(OWNER_ACCESS, [
      gate({ mode: 'signed', signerFingerprint: 'MOAT-CUST-0000' }),
    ]);
    const area = el.querySelector<HTMLTextAreaElement>('#envelope-site');
    if (!area) throw new Error('no textarea');
    area.value = '{"moat":"bundle"}';
    area.dispatchEvent(new Event('input'));
    submitForm(el, '[data-upload-form]');
    const request = await sent('POST', `${BASE}/gates/site/bundles`);
    expect(request.request.body).toEqual({ envelope: '{"moat":"bundle"}' });
    request.flush({ version: 3, sha256: 'a'.repeat(64) });
    await tick(harness);
    await flushNext(harness, `${BASE}/gates`, {
      gates: [
        gate({
          mode: 'signed',
          signerFingerprint: 'MOAT-CUST-0000',
          latestVersion: 3,
        }),
      ],
      signer: SIGNER,
    });
    expect(text(el, '[data-done]')).toContain('Version 3 wurde geprüft');
  });

  it('a foreign project is one plain "not found" (SEC-50)', async () => {
    const { el } = await openCloudPage(
      `/app/organisations/${ORG_ID}/projects/${PROJECT}`,
      ROUTES,
      {
        [`/api/orgs/${ORG_ID}`]: entry(OWNER_ACCESS),
        [BASE]: { failStatus: 404 },
        [`${BASE}/gates`]: { failStatus: 404 },
      },
    );
    expect(text(el, '[data-not-found]')).toContain('Nicht gefunden');
    expect(el.querySelector('[data-gate]')).toBeNull();
  });
});
