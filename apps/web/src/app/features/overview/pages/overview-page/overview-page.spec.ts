import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import type { ProjectView } from '../../../../core/api/project.types';
import {
  expectEdit,
  openProjectTab,
  PROJECT,
  settle,
} from '../../../../../testing/page-harness';
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
      'production site Gesperrt Sperren',
    );
    expect(staging.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'staging Gesperrt Noch kein Gate Entsperren',
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
    expect(text(el, '[data-no-environments]')).toContain('Lege unten eine an');
    expect(el.querySelector('[data-add-environment]')).not.toBeNull();
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

  const withEnvironments = (
    environments: { name: string; enabled: boolean; gates: string[] }[],
    configHash = 'b'.repeat(64),
  ): ProjectView => {
    const project = PROJECT.project;
    const config = project?.config;
    if (project == null || config?.status !== 'valid')
      throw new Error('fixture');
    return {
      ...PROJECT,
      configHash,
      project: { ...project, config: { ...config, environments } },
    };
  };

  it('locks an environment in moat.yaml and says it applies with the next bundle', async () => {
    const { el, harness } = await openProjectTab(
      'overview',
      OverviewPage,
      PROJECT,
    );
    (el.querySelector('[data-environment-lock]') as HTMLButtonElement).click();
    const edit = expectEdit();
    expect(edit.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'lockEnvironment',
      environment: 'production',
    });
    edit.flush(
      withEnvironments([
        { name: 'production', enabled: false, gates: ['site'] },
      ]),
    );
    await settle(harness);
    expect(text(el, '[data-edit-outcome="saved"]')).toContain(
      'In moat.yaml gespeichert. Auf dem Gate gilt die Änderung erst mit dem nächsten Bundle',
    );
    expect(el.querySelector('[data-environment-unlock]')).not.toBeNull();
  });

  it('adds an environment, but only with a name moat.yaml takes', async () => {
    const { el, harness } = await openProjectTab(
      'overview',
      OverviewPage,
      PROJECT,
    );
    const input = el.querySelector('#new-environment') as HTMLInputElement;
    const form = el.querySelector('[data-add-environment]') as HTMLFormElement;
    input.value = 'Prod Server';
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit'));
    await settle(harness);
    TestBed.inject(HttpTestingController).expectNone(
      `/api/projects/${PROJECT.id}/config/edits`,
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');

    input.value = ' staging ';
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit'));
    const edit = expectEdit();
    expect(edit.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'addEnvironment',
      environment: 'staging',
    });
    edit.flush(
      withEnvironments([
        { name: 'production', enabled: true, gates: ['site'] },
        { name: 'staging', enabled: true, gates: [] },
      ]),
    );
    await settle(harness);
    expect(
      el.querySelector('[data-environment-name="staging"]'),
    ).not.toBeNull();
    expect(input.value).toBe('');
  });

  it('writes nothing over a moat.yaml changed on disk, says so and reads it again', async () => {
    const { el, harness } = await openProjectTab(
      'overview',
      OverviewPage,
      PROJECT,
    );
    (el.querySelector('[data-environment-lock]') as HTMLButtonElement).click();
    expectEdit().flush(
      { error: 'config_changed' },
      { status: 409, statusText: 'Conflict' },
    );
    // Not settle(): the project is read again, and that request is open until answered.
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.inject(HttpTestingController)
      .expectOne(`/api/projects/${PROJECT.id}`)
      .flush(
        withEnvironments([
          { name: 'production', enabled: true, gates: ['site'] },
        ]),
      );
    await settle(harness);
    expect(text(el, '[data-edit-outcome="error"]')).toContain(
      'moat.yaml wurde inzwischen ausserhalb von Moat geändert',
    );
  });
});
