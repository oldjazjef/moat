import {
  HttpTestingController,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { ProjectSummary } from '../../../../core/api/project.types';
import type {
  SetupStepId,
  SetupView,
  StepState,
} from '../../../../core/api/setup.types';
import type { DesktopBridge } from '../../../../core/desktop/desktop-bridge';
import { openPage, PROJECT } from '../../../../../testing/page-harness';
import { SetupPage } from './setup-page';

const text = (el: Element | null) =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const ROUTES = [
  { path: 'app/setup', component: SetupPage },
  { path: 'app/projects', children: [] },
  { path: 'app/projects/:id', children: [] },
  { path: 'app/help', children: [] },
];

function view(
  current: SetupStepId,
  states: Partial<Record<SetupStepId, StepState>> = {},
  facts = { projects: 1, gates: 0, routes: 0 },
): SetupView {
  return {
    steps: (
      ['language', 'project', 'signingKey', 'gate', 'summary'] as const
    ).map((id) => ({
      id,
      required: id === 'language' || id === 'project',
      state: states[id] ?? 'open',
    })),
    currentStep: current,
    completedAt: null,
    complete: false,
    missing: [],
    facts,
  };
}

const SUMMARY: ProjectSummary = {
  id: PROJECT.id,
  name: PROJECT.name,
  folder: PROJECT.folder,
  config: 'valid',
  routes: 1,
  gates: 0,
  gatesMissingSecrets: [],
  gatesLocked: [],
};
const STATE = PROJECT.project;
if (STATE === null) throw new Error('PROJECT has no state');
const NO_GATES = { ...PROJECT, project: { config: STATE.config, gates: [] } };
/** An element the page must have. */
function field(el: HTMLElement, selector: string): HTMLInputElement {
  const found = el.querySelector<HTMLInputElement>(selector);
  if (found === null) throw new Error(`${selector} missing`);
  return found;
}
const KEY = {
  kid: 'kid0000000000000000000',
  publicKey: 'P'.repeat(42) + 'A',
  fingerprint: 'MOAT-SIGN-ER00',
};

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    platform: 'linux',
    project: {
      add: vi.fn(),
      create: vi.fn().mockResolvedValue({
        status: 'added',
        id: PROJECT.id,
        created: true,
      }),
      reveal: vi.fn(),
    },
    key: {
      status: vi.fn().mockResolvedValue({ status: 'none' }),
      choose: vi.fn(),
      create: vi.fn().mockResolvedValue({ status: 'created', key: KEY }),
      rotationDone: vi.fn(),
    },
    bundle: {
      sign: vi.fn().mockResolvedValue({ status: 'signed', version: 4 }),
    },
    secret: {
      seal: vi.fn().mockResolvedValue({ status: 'sealed', secretVersion: 3 }),
    },
    gate: { deploy: vi.fn(), import: vi.fn(), log: vi.fn() },
    ...overrides,
  };
}

const open = (setup: SetupView, extra: Record<string, unknown> = {}) =>
  openPage('/app/setup', ROUTES, {
    '/api/setup': setup,
    '/api/projects': [SUMMARY],
    [`/api/projects/${PROJECT.id}`]: NO_GATES,
    ...extra,
  });

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

