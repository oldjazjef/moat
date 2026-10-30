import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ProjectView } from '../../../../core/api/project.types';
import type { Recipe } from '../../../../core/api/recipe.types';
import type { DesktopBridge } from '../../../../core/desktop/desktop-bridge';
import {
  openPage,
  PROJECT,
  projectRoutes,
} from '../../../../../testing/page-harness';
import { RoutesPage } from '../../pages/routes-page/routes-page';
import { outcomeOf } from './recipe-panel';

const text = (el: Element | null) =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const STATE = PROJECT.project;
if (STATE === null) throw new Error('PROJECT has no state');
const VALID = STATE.config;
if (VALID.status !== 'valid') throw new Error('PROJECT config is not valid');
/** The project without routes, upstreams or gates: where a recipe starts. */
const BARE = {
  ...PROJECT,
  project: {
    config: {
      ...VALID,
      config: { ...VALID.config, upstreams: {}, routes: {} },
    },
    gates: [],
  },
};
/** BARE after «Übernehmen» of the OpenAI recipe. */
const APPLIED: ProjectView = {
  ...BARE,
  project: {
    ...BARE.project,
    config: {
      ...BARE.project.config,
      config: {
        ...BARE.project.config.config,
        routes: { chat: VALID.config.routes['newsletter'] },
      },
    },
  },
} as ProjectView;

const RECIPES: readonly Recipe[] = [
  {
    id: 'hubspot-newsletter',
    upstream: { name: 'hubspot', input: { origin: 'https://api.hubapi.com' } },
    route: {
      name: 'newsletter',
      input: {
        method: 'POST',
        path: '/newsletter',
        upstreamPath: '/crm/v3/objects/contacts',
      },
    },
    secret: 'hubspot-token',
    testBody: '{"properties":{"email":"test@example.com"}}\n',
  },
  {
    id: 'openai-chat',
    upstream: { name: 'openai', input: { origin: 'https://api.openai.com' } },
    route: {
      name: 'chat',
      input: {
        method: 'POST',
        path: '/chat',
        upstreamPath: '/v1/chat/completions',
      },
    },
    secret: 'openai-key',
    testBody: '{}\n',
  },
];

function bridge(): DesktopBridge {
  return {
    platform: 'linux',
    project: { add: vi.fn(), create: vi.fn(), reveal: vi.fn() },
    key: {
      status: vi.fn().mockResolvedValue({ status: 'none' }),
      choose: vi.fn(),
      create: vi.fn(),
      rotationDone: vi.fn(),
    },
    bundle: {
      sign: vi.fn().mockResolvedValue({ status: 'signed', version: 4 }),
    },
    secret: {
      seal: vi.fn().mockResolvedValue({ status: 'sealed', secretVersion: 3 }),
    },
    gate: { deploy: vi.fn(), import: vi.fn(), log: vi.fn() },
  };
}

const http = () => TestBed.inject(HttpTestingController);
/** Lets promises settle and renders; never waits for stability (requests stay open to check). */
async function settle(harness: { detectChanges(): void }): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve));
    harness.detectChanges();
  }
}
const click = (el: HTMLElement, selector: string) =>
  (el.querySelector(selector) as HTMLButtonElement).click();
function field(el: HTMLElement, selector: string): HTMLInputElement {
  const found = el.querySelector<HTMLInputElement>(selector);
  if (found === null) throw new Error(`${selector} missing`);
  return found;
}
/** Every open read of the project (the panel's and the page's) gets `view`. */
function answer(view: ProjectView): void {
  for (const request of http().match(`/api/projects/${PROJECT.id}`))
    request.flush(view);
}

/** The project's «Routen» with «Route aus Vorlage» opened. */
async function openRecipe(view: ProjectView) {
  const page = await openPage(
    `/app/projects/${PROJECT.id}/routes`,
    projectRoutes(RoutesPage),
    { [`/api/projects/${PROJECT.id}`]: view },
  );
  click(page.el, '[data-recipe-open]');
  await settle(page.harness);
  for (const request of http().match('/api/recipes')) request.flush(RECIPES);
  answer(view);
  await settle(page.harness);
  return page;
}

