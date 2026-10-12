import { openProjectTab, PROJECT } from '../../../../../testing/page-harness';
import { OverviewPage } from './overview-page';

const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('OverviewPage', () => {
  it('shows the folder, the valid config with its counts and the trust mode with the §2.9 sentence', async () => {
    const { el } = await openProjectTab('overview', OverviewPage, PROJECT);
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

  it('FR-01: lists the environments with their gates and locks', async () => {
    const project = PROJECT.project;
    const config = project?.config;
    if (project == null || config?.status !== 'valid')
      throw new Error('fixture');
    const [site] = project.gates;
    if (site?.status !== 'valid') throw new Error('fixture');
    const { el } = await openProjectTab('overview', OverviewPage, {
      ...PROJECT,
      project: {
        config: {
          ...config,
          environments: [
            { name: 'production', enabled: true, gates: ['site'] },
            { name: 'staging', enabled: false, gates: [] },
          ],
        },
        gates: [
          {
            ...site,
            lock: {
              environment: 'production',
              gateLocked: true,
              environmentLocked: false,
              enabled: false,
            },
          },
          {
            ...site,
            name: 'loose',
            lock: {
              environment: null,
              gateLocked: false,
              environmentLocked: false,
              enabled: true,
            },
          },
        ],
      },
    });
    const production = el.querySelector(
      '[data-environment-name="production"]',
    ) as HTMLElement;
    const staging = el.querySelector(
      '[data-environment-name="staging"]',
    ) as HTMLElement;
    // Production is active, but its gate "site" is locked on its own.
    expect(production.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'production site Gesperrt',
    );
    expect(staging.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'staging Gesperrt Noch kein Gate',
    );
    expect(text(el, '[data-unassigned]')).toBe('Ohne Umgebung: loose');
  });

  it('explains how to create environments when there are none', async () => {
    const project = PROJECT.project;
    const config = project?.config;
    if (project == null || config?.status !== 'valid')
      throw new Error('fixture');
    const { el } = await openProjectTab('overview', OverviewPage, {
      ...PROJECT,
      project: { ...project, config: { ...config, environments: [] } },
    });
    expect(text(el, '[data-no-environments]')).toContain(
      'moat env add staging',
    );
  });

  it('lists config errors with line and column', async () => {
    const { el } = await openProjectTab('overview', OverviewPage, {
      ...PROJECT,
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
});