describe('SetupPage (FR-73)', () => {
  // The language step's LanguageService starts in the remembered language.
  beforeEach(() => localStorage.setItem('mt.locale', 'de-CH'));
  afterEach(() => {
    delete window.moatDesktop;
    localStorage.clear();
  });

  it('shows the steps with their state and moves on with «Weiter»', async () => {
    const { el, harness } = await open(view('language'));
    const steps = [...el.querySelectorAll('[data-setup-step]')];
    expect(steps.map((step) => step.getAttribute('data-step-id'))).toEqual([
      'language',
      'project',
      'signingKey',
      'gate',
      'summary',
    ]);
    expect(text(el.querySelector('#setup-step-title'))).toBe('Sprache');
    // Not visited yet: only the current step can be opened.
    expect((steps[3] as HTMLButtonElement).disabled).toBe(true);
    // Required: no «Später».
    expect(el.querySelector('[data-setup-skip]')).toBeNull();

    click(el, '[data-setup-next]');
    await settle(harness);
    const patch = http().expectOne('/api/setup');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({
      states: { language: 'done' },
      currentStep: 'project',
    });
    patch.flush(view('project', { language: 'done' }));
    await settle(harness);
    expect(text(el.querySelector('#setup-step-title'))).toBe('Erstes Projekt');
    // Required as well.
    expect(el.querySelector('[data-setup-skip]')).toBeNull();
  });

  it("creates the project's key in the desktop window and shows only its public half", async () => {
    const desktop = bridge();
    window.moatDesktop = desktop;
    const { el, harness } = await open(view('signingKey'));
    expect(desktop.key.status).toHaveBeenCalledWith(PROJECT.id);
    expect(el.querySelector('[data-key-none]')).not.toBeNull();
    vi.mocked(desktop.key.status).mockResolvedValue({
      status: 'ready',
      key: KEY,
      previous: null,
    });
    click(el, '[data-key-create]');
    await settle(harness);
    // Every project has its own key: the window makes it for this one.
    expect(desktop.key.create).toHaveBeenCalledWith(PROJECT.id, 'de-CH');
    expect(text(el.querySelector('[data-key-fingerprint]'))).toBe(
      KEY.fingerprint,
    );
    expect(text(el.querySelector('[data-key-public]'))).toBe(KEY.publicKey);
  });

  it('stays on the key step without a key and offers «Später»', async () => {
    window.moatDesktop = bridge();
    const { el, harness } = await open(view('signingKey'));
    click(el, '[data-setup-next]');
    await settle(harness);
    http()
      .expectOne('/api/setup')
      .flush(view('signingKey', { signingKey: 'error' }));
    await settle(harness);
    expect(el.querySelector('[data-key-notice]')).not.toBeNull();
    expect(text(el.querySelector('#setup-step-title'))).toBe(
      'Signaturschlüssel',
    );

    click(el, '[data-setup-skip]');
    await settle(harness);
    const skip = http().expectOne('/api/setup');
    expect(skip.request.body).toEqual({
      states: { signingKey: 'skipped' },
      currentStep: 'gate',
    });
  });

  it('creates a new project through the desktop and selects it', async () => {
    const desktop = bridge();
    window.moatDesktop = desktop;
    const { el, harness } = await open(view('project'), {
      '/api/projects': [],
    });
    expect(el.querySelector('[data-project-none]')).not.toBeNull();
    click(el, '[data-project-create]');
    await settle(harness);
    expect(desktop.project.create).toHaveBeenCalledOnce();
    http().expectOne('/api/projects').flush([SUMMARY]);
    await settle(harness);
    const choice = el.querySelector<HTMLInputElement>(
      '[data-project="example"] input',
    );
    expect(choice?.checked).toBe(true);
  });

  it('pins a gate only after the fingerprint was confirmed, then puts it in the environment', async () => {
    window.moatDesktop = bridge({
      key: {
        status: vi
          .fn()
          .mockResolvedValue({ status: 'ready', key: KEY, previous: null }),
        choose: vi.fn(),
        create: vi.fn(),
        rotationDone: vi.fn(),
      },
    });
    const { el, harness } = await open(view('gate'));
    expect(text(el.querySelector('[data-gate-command]'))).toBe(
      `php moat-gate.php install --signer=${KEY.publicKey}`,
    );
    const gateId = 'g'.repeat(22);
    const boxKey = 'B'.repeat(42) + 'A';
    // The whole line from the gate's output fills both fields.
    const idField = field(el, '#gate-id');
    const paste = new Event('paste', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        getData: () =>
          `moat gate add <name> --gate-id=${gateId} --box-key=${boxKey}`,
      },
    });
    idField.dispatchEvent(paste);
    await settle(harness);
    expect(idField.value).toBe(gateId);
    expect(el.querySelector<HTMLInputElement>('#gate-box-key')?.value).toBe(
      boxKey,
    );

    click(el, '[data-gate-check]');
    await settle(harness);
    const check = http().expectOne(`/api/projects/${PROJECT.id}/gates/check`);
    expect(check.request.body).toEqual({ name: 'www', gateId, boxKey });
    check.flush({
      name: 'www',
      gateId,
      boxKeyId: 'kid',
      boxKeyFingerprint: 'MOAT-BOXK-EY00',
    });
    await settle(harness);
    expect(text(el.querySelector('[data-gate-fingerprint]'))).toBe(
      'MOAT-BOXK-EY00',
    );
    http().expectNone(`/api/projects/${PROJECT.id}/gates`);

    click(el, '[data-gate-confirm]');
    await settle(harness);
    const add = http().expectOne(`/api/projects/${PROJECT.id}/gates`);
    expect(add.request.body).toEqual({
      name: 'www',
      gateId,
      boxKey,
      fingerprint: 'MOAT-BOXK-EY00',
    });
    add.flush({
      ...PROJECT,
      project: {
        ...PROJECT.project,
        gates: STATE.gates.map((gate) => ({ ...gate, name: 'www' })),
      },
    });
    await settle(harness);
    const assign = http().expectOne(`/api/projects/${PROJECT.id}/config/edits`);
    expect(assign.request.body).toEqual({
      base: PROJECT.configHash,
      op: 'assignGate',
      gate: 'www',
      environment: 'production',
    });
    assign.flush(PROJECT);
    await settle(harness);
    expect(text(el.querySelector('[data-gate-saved]'))).toContain('www');
  });

  it('writes nothing when the fingerprint differs', async () => {
    window.moatDesktop = bridge();
    const { el, harness } = await open(view('gate'));
    const set = (selector: string, value: string) => {
      const input = field(el, selector);
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('#gate-id', 'g'.repeat(22));
    set('#gate-box-key', 'B'.repeat(42) + 'A');
    click(el, '[data-gate-check]');
    await settle(harness);
    http()
      .expectOne(`/api/projects/${PROJECT.id}/gates/check`)
      .flush({
        name: 'www',
        gateId: 'g'.repeat(22),
        boxKeyId: 'kid',
        boxKeyFingerprint: 'MOAT-XXXX',
      });
    await settle(harness);
    click(el, '[data-gate-reject]');
    await settle(harness);
    http().expectNone(`/api/projects/${PROJECT.id}/gates`);
    expect(
      el.querySelector('[data-gate-notice]')?.getAttribute('data-code'),
    ).toBe('rejected');
    expect(el.querySelector<HTMLInputElement>('#gate-id')?.value).toBe('');
  });

  describe('«Vom Gate abrufen» (SEC-28, T-73)', () => {
    const gateId = 'g'.repeat(22);
    const boxKey = 'B'.repeat(42) + 'A';
    const TOKEN = 'T'.repeat(43);
    const identity = (fingerprint: string) => ({
      gateId,
      boxKey,
      boxKeyFingerprint: 'MOAT-BOXK-EY00',
      signers: [{ kid: 'k'.repeat(22), fingerprint }],
      threshold: 1,
      mode: 1,
    });
    const withKey = () =>
      (window.moatDesktop = bridge({
        key: {
          status: vi
            .fn()
            .mockResolvedValue({ status: 'ready', key: KEY, previous: null }),
          choose: vi.fn(),
          create: vi.fn(),
          rotationDone: vi.fn(),
        },
      }));
    const type = (el: HTMLElement, selector: string, value: string) => {
      const input = field(el, selector);
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    async function fetchFromGate(
      el: HTMLElement,
      harness: { detectChanges(): void },
    ) {
      if (el.querySelector('#gate-fetch-url') === null)
        click(el, '[data-gate-fetch-toggle]');
      await settle(harness);
      type(el, '#gate-fetch-url', 'https://www.example.ch/moat-gate.php');
      type(el, '#gate-fetch-token', TOKEN);
      click(el, '[data-gate-fetch-run]');
      await settle(harness);
      return http().expectOne(`/api/projects/${PROJECT.id}/gates/setup`);
    }

    it('fills gate id and box key, shows the fingerprints and that the own signer is pinned, and still needs the confirmation', async () => {
      withKey();
      const { el, harness } = await open(view('gate'));
      const request = await fetchFromGate(el, harness);
      expect(request.request.body).toEqual({
        url: 'https://www.example.ch/moat-gate.php',
        token: TOKEN,
        locale: expect.any(String),
      });
      request.flush({ status: 'read', identity: identity(KEY.fingerprint) });
      await settle(harness);
      expect(field(el, '#gate-id').value).toBe(gateId);
      expect(field(el, '#gate-box-key').value).toBe(boxKey);
      expect(text(el.querySelector('[data-gate-fetch-box]'))).toBe(
        'MOAT-BOXK-EY00',
      );
      expect(
        [...el.querySelectorAll('[data-gate-fetch-signer]')].map((node) =>
          text(node),
        ),
      ).toEqual([KEY.fingerprint]);
      expect(
        el
          .querySelector('[data-gate-fetch-signer-state]')
          ?.getAttribute('data-gate-fetch-signer-state'),
      ).toBe('pinned');
      expect(text(el.querySelector('[data-gate-fetch-result]'))).toContain(
        'Dein Signaturschlüssel ist auf dem Gate gepinnt',
      );
      // Nothing is pinned yet, and the token is not kept in the form.
      http().expectNone(`/api/projects/${PROJECT.id}/gates`);
      expect(field(el, '#gate-fetch-token').value).toBe('');

      click(el, '[data-gate-check]');
      await settle(harness);
      expect(
        http().expectOne(`/api/projects/${PROJECT.id}/gates/check`).request
          .body,
      ).toEqual({ name: 'www', gateId, boxKey });
    });

    it('warns clearly when the own signing key is not pinned on the gate', async () => {
      withKey();
      const { el, harness } = await open(view('gate'));
      (await fetchFromGate(el, harness)).flush({
        status: 'read',
        identity: identity('MOAT-OTHE-R000'),
      });
      await settle(harness);
      const state = el.querySelector('[data-gate-fetch-signer-state]');
      expect(state?.getAttribute('data-gate-fetch-signer-state')).toBe(
        'missing',
      );
      expect(text(state)).toContain('nicht gepinnt');
      expect(state?.getAttribute('role')).toBe('alert');
    });

    it('cannot compare without a chosen signing key, and says so', async () => {
      window.moatDesktop = bridge();
      const { el, harness } = await open(view('gate'));
      (await fetchFromGate(el, harness)).flush({
        status: 'read',
        identity: identity(KEY.fingerprint),
      });
      await settle(harness);
      expect(
        el
          .querySelector('[data-gate-fetch-signer-state]')
          ?.getAttribute('data-gate-fetch-signer-state'),
      ).toBe('unknown');
    });

    it('has a text for every refusal and every reason no answer came', async () => {
      window.moatDesktop = bridge();
      const { el, harness } = await open(view('gate'));
      const shown = async (flush: (r: TestRequest) => void) => {
        flush(await fetchFromGate(el, harness));
        await settle(harness);
        const error = el.querySelector('[data-gate-fetch-error]');
        return [error?.getAttribute('data-code'), text(error)] as const;
      };
      for (const code of [
        'url_invalid',
        'not_confirmed',
        'busy',
        'setup_off',
        'answer_invalid',
      ]) {
        const [shownCode, message] = await shown((r) =>
          r.flush({ error: code }, { status: 422, statusText: 'x' }),
        );
        expect(shownCode).toBe(code);
        expect(message).not.toContain('setup.gate.fetch');
        expect(message.length).toBeGreaterThan(10);
      }
      for (const reason of ['address_forbidden', 'tls', 'timeout']) {
        const [shownCode] = await shown((r) =>
          r.flush({ status: 'failed', reason }),
        );
        expect(shownCode).toBe(reason);
      }
      const [unknown] = await shown((r) =>
        r.flush('x', { status: 500, statusText: 'x' }),
      );
      expect(unknown).toBe('failed');
      expect(field(el, '#gate-id').value).toBe('');
    });

    it('refuses a token of the wrong shape without a request', async () => {
      window.moatDesktop = bridge();
      const { el, harness } = await open(view('gate'));
      click(el, '[data-gate-fetch-toggle]');
      await settle(harness);
      type(el, '#gate-fetch-url', 'https://www.example.ch/moat-gate.php');
      type(el, '#gate-fetch-token', 'short');
      click(el, '[data-gate-fetch-run]');
      await settle(harness);
      http().expectNone(`/api/projects/${PROJECT.id}/gates/setup`);
      expect(
        el.querySelector('[data-gate-fetch-error]')?.getAttribute('data-code'),
      ).toBe('token_invalid');
    });

    it('does not exist outside Moat Desktop', async () => {
      const { el } = await open(view('gate'));
      expect(el.querySelector('[data-gate-fetch]')).toBeNull();
    });
  });

  it('shows the trust mode only once a gate exists, never a hardening level, and finishes', async () => {
    const { el, harness } = await open(
      view('summary', {
        language: 'done',
        signingKey: 'skipped',
        project: 'done',
      }),
      { [`/api/projects/${PROJECT.id}`]: PROJECT },
    );
    expect(
      text(el.querySelector('[data-summary-trust] [data-trust-mode]')),
    ).toBe('Signiert');
    expect(text(el.querySelector('[data-summary-hardening]'))).toContain(
      'Noch nicht geprüft',
    );
    expect(
      text(
        el.querySelector('[data-summary-steps] [data-step-id="signingKey"]'),
      ),
    ).toContain('Übersprungen');

    click(el, '[data-setup-finish]');
    await settle(harness);
    const complete = http().expectOne('/api/setup/complete');
    expect(complete.request.method).toBe('POST');
    complete.flush({ ...view('summary'), complete: true });
    await settle(harness);
    expect(TestBed.inject(Router).url).toBe(`/app/projects/${PROJECT.id}`);
  });

  it('says honestly that no gate is there yet', async () => {
    const { el } = await open(view('summary'));
    expect(
      el.querySelector('[data-summary-trust] [data-trust-mode]'),
    ).toBeNull();
    expect(el.querySelector('[data-summary-no-gate]')).not.toBeNull();
  });

  it('opens the missing step when «Fertig» is refused', async () => {
    const { el, harness } = await open(view('summary'));
    click(el, '[data-setup-finish]');
    await settle(harness);
    http()
      .expectOne('/api/setup/complete')
      .flush(
        { error: 'setup_incomplete', missing: ['project'] },
        { status: 422, statusText: 'Unprocessable' },
      );
    await settle(harness);
    // Answer what the project step loads.
    for (const request of http().match(() => true)) {
      request.flush(
        request.request.url === '/api/setup' ? view('project') : [SUMMARY],
      );
    }
    await settle(harness);
    expect(text(el.querySelector('[data-setup-error]'))).toBe(
      'Es fehlen noch erforderliche Schritte.',
    );
    expect(text(el.querySelector('#setup-step-title'))).toBe('Erstes Projekt');
  });

  it('never locks the app behind the wizard when the progress cannot be stored', async () => {
    const { el, harness } = await open(view('summary'));
    click(el, '[data-setup-finish]');
    await settle(harness);
    http()
      .expectOne('/api/setup/complete')
      .flush(null, { status: 500, statusText: 'Error' });
    await settle(harness);
    expect(TestBed.inject(Router).url).toBe('/app/projects');
  });
});
