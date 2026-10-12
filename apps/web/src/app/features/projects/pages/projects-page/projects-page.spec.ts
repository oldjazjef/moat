import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { ProjectSummary } from '../../../../core/api/project.types';
import { fail, openPage } from '../../../../../testing/page-harness';
import { ProjectsPage } from './projects-page';

const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const ROUTES = [
  { path: 'app/projects', component: ProjectsPage },
  { path: 'app/projects/:id', children: [] },
];

const SHOP: ProjectSummary = {
  id: 'shopProject00000000000',
  name: 'shop',
  folder: '/home/eme/sites/shop',
  config: 'valid',
  routes: 2,
  gates: 2,
  gatesMissingSecrets: ['staging'],
  gatesLocked: ['staging'],
};
const GONE: ProjectSummary = {
  id: 'goneProject00000000000',
  name: 'old',
  folder: '/media/usb/old',
  config: null,
  routes: 0,
  gates: 0,
  gatesMissingSecrets: [],
  gatesLocked: [],
};

const open = (list: unknown) =>
  openPage('/app/projects', ROUTES, { '/api/projects': list });

describe('ProjectsPage', () => {
  afterEach(() => delete window.moatDesktop);

  it('shows a card per project with its state and the trust mode', async () => {
    const { el } = await open([SHOP, GONE]);
    const cards = el.querySelectorAll('[data-project]');
    expect(cards.length).toBe(2);
    expect(text(cards[0] as HTMLElement, '[data-project-link]')).toBe('shop');
    expect(
      (cards[0] as HTMLElement).querySelector('[data-project-status="valid"]'),
    ).not.toBeNull();
    expect(text(cards[0] as HTMLElement, '[data-missing-secrets]')).toContain(
      'staging',
    );
    expect(text(cards[0] as HTMLElement, '[data-gates-locked]')).toBe(
      'Gesperrte Gates: staging',
    );
    expect(
      (cards[1] as HTMLElement).querySelector('[data-gates-locked]'),
    ).toBeNull();
    expect(text(cards[0] as HTMLElement, '[data-trust-mode]')).toBe('Signiert');
    expect(
      (cards[1] as HTMLElement).querySelector('[data-project-status="gone"]'),
    ).not.toBeNull();
    expect(
      (cards[0] as HTMLElement)
        .querySelector('[data-project-link]')
        ?.getAttribute('href'),
    ).toBe(`/app/projects/${SHOP.id}`);
  });

  it('explains how to start when there is no project, without the add button in a browser', async () => {
    const { el } = await open([]);
    expect(el.querySelector('[data-no-project]')).not.toBeNull();
    expect(el.querySelector('[data-add-project]')).toBeNull();
    expect(text(el, '[data-no-project] code')).toBe('moat gate add');
  });

  it('adds a project through the desktop dialog and opens it', async () => {
    const add = vi.fn().mockResolvedValue({ status: 'added', id: SHOP.id });
    window.moatDesktop = {
      platform: 'linux',
      project: { add, reveal: vi.fn() },
      bundle: { sign: vi.fn() },
    };
    const { el, harness } = await open([]);
    (el.querySelector('[data-add-project]') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    expect(add).toHaveBeenCalledOnce();
    expect(TestBed.inject(Router).url).toBe(`/app/projects/${SHOP.id}`);
  });

  it('says so when the folder cannot be added, or the list cannot be read', async () => {
    const add = vi.fn().mockResolvedValue({ status: 'failed' });
    window.moatDesktop = {
      platform: 'linux',
      project: { add, reveal: vi.fn() },
      bundle: { sign: vi.fn() },
    };
    const { el, harness } = await open([]);
    (el.querySelector('[data-add-project]') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(el.querySelector('[data-add-failed]')).not.toBeNull();
    TestBed.resetTestingModule();
    const broken = await open(fail(500));
    expect(broken.el.querySelector('[data-load-error]')).not.toBeNull();
  });
});
