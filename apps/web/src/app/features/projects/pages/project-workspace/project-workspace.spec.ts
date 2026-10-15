import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import {
  fail,
  openPage,
  openProjectTab,
  PROJECT,
  projectRoutes,
} from '../../../../../testing/page-harness';
import { OverviewPage } from '../../../overview/pages/overview-page/overview-page';

const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const click = (el: HTMLElement, selector: string) =>
  (el.querySelector(selector) as HTMLElement).click();

describe('ProjectWorkspace', () => {
  afterEach(() => delete window.moatDesktop);

  it('names the project and its folder and offers the five tabs', async () => {
    const { el } = await openProjectTab('overview', OverviewPage, PROJECT);
    expect(text(el, 'h1')).toBe('example');
    expect(
      [...el.querySelectorAll('[data-tab]')].map((tab) =>
        tab.textContent?.trim(),
      ),
    ).toEqual(['Übersicht', 'Gates', 'Routen', 'Test-Konsole', 'Verlauf']);
    expect(
      el.querySelector('[data-tab="overview"]')?.getAttribute('aria-current'),
    ).toBe('page');
    // "Im Ordner zeigen" exists only in the desktop app.
    expect(el.querySelector('[data-reveal]')).toBeNull();
  });

  it('asks the desktop shell to show the folder, by id only', async () => {
    const reveal = vi.fn().mockResolvedValue(undefined);
    window.moatDesktop = {
      platform: 'linux',
      project: { add: vi.fn(), create: vi.fn(), reveal },
      key: {
        status: vi.fn(),
        choose: vi.fn(),
        create: vi.fn(),
        rotationDone: vi.fn(),
      },
      bundle: { sign: vi.fn() },
      secret: { seal: vi.fn() },
      gate: { deploy: vi.fn(), import: vi.fn(), log: vi.fn() },
    };
    const { el } = await openProjectTab('overview', OverviewPage, PROJECT);
    click(el, '[data-reveal]');
    expect(reveal).toHaveBeenCalledWith(PROJECT.id);
  });

  it('says so when the folder is gone, and offers to remove the entry', async () => {
    const { el } = await openProjectTab('overview', OverviewPage, {
      ...PROJECT,
      project: null,
    });
    expect(el.querySelector('[data-folder-gone]')).not.toBeNull();
    expect(el.querySelector('[data-tab]')).toBeNull();
    expect(el.querySelector('[data-remove]')).not.toBeNull();
  });

  it('answers an unknown project and an unreachable API', async () => {
    const unknown = await openProjectTab('overview', OverviewPage, fail(404));
    expect(unknown.el.querySelector('[data-not-found]')).not.toBeNull();
    TestBed.resetTestingModule();
    const broken = await openProjectTab('overview', OverviewPage, fail(500));
    expect(broken.el.querySelector('[data-load-error]')).not.toBeNull();
  });

  it('removes the project from the list only after a second click, then shows the list', async () => {
    const { el, harness } = await openPage(
      `/app/projects/${PROJECT.id}/overview`,
      projectRoutes(OverviewPage),
      { [`/api/projects/${PROJECT.id}`]: PROJECT },
    );
    const http = TestBed.inject(HttpTestingController);
    click(el, '[data-remove]');
    harness.detectChanges();
    http.expectNone(`/api/projects/${PROJECT.id}`);
    expect(el.querySelector('[data-remove-confirm]')).not.toBeNull();
    click(el, '[data-remove-yes]');
    const request = http.expectOne(`/api/projects/${PROJECT.id}`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/app/projects');
  });
});
