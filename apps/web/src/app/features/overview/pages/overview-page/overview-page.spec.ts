import { openPage, PROJECT } from '../../../../../testing/page-harness';
import { OverviewPage } from './overview-page';

const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('OverviewPage', () => {
  afterEach(() => delete window.moatDesktop);

  it('shows the folder, the valid config with its counts and the trust mode with the §2.9 sentence', async () => {
    const { el } = await openPage('/app/overview', OverviewPage, PROJECT);
    expect(text(el, '[data-folder]')).toBe('/home/eme/sites/example');
    expect(el.querySelector('[data-config-status="valid"]')).not.toBeNull();
    expect(text(el, '[data-count-routes]')).toBe('1');
    expect(text(el, '[data-count-gates]')).toBe('1');
    expect(text(el, '[data-trust-mode]')).toBe('Signiert');
    expect(text(el, '[data-trust-if-hacked]')).toBe(
      'Wenn Moat Cloud gehackt wird … kann ein Angreifer nichts ändern. Im Browser gilt das nur eingeschränkt, volle Garantie mit Moat Desktop oder CLI.',
    );
    // FR-72: a "?" next to the trust mode and in the header.
    expect(
      el.querySelectorAll('[data-help-link]').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('lists config errors with line and column', async () => {
    const { el } = await openPage('/app/overview', OverviewPage, {
      folder: '/p',
      project: {
        config: {
          status: 'invalid',
          issues: [
            {
              code: 'syntax',
              path: [],
              message: 'Map keys must be unique',
              line: 2,
              column: 1,
            },
          ],
        },
        gates: [],
      },
    });
    expect(el.querySelector('[data-config-status="invalid"]')).not.toBeNull();
    expect(text(el, '[data-config-issues]')).toContain(
      'Fehler in der YAML-Schreibweise (Zeile 2, Spalte 1)',
    );
  });

  it('offers to open a folder when none is open — in the desktop app only', async () => {
    const { el } = await openPage('/app/overview', OverviewPage, {
      folder: null,
      project: null,
    });
    expect(el.querySelector('[data-no-project]')).not.toBeNull();
    expect(el.querySelector('[data-choose-folder]')).toBeNull();
  });

  it('asks the desktop shell for the folder dialog and says so when it fails', async () => {
    const choose = vi.fn().mockResolvedValue({ status: 'failed' });
    window.moatDesktop = {
      platform: 'linux',
      project: { choose, reveal: vi.fn() },
    };
    const { el, harness } = await openPage('/app/overview', OverviewPage, {
      folder: null,
      project: null,
    });
    (el.querySelector('[data-choose-folder]') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(choose).toHaveBeenCalledOnce();
    expect(el.querySelector('[data-choose-failed]')).not.toBeNull();
  });

  it('says so when the API cannot be reached', async () => {
    const { el } = await openPage('/app/overview', OverviewPage, 'error');
    expect(el.querySelector('[data-load-error]')).not.toBeNull();
  });
});
