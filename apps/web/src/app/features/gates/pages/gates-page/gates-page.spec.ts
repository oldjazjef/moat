import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import type { ProjectView } from '../../../../core/api/project.types';
import type {
  BundleSignResult,
  DeployResult,
  ImportResult,
  RequestLogResult,
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
        key: {
          status: vi.fn(),
          choose: vi.fn(),
          create: vi.fn(),
          rotationDone: vi.fn(),
        },
        bundle: { sign },
        secret: { seal: vi.fn() },
        gate: { deploy: vi.fn(), import: vi.fn(), log: vi.fn() },
      };
      return sign;
    };

    it('offers no signing in a browser', async () => {
      const { el } = await openProjectTab('gates', GatesPage, PROJECT);
      expect(el.querySelector('[data-bundle-sign]')).toBeNull();
    });

    it('offers the check from outside per gate only in the desktop (DT-07)', async () => {
      const browser = await openProjectTab('gates', GatesPage, PROJECT);
      expect(browser.el.querySelector('[data-gate-hardening]')).toBeNull();
      TestBed.resetTestingModule();
      desktop({ status: 'cancelled' });
      const { el } = await openProjectTab('gates', GatesPage, PROJECT);
      expect(
        el.querySelectorAll(
          '[data-gate] [data-gate-hardening] mt-hardening-check',
        ).length,
      ).toBe(el.querySelectorAll('[data-gate]').length);
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
        key: {
          status: vi.fn(),
          choose: vi.fn(),
          create: vi.fn(),
          rotationDone: vi.fn(),
        },
        bundle: { sign: vi.fn() },
        secret: { seal },
        gate: { deploy: vi.fn(), import: vi.fn(), log: vi.fn() },
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

  describe('deploy package in Moat Desktop (DT-05)', () => {
    afterEach(() => delete window.moatDesktop);

    const desktop = (result: DeployResult) => {
      const deploy = vi.fn().mockResolvedValue(result);
      window.moatDesktop = {
        platform: 'linux',
        project: { add: vi.fn(), create: vi.fn(), reveal: vi.fn() },
        key: {
          status: vi.fn(),
          choose: vi.fn(),
          create: vi.fn(),
          rotationDone: vi.fn(),
        },
        bundle: { sign: vi.fn() },
        secret: { seal: vi.fn() },
        gate: { deploy, import: vi.fn(), log: vi.fn() },
      };
      return deploy;
    };

    it('offers no package in a browser', async () => {
      const { el } = await openProjectTab('gates', GatesPage, PROJECT);
      expect(el.querySelector('[data-gate-deploy]')).toBeNull();
    });

    it('asks the shell by ids and target only, and says where the package is', async () => {
      const deploy = desktop({
        status: 'exported',
        target: 'folder',
        version: 4,
      });
      const { el, harness } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), latestBundle: 4 }),
      );
      const button = el.querySelector(
        '[data-deploy-folder]',
      ) as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('In Ordner ablegen');
      button.click();
      await settle(harness);
      expect(deploy).toHaveBeenCalledWith(
        PROJECT.id,
        'site',
        'folder',
        'de-CH',
      );
      expect(text(el, '[data-deploy-outcome]')).toBe(
        'Das Paket mit Version 4 liegt im neuen Ordner moat-site-v4. Die Anleitung darin heisst LIESMICH.txt.',
      );
    });

    it('says nothing on cancel and why a package was refused', async () => {
      const deploy = desktop({ status: 'cancelled' });
      const { el, harness } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), latestBundle: 2 }),
      );
      (el.querySelector('[data-deploy-zip]') as HTMLButtonElement).click();
      await settle(harness);
      expect(deploy).toHaveBeenCalledWith(PROJECT.id, 'site', 'zip', 'de-CH');
      expect(el.querySelector('[data-deploy-outcome]')).toBeNull();
      deploy.mockResolvedValue({
        status: 'refused',
        code: 'bundle_unverified',
      });
      (el.querySelector('[data-deploy-zip]') as HTMLButtonElement).click();
      await settle(harness);
      expect(text(el, '[data-deploy-outcome]')).toContain(
        'nicht mit deiner Schlüsseldatei',
      );
    });

    it('SFTP: asks the shell by ids and target only and says where the package is on the server', async () => {
      const deploy = desktop({
        status: 'exported',
        target: 'sftp',
        version: 5,
      });
      const { el, harness } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), latestBundle: 5 }),
      );
      const button = el.querySelector(
        '[data-deploy-sftp]',
      ) as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Per SFTP hochladen');
      button.click();
      await settle(harness);
      expect(deploy).toHaveBeenCalledWith(PROJECT.id, 'site', 'sftp', 'de-CH');
      expect(text(el, '[data-deploy-outcome]')).toBe(
        'Das Paket mit Version 5 liegt auf dem Server im neuen Ordner moat-site-v5. Aktiviere es dort wie in LIESMICH.txt beschrieben.',
      );
    });

    it('FTPS: asks the shell by ids and target only and says where the package is on the server', async () => {
      const deploy = desktop({
        status: 'exported',
        target: 'ftps',
        version: 5,
      });
      const { el, harness } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), latestBundle: 5 }),
      );
      const button = el.querySelector(
        '[data-deploy-ftps]',
      ) as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Per FTPS hochladen');
      button.click();
      await settle(harness);
      expect(deploy).toHaveBeenCalledWith(PROJECT.id, 'site', 'ftps', 'de-CH');
      expect(text(el, '[data-deploy-outcome]')).toBe(
        'Das Paket mit Version 5 liegt auf dem Server im neuen Ordner moat-site-v5, verschlüsselt per FTPS hochgeladen. Aktiviere es dort wie in LIESMICH.txt beschrieben.',
      );
    });

    it('Git: says pushed, committed only, or why the folder does not fit', async () => {
      const deploy = desktop({ status: 'exported', target: 'git', version: 5 });
      const { el, harness } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), latestBundle: 5 }),
      );
      const button = el.querySelector('[data-deploy-git]') as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Per Git ausliefern');
      button.click();
      await settle(harness);
      expect(deploy).toHaveBeenCalledWith(PROJECT.id, 'site', 'git', 'de-CH');
      expect(text(el, '[data-deploy-outcome]')).toContain(
        'als neuer Ordner moat-site-v5 committet und gepusht',
      );
      deploy.mockResolvedValue({ status: 'committed', version: 5 });
      button.click();
      await settle(harness);
      expect(text(el, '[data-deploy-outcome]')).toContain(
        'Version 5 ist committet, aber der Push hat nicht geklappt',
      );
      deploy.mockResolvedValue({ status: 'refused', code: 'git_no_upstream' });
      button.click();
      await settle(harness);
      expect(text(el, '[data-deploy-outcome]')).toContain('keinen Upstream');
    });

    it('keeps both buttons off until a bundle is signed', async () => {
      desktop({ status: 'failed' });
      const { el } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), latestBundle: 0 }),
      );
      expect(
        (el.querySelector('[data-deploy-zip]') as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (el.querySelector('[data-deploy-folder]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (el.querySelector('[data-deploy-git]') as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(text(el, '[data-gate-deploy] p')).toContain('Signiere zuerst');
    });
  });

  describe('bundle import in Moat Desktop (FR-45, DT-17)', () => {
    afterEach(() => delete window.moatDesktop);

    const desktop = (result: ImportResult) => {
      const importBundle = vi.fn().mockResolvedValue(result);
      window.moatDesktop = {
        platform: 'linux',
        project: { add: vi.fn(), create: vi.fn(), reveal: vi.fn() },
        key: {
          status: vi.fn(),
          choose: vi.fn(),
          create: vi.fn(),
          rotationDone: vi.fn(),
        },
        bundle: { sign: vi.fn() },
        secret: { seal: vi.fn() },
        gate: { deploy: vi.fn(), import: importBundle, log: vi.fn() },
      };
      return importBundle;
    };

    it('offers no import in a browser', async () => {
      const { el } = await openProjectTab('gates', GatesPage, PROJECT);
      expect(el.querySelector('[data-gate-import]')).toBeNull();
    });

    it('asks the shell by ids only, says which version arrived and reads the project again', async () => {
      const importBundle = desktop({ status: 'imported', version: 7 });
      const { el, harness } = await openProjectTab('gates', GatesPage, PROJECT);
      const button = el.querySelector(
        '[data-import-file]',
      ) as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Bundle importieren');
      button.click();
      // The project is read again: the new latest bundle shows.
      await new Promise((resolve) => setTimeout(resolve));
      TestBed.inject(HttpTestingController)
        .expectOne(`/api/projects/${PROJECT.id}`)
        .flush(PROJECT);
      await settle(harness);
      expect(importBundle).toHaveBeenCalledWith(
        PROJECT.id,
        'site',
        'file',
        'de-CH',
      );
      expect(text(el, '[data-import-outcome]')).toBe(
        'Version 7 ist importiert. Sie ist jetzt das letzte Bundle dieses Gates.',
      );
    });

    it('says nothing on cancel and why an import was refused', async () => {
      const importBundle = desktop({ status: 'cancelled' });
      const { el, harness } = await openProjectTab('gates', GatesPage, PROJECT);
      const button = el.querySelector(
        '[data-import-folder]',
      ) as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Paketordner importieren');
      button.click();
      await settle(harness);
      expect(importBundle).toHaveBeenCalledWith(
        PROJECT.id,
        'site',
        'folder',
        'de-CH',
      );
      expect(el.querySelector('[data-import-outcome]')).toBeNull();
      const refusals: [ImportResult, string][] = [
        [
          { status: 'refused', code: 'signature_invalid' },
          'nicht mit deiner Schlüsseldatei signiert',
        ],
        [{ status: 'refused', code: 'gate_mismatch' }, 'für ein anderes Gate'],
        [
          { status: 'refused', code: 'version_not_newer' },
          'nicht neuer als das letzte Bundle',
        ],
        [{ status: 'refused', code: 'package_invalid' }, 'kein Deploy-Paket'],
        [{ status: 'not_writable' }, 'bundles/site'],
      ];
      for (const [result, expected] of refusals) {
        importBundle.mockResolvedValue(result);
        button.click();
        await settle(harness);
        expect(text(el, '[data-import-outcome]')).toContain(expected);
      }
    });
  });

  describe('request log in Moat Desktop (FR-50, DT-12)', () => {
    afterEach(() => delete window.moatDesktop);

    const desktop = (result: RequestLogResult) => {
      const log = vi.fn().mockResolvedValue(result);
      window.moatDesktop = {
        platform: 'linux',
        project: { add: vi.fn(), create: vi.fn(), reveal: vi.fn() },
        key: {
          status: vi.fn(),
          choose: vi.fn(),
          create: vi.fn(),
          rotationDone: vi.fn(),
        },
        bundle: { sign: vi.fn() },
        secret: { seal: vi.fn() },
        gate: { deploy: vi.fn(), import: vi.fn(), log },
      };
      return log;
    };
    const entry = {
      t: 1_792_000_000,
      route: 'newsletter',
      method: 'POST',
      status: 429,
      error: 'rate_limited',
      ms: 3,
      client: '0123456789abcdef',
    };

    it('offers no log in a browser', async () => {
      const { el } = await openProjectTab('gates', GatesPage, PROJECT);
      expect(el.querySelector('[data-gate-log]')).toBeNull();
    });

    it('asks the shell by ids only and shows requests, errors and latency per route', async () => {
      const log = desktop({
        status: 'read',
        log: {
          requests: 12,
          errors: 2,
          clients: 3,
          from: 1_792_000_000,
          to: 1_792_000_600,
          codes: [{ code: 'rate_limited', count: 2 }],
          routes: [
            {
              route: 'newsletter',
              requests: 11,
              errors: 1,
              p50Ms: 180,
              p95Ms: 420,
            },
            { route: null, requests: 1, errors: 1, p50Ms: 0, p95Ms: 0 },
          ],
          recent: [entry],
          skipped: 1,
        },
      });
      const { el, harness } = await openProjectTab('gates', GatesPage, PROJECT);
      const button = el.querySelector('[data-log-read]') as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('Log ansehen');
      button.click();
      await settle(harness);
      expect(log).toHaveBeenCalledWith(PROJECT.id, 'site', 'de-CH');
      expect(text(el, '[data-log-summary]')).toContain('12 Anfragen von');
      expect(text(el, '[data-log-summary]')).toContain(
        '1 Zeilen waren keine Log-Einträge.',
      );
      const rows = [...el.querySelectorAll('[data-log-routes] tbody tr')].map(
        (row) =>
          [...row.querySelectorAll('td')]
            .map((cell) => cell.textContent?.trim())
            .join(' | '),
      );
      expect(rows).toEqual([
        'newsletter | 11 | 1 | 180 ms | 420 ms',
        '(keine Route) | 1 | 1 | 0 ms | 0 ms',
      ]);
      expect(text(el, '[data-log-codes]')).toContain('rate_limited (2)');
      expect(text(el, '[data-log-recent]')).toContain('0123456789abcdef');
    });

    it('says nothing on cancel and why the files are no log', async () => {
      const log = desktop({ status: 'cancelled' });
      const { el, harness } = await openProjectTab('gates', GatesPage, PROJECT);
      const button = el.querySelector('[data-log-read]') as HTMLButtonElement;
      button.click();
      await settle(harness);
      expect(el.querySelector('[data-log-outcome]')).toBeNull();
      const refusals: [RequestLogResult, string][] = [
        [{ status: 'refused', code: 'no_entries' }, 'keine Zeile'],
        [{ status: 'refused', code: 'too_large' }, 'grösser als ein Log'],
        [{ status: 'refused', code: 'unreadable' }, 'liessen sich nicht lesen'],
        [{ status: 'failed' }, 'nicht anzeigen'],
      ];
      for (const [result, expected] of refusals) {
        log.mockResolvedValue(result);
        button.click();
        await settle(harness);
        expect(text(el, '[data-log-outcome]')).toContain(expected);
      }
    });
  });
  describe('key rotation in Moat Desktop (SEC-08)', () => {
    afterEach(() => delete window.moatDesktop);

    const OLD = {
      kid: 'o'.repeat(22),
      publicKey: 'O'.repeat(43),
      fingerprint: 'MOAT-OLD',
    };
    const NEW = {
      kid: 'n'.repeat(22),
      publicKey: 'N'.repeat(43),
      fingerprint: 'MOAT-NEW',
    };
    const desktop = (previous: typeof OLD | null) => {
      const rotationDone = vi.fn().mockResolvedValue(true);
      const status = vi
        .fn()
        .mockResolvedValue({ status: 'ready', key: NEW, previous });
      window.moatDesktop = {
        platform: 'linux',
        project: { add: vi.fn(), create: vi.fn(), reveal: vi.fn() },
        key: { status, choose: vi.fn(), create: vi.fn(), rotationDone },
        bundle: { sign: vi.fn() },
        secret: { seal: vi.fn() },
        gate: { deploy: vi.fn(), import: vi.fn(), log: vi.fn() },
      };
      return rotationDone;
    };

    it('shows nothing without an open rotation, nor in a browser', async () => {
      desktop(null);
      const { el } = await openProjectTab('gates', GatesPage, PROJECT);
      expect(el.querySelector('[data-key-rotation]')).toBeNull();
    });

    it('gives both commands and lets the person finish only when every gate carries the new key', async () => {
      const rotationDone = desktop(OLD);
      const { el, harness } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), latestBundleSigners: [OLD.kid] }),
      );
      expect(text(el, '[data-rotation-command="pin-both"]')).toBe(
        `php moat-gate.php trust --signer=${OLD.publicKey},${NEW.publicKey}`,
      );
      expect(text(el, '[data-rotation-command="pin-new"]')).toBe(
        `php moat-gate.php trust --signer=${NEW.publicKey}`,
      );
      expect(text(el, '[data-rotation-gate]')).toContain('noch nicht');
      const done = el.querySelector(
        '[data-rotation-done]',
      ) as HTMLButtonElement;
      expect(done.disabled).toBe(true);
      done.click();
      await settle(harness);
      expect(rotationDone).not.toHaveBeenCalled();
    });

    it('finishes the change once the latest bundle is signed with the new key', async () => {
      const rotationDone = desktop(OLD);
      const { el, harness } = await openProjectTab(
        'gates',
        GatesPage,
        withGate({ ...site(), latestBundleSigners: [OLD.kid, NEW.kid] }),
      );
      expect(text(el, '[data-rotation-gate]')).toContain('ist mit dem neuen');
      const done = el.querySelector(
        '[data-rotation-done]',
      ) as HTMLButtonElement;
      expect(done.disabled).toBe(false);
      done.click();
      await settle(harness);
      expect(rotationDone).toHaveBeenCalledOnce();
    });
  });
});
