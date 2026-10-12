import type { ProjectView } from '../../../../core/api/project.types';
import {
  expectEdit,
  openProjectTab,
  PROJECT,
  settle,
} from '../../../../../testing/page-harness';
import { GatesPage } from './gates-page';

const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('GatesPage', () => {
  it('shows each gate with its fingerprint, trust mode, sealed secrets and last bundle', async () => {
    const { el } = await openProjectTab('gates', GatesPage, PROJECT);
    expect(el.querySelectorAll('[data-gate]')).toHaveLength(1);
    expect(text(el, '[data-fingerprint]')).toBe('MOAT-ABCD-EFGH-IJKL');
    expect(text(el, '[data-trust-mode]')).toBe('Signiert');
    expect(text(el, '[data-secrets]')).toBe('hubspot-token (v2)');
    expect(text(el, '[data-bundle]')).toBe('Version 3');
    expect(el.querySelector('[data-missing]')).toBeNull();
    expect(text(el, '[data-environment]')).toBe('production');
    expect(el.querySelector('[data-locked]')).toBeNull();
    expect(el.querySelector('[data-lock-pending]')).toBeNull();
  });

  const site = () => {
    const gate = PROJECT.project?.gates[0];
    if (gate?.status !== 'valid' || PROJECT.project === null)
      throw new Error('fixture');
    return gate;
  };
  const withGate = (gate: ReturnType<typeof site>): ProjectView => ({
    ...PROJECT,
    project: {
      config: PROJECT.project?.config ?? { status: 'missing' },
      gates: [gate],
    },
  });

  it('marks a gate its environment locks and says the last bundle does not carry the lock yet', async () => {
    const { el } = await openProjectTab(
      'gates',
      GatesPage,
      withGate({
        ...site(),
        lock: {
          environment: 'production',
          gateLocked: false,
          environmentLocked: true,
          enabled: false,
        },
        latestBundleLocked: false,
      }),
    );
    expect(text(el, '[data-locked]')).toBe('Gesperrt');
    expect(text(el, '[data-lock-reason]')).toContain(
      'Die Umgebung production ist gesperrt',
    );
    expect(text(el, '[data-lock-pending]')).toBe(
      'Das letzte Bundle enthält die Sperre noch nicht. Baue mit moat build site ein neues und nimm es auf dem Gate an.',
    );
  });

  it('shows a lock that the last bundle already carries', async () => {
    const locked = await openProjectTab(
      'gates',
      GatesPage,
      withGate({
        ...site(),
        lock: {
          environment: null,
          gateLocked: true,
          environmentLocked: false,
          enabled: false,
        },
        latestBundleLocked: true,
      }),
    );
    expect(text(locked.el, '[data-lock-reason]')).toContain(
      'Dieses Gate ist gesperrt.',
    );
    expect(text(locked.el, '[data-bundle]')).toBe(
      'Version 3, mit Sperre gebaut',
    );
    const select = locked.el.querySelector(
      '[data-environment-select]',
    ) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe(
      'Ohne Umgebung',
    );
    expect(locked.el.querySelector('[data-gate-unlock]')).not.toBeNull();
    expect(locked.el.querySelector('[data-lock-pending]')).toBeNull();
  });

  it('says an unlock applies only with the next bundle', async () => {
    const unlocked = await openProjectTab(
      'gates',
      GatesPage,
      withGate({ ...site(), latestBundleLocked: true }),
    );
    expect(unlocked.el.querySelector('[data-locked]')).toBeNull();
    expect(text(unlocked.el, '[data-lock-pending]')).toContain(
      'Das letzte Bundle sperrt das Gate noch.',
    );
  });

  it('names the secrets still to seal and marks a damaged gate file', async () => {
    const project = PROJECT.project;
    if (project === null) throw new Error('fixture');
    const view: ProjectView = {
      ...PROJECT,
      project: {
        ...project,
        gates: [
          {
            ...(project.gates[0] as Extract<
              (typeof project.gates)[number],
              { status: 'valid' }
            >),
            secrets: [],
            missingSecrets: ['hubspot-token'],
            latestBundle: 0,
          },
          { name: 'old', status: 'invalid' },
        ],
      },
    };
    const { el } = await openProjectTab('gates', GatesPage, view);
    expect(text(el, '[data-missing]')).toContain('hubspot-token');
    expect(text(el, '[data-bundle]')).toBe('Noch keins gebaut');
    expect(text(el, '[data-gate-invalid]')).toContain('gates/old.json');
  });

  it('says so when the project has no gate yet', async () => {
    const { el } = await openProjectTab('gates', GatesPage, {
      ...PROJECT,
      project: { config: { status: 'missing' }, gates: [] },
    });
    expect(el.querySelector('[data-no-gates]')).not.toBeNull();
  });

  const twoEnvironments = (): ProjectView => {
    const config = PROJECT.project?.config;
    if (PROJECT.project == null || config?.status !== 'valid')
      throw new Error('fixture');
    return {
      ...PROJECT,
      project: {
        ...PROJECT.project,
        config: {
          ...config,
          environments: [
            { name: 'production', enabled: true, gates: ['site'] },
            { name: 'staging', enabled: true, gates: [] },
          ],
        },
      },
    };
  };

  it('moves a gate to the environment chosen in its list', async () => {
    const { el, harness } = await openProjectTab(
      'gates',
      GatesPage,
      twoEnvironments(),
    );
    const select = el.querySelector(
      '[data-environment-select]',
    ) as HTMLSelectElement;
    expect(select.value).toBe('production');
    select.value = 'staging';
    select.dispatchEvent(new Event('change'));
    const edit = expectEdit();
    expect(edit.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'assignGate',
      gate: 'site',
      environment: 'staging',
    });
    edit.flush(
      { error: 'not_writable' },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle(harness);
    // Refused: the list shows what moat.yaml says again, and why.
    expect(select.value).toBe('production');
    expect(text(el, '[data-edit-outcome="error"]')).toContain(
      'moat.yaml lässt sich nicht schreiben',
    );
  });

  it('locks a single gate', async () => {
    const { el, harness } = await openProjectTab('gates', GatesPage, PROJECT);
    (el.querySelector('[data-gate-lock]') as HTMLButtonElement).click();
    const edit = expectEdit();
    expect(edit.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'lockGate',
      gate: 'site',
    });
    edit.flush(
      withGate({
        ...site(),
        lock: {
          environment: 'production',
          gateLocked: true,
          environmentLocked: false,
          enabled: false,
        },
      }),
    );
    await settle(harness);
    expect(text(el, '[data-lock-pending]')).toContain(
      'Das letzte Bundle enthält die Sperre noch nicht.',
    );
    expect(el.querySelector('[data-gate-unlock]')).not.toBeNull();
  });
});