describe('«Route aus Vorlage» in Routen (FR-43)', () => {
  afterEach(() => {
    delete window.moatDesktop;
  });

  it('is closed until asked for', async () => {
    const { el } = await openPage(
      `/app/projects/${PROJECT.id}/routes`,
      projectRoutes(RoutesPage),
      { [`/api/projects/${PROJECT.id}`]: PROJECT },
    );
    expect(el.querySelector('[data-recipe-section]')).toBeNull();
    expect(
      el.querySelector('[data-recipe-open]')?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('applies a recipe with the website address (FR-43)', async () => {
    window.moatDesktop = bridge();
    const { el, harness } = await openRecipe(BARE);
    expect(
      el.querySelector('[data-recipe="hubspot-newsletter"]'),
    ).not.toBeNull();
    expect(el.querySelector('[data-recipe="openai-chat"]')).not.toBeNull();
    el.querySelector<HTMLInputElement>(
      '[data-recipe="openai-chat"] input',
    )?.click();
    const site = field(el, '#recipe-site');
    site.value = 'https://www.example.ch/';
    site.dispatchEvent(new Event('input'));
    click(el, '[data-recipe-apply]');
    await settle(harness);
    const edit = http().expectOne(`/api/projects/${PROJECT.id}/config/edits`);
    expect(edit.request.body).toEqual({
      base: PROJECT.configHash,
      op: 'applyRecipe',
      recipe: 'openai-chat',
      origins: ['https://www.example.ch'],
    });
    edit.flush(APPLIED);
    await settle(harness);
    answer(APPLIED);
    await settle(harness);
    expect(text(el.querySelector('[data-recipe-applied]'))).toContain('/chat');
    // No gate yet: nothing to test, and the step says why.
    expect(el.querySelector('[data-recipe-no-gate]')).not.toBeNull();
  });

  it('seals, signs and tests through the gate, and explains what came back', async () => {
    const desktop = bridge();
    window.moatDesktop = desktop;
    const { el, harness } = await openRecipe(PROJECT);
    expect(text(el.querySelector('[data-recipe-applied]'))).toContain(
      'HubSpot-Newsletter',
    );
    expect(text(el.querySelector('[data-recipe-sealed]'))).toContain('2');
    expect(text(el.querySelector('[data-recipe-commands]'))).toContain(
      'php moat-gate.php accept 3.json',
    );
    expect(text(el.querySelector('[data-recipe-test-warning]'))).toContain(
      'Kontakt',
    );

    click(el, '[data-recipe-seal-button]');
    await settle(harness);
    expect(desktop.secret.seal).toHaveBeenCalledWith(
      PROJECT.id,
      'site',
      'hubspot-token',
      'de-CH',
    );
    answer(PROJECT);
    click(el, '[data-recipe-sign-button]');
    await settle(harness);
    expect(desktop.bundle.sign).toHaveBeenCalledWith(
      PROJECT.id,
      'site',
      'de-CH',
    );
    answer(PROJECT);
    await settle(harness);
    expect(text(el.querySelector('[data-recipe-sign-result]'))).toContain(
      'Version 4',
    );

    click(el, '[data-recipe-policy-button]');
    await settle(harness);
    http()
      .expectOne(`/api/projects/${PROJECT.id}/policy`)
      .flush({ v: 1, upstreams: { 'api.hubapi.com': {} } });
    await settle(harness);
    expect(text(el.querySelector('[data-recipe-policy]'))).toContain(
      'api.hubapi.com',
    );

    const url = field(el, '#recipe-gate-url');
    url.value = ' https://www.example.ch/moat-gate.php ';
    url.dispatchEvent(new Event('input'));
    expect(field(el, '#recipe-body').value).toBe(RECIPES[0]?.testBody);
    click(el, '[data-recipe-test-button]');
    await settle(harness);
    const first = http().expectOne(`/api/projects/${PROJECT.id}/test-request`);
    expect(first.request.body).toEqual({
      url: 'https://www.example.ch/moat-gate.php',
      route: 'newsletter',
      body: RECIPES[0]?.testBody,
      locale: 'de-CH',
    });
    first.flush({
      status: 'answered',
      httpStatus: 503,
      contentType: 'application/json',
      excerpt: '{"error":"gate_not_configured"}',
      truncated: false,
    });
    await settle(harness);
    const outcome = el.querySelector('[data-recipe-outcome]');
    expect(outcome?.getAttribute('data-kind')).toBe('gate');
    expect(text(outcome)).toContain('noch kein Bundle');

    click(el, '[data-recipe-test-button]');
    await settle(harness);
    http().expectOne(`/api/projects/${PROJECT.id}/test-request`).flush({
      status: 'answered',
      httpStatus: 201,
      contentType: 'application/json',
      excerpt: '{"id":"501"}',
      truncated: false,
    });
    await settle(harness);
    expect(text(el.querySelector('[data-recipe-outcome]'))).toContain(
      'Es funktioniert',
    );
    expect(text(el.querySelector('[data-recipe-excerpt]'))).toBe(
      '{"id":"501"}',
    );
  });

  it('says why nothing was sent', async () => {
    window.moatDesktop = bridge();
    const { el, harness } = await openRecipe(PROJECT);
    click(el, '[data-recipe-test-button]');
    await settle(harness);
    http()
      .expectOne(`/api/projects/${PROJECT.id}/test-request`)
      .flush(
        { error: 'url_invalid' },
        { status: 422, statusText: 'Unprocessable' },
      );
    await settle(harness);
    expect(
      el.querySelector('[data-recipe-notice]')?.getAttribute('data-code'),
    ).toBe('url_invalid');
  });
});

describe('outcomeOf', () => {
  const answered = (httpStatus: number, excerpt: string) =>
    outcomeOf({
      status: 'answered',
      httpStatus,
      contentType: 'application/json',
      excerpt,
      truncated: false,
    });

  it("reads the gate's own error code", () => {
    expect(answered(500, '{"error":"secret_unavailable"}')).toEqual({
      kind: 'gate',
      status: 500,
      code: 'secret_unavailable',
    });
  });

  it("takes an upstream's error object, or an unknown code, as the API's answer", () => {
    expect(answered(401, '{"error":{"message":"bad key"}}')).toMatchObject({
      kind: 'upstream',
      ok: false,
    });
    expect(answered(400, '{"error":"something_else"}')).toMatchObject({
      kind: 'upstream',
    });
    expect(answered(200, 'not json')).toMatchObject({
      kind: 'upstream',
      ok: true,
    });
  });

  it('passes a failure on', () => {
    expect(outcomeOf({ status: 'failed', reason: 'tls' })).toEqual({
      kind: 'failed',
      reason: 'tls',
    });
  });
});
