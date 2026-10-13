import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import type { ProjectView } from '../../../../core/api/project.types';
import type {
  BundleSignResult,
  SecretSealResult,
} from '../../../../core/desktop/desktop-bridge';
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
    expect(text(el, '[data-secret-name="hubspot-token"]')).toBe(
      'hubspot-token Versiegelt, Version 2',
    );
    // Sealing happens in Moat Desktop only.
    expect(
      el.querySelector(
        '[data-secret] [data-row-actions], [data-secret] [data-action]',
      ),
    ).toBeNull();
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
      'Das letzte Bundle enthält die Sperre noch nicht. Signiere ein neues (in Moat Desktop mit «Bundle signieren», im CLI mit moat build site) und nimm es auf dem Gate an.',
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
    expect(
      text(el, '[data-secret-name="hubspot-token"] [data-secret-state]'),
    ).toBe('Noch nicht versiegelt');
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

  describe('signing in Moat Desktop (DT-15)', () => {
    afterEach(() => delete window.moatDesktop);

    /** The bundle was signed or refused: the page reads the project again. */
    const answerReload = async (harness: Parameters<typeof settle>[0]) => {
      await new Promise((resolve) => setTimeout(resolve));
      TestBed.inject(HttpTestingController)
        .expectOne(`/api/projects/${PROJECT.id}`)
        .flush(PROJECT);
      await settle(harness);
    };

    const desktop = (result: BundleSignResult) => {
      const sign = vi.fn().mockResolvedValue(result);
      window.moatDesktop = {
        platform: 'linux',
        project: { add: vi.fn(), create: vi.fn(), reveal: vi.fn() },
        key: { status: vi.fn(), choose: vi.fn(), create: vi.fn() },
        bundle: { sign },
        secret: { seal: vi.fn() },
      };
      return sign;
    };

    it('offers no signing in a browser', async () => {
      const { el } = await openProjectTab('gates', GatesPage, PROJECT);
      expect(el.querySelector('[data-bundle-sign]')).toBeNull();
    });

    it('asks the desktop shell by ids only, then says where the bundle is and reads the project again', async () => {
      const sign = desktop({ status: 'signed', version: 4 });
      const { el, harness } = await openProjectTab('gates', GatesPage, PROJECT);
      const button = el.querySelector(
        '[data-bundle-sign]',
      ) as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Bundle signieren');
      button.click();
      await answerReload(harness);
      expect(sign).toHaveBeenCalledWith(PROJECT.id, 'site', 'de-CH');
      expect(text(el, '[data-sign-outcome]')).toBe(
        'Version 4 ist signiert und liegt unter bundles/site/4.json. Lade die Datei auf den Server und nimm sie mit php moat-gate.php accept an.',
      );
    });

    it('says nothing on cancel and names what blocks the bundle', async () => {
      const sign = desktop({ status: 'cancelled' });
      const { el, harness } = await openProjectTab('gates', GatesPage, PROJECT);
      (el.querySelector('[data-bundle-sign]') as HTMLButtonElement).click();
      await settle(harness);
      expect(el.querySelector('[data-sign-outcome]')).toBeNull();

      sign.mockResolvedValue({
        status: 'refused',
        code: 'secrets_missing',
        secrets: ['hubspot-token'],
      });
      (el.querySelector('[data-bundle-sign]') as HTMLButtonElement).click();
      await answerReload(harness);
      expect(text(el, '[data-sign-outcome]')).toBe(
        'Diese Secrets sind für das Gate noch nicht versiegelt: hubspot-token',
      );
    });

    it('keeps the button off while a secret is missing', async () => {
      desktop({ status: 'failed' });
      const { el } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), missingSecrets: ['hubspot-token'] }),
      );
      expect(
        (el.querySelector('[data-bundle-sign]') as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });

  describe('sealing in Moat Desktop', () => {
    afterEach(() => delete window.moatDesktop);

    const desktop = (result: SecretSealResult) => {
      const seal = vi.fn().mockResolvedValue(result);
      window.moatDesktop = {
        platform: 'linux',
        project: { add: vi.fn(), create: vi.fn(), reveal: vi.fn() },
        key: { status: vi.fn(), choose: vi.fn(), create: vi.fn() },
        bundle: { sign: vi.fn() },
        secret: { seal },
      };
      return seal;
    };

    it('asks the shell by names only, then says the bundle still has to be signed', async () => {
      const seal = desktop({ status: 'sealed', secretVersion: 3 });
      const { el, harness } = await openProjectTab('gates', GatesPage, PROJECT);
      const button = el.querySelector(
        '[data-secret-name="hubspot-token"] [data-action="seal"]',
      ) as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Neu versiegeln');
      button.click();
      await new Promise((resolve) => setTimeout(resolve));
      TestBed.inject(HttpTestingController)
        .expectOne(`/api/projects/${PROJECT.id}`)
        .flush(PROJECT);
      await settle(harness);
      expect(seal).toHaveBeenCalledWith(
        PROJECT.id,
        'site',
        'hubspot-token',
        'de-CH',
      );
      expect(text(el, '[data-seal-outcome]')).toBe(
        'hubspot-token ist für site versiegelt (Version 3). Signiere ein neues Bundle, damit das Gate es erhält.',
      );
    });

    it('offers «Versiegeln» for a missing secret and says nothing on cancel', async () => {
      desktop({ status: 'cancelled' });
      const { el, harness } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), secrets: [], missingSecrets: ['hubspot-token'] }),
      );
      const button = el.querySelector(
        '[data-secret-name="hubspot-token"] [data-action="seal"]',
      ) as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Versiegeln');
      button.click();
      await settle(harness);
      expect(el.querySelector('[data-seal-outcome]')).toBeNull();
    });
  });
});
