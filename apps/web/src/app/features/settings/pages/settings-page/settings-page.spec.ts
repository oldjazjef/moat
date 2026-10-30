import type { ProjectSummary } from '../../../../core/api/project.types';
import type { DesktopBridge } from '../../../../core/desktop/desktop-bridge';
import { openPage, PROJECT } from '../../../../../testing/page-harness';
import { SettingsPage } from './settings-page';

const ROUTES = [
  { path: 'app/settings', component: SettingsPage },
  { path: 'app/projects', children: [] },
  { path: 'app/projects/:id/:tab', children: [] },
];
const SUMMARY: ProjectSummary = {
  id: PROJECT.id,
  name: PROJECT.name,
  folder: PROJECT.folder,
  config: 'valid',
  routes: 1,
  gates: 1,
  gatesMissingSecrets: [],
  gatesLocked: [],
};
const OTHER: ProjectSummary = {
  ...SUMMARY,
  id: 'B'.repeat(22),
  name: 'blog',
  folder: '/sites/blog',
};
const KEY = {
  kid: 'kid0000000000000000000',
  publicKey: 'P'.repeat(42) + 'A',
  fingerprint: 'MOAT-SIGN-ER00',
};
const PASSKEY = {
  kid: 'pk00000000000000000000',
  publicKey: 'Q'.repeat(87),
  fingerprint: 'MOAT-PASS-KEY0',
  rpId: 'passkey.moat.invalid',
  origin: 'https://passkey.moat.invalid',
  trustCommand: 'php moat-gate.php trust --passkey=…',
  installCommand: 'php moat-gate.php install --passkey=…',
};

const text = (el: Element | null) =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
async function settle(harness: { detectChanges(): void }): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve));
    harness.detectChanges();
  }
}

function bridge(): DesktopBridge {
  return {
    platform: 'linux',
    project: { add: vi.fn(), create: vi.fn(), reveal: vi.fn() },
    key: {
      // Each project its own key: the first has one, the second none.
      status: vi.fn((id: string) =>
        Promise.resolve(
          id === PROJECT.id
            ? { status: 'ready' as const, key: KEY, previous: null }
            : { status: 'none' as const },
        ),
      ),
      choose: vi.fn(),
      create: vi.fn().mockResolvedValue({ status: 'created', key: KEY }),
      rotationDone: vi.fn(),
    },
    bundle: { sign: vi.fn() },
    secret: { seal: vi.fn() },
    gate: { deploy: vi.fn(), import: vi.fn(), log: vi.fn() },
    update: {
      check: vi.fn().mockResolvedValue({
        status: 'available',
        current: '0.0.1',
        latest: '0.0.2',
      }),
      open: vi.fn().mockResolvedValue(undefined),
      auto: vi.fn().mockResolvedValue(true),
      setAuto: vi.fn((on: boolean) => Promise.resolve(on)),
    },
    passkey: {
      status: vi.fn().mockResolvedValue({ passkey: null, gates: [] }),
      enroll: vi
        .fn()
        .mockResolvedValue({ status: 'created', passkey: PASSKEY }),
      use: vi.fn(),
    },
  };
}

describe('SettingsPage (Moat Desktop)', () => {
  beforeEach(() => localStorage.setItem('mt.locale', 'de-CH'));
  afterEach(() => {
    delete window.moatDesktop;
    localStorage.clear();
  });

  it("shows every project's own signing key, by its public half only", async () => {
    const desktop = bridge();
    window.moatDesktop = desktop;
    const { el, harness } = await openPage('/app/settings', ROUTES, {
      '/api/projects': [SUMMARY, OTHER],
    });
    await settle(harness);
    expect(desktop.key.status).toHaveBeenCalledWith(PROJECT.id);
    expect(desktop.key.status).toHaveBeenCalledWith(OTHER.id);
    const [first, second] = [...el.querySelectorAll('[data-settings-project]')];
    expect(text(first?.querySelector('h3') ?? null)).toBe(PROJECT.name);
    expect(text(first?.querySelector('[data-key-fingerprint]') ?? null)).toBe(
      KEY.fingerprint,
    );
    expect(second?.querySelector('[data-key-none]')).not.toBeNull();
  });

  it('creates a key for exactly the project it was asked for', async () => {
    const desktop = bridge();
    window.moatDesktop = desktop;
    const { el, harness } = await openPage('/app/settings', ROUTES, {
      '/api/projects': [SUMMARY, OTHER],
    });
    await settle(harness);
    const second = el.querySelectorAll('[data-settings-project]')[1];
    (second?.querySelector('[data-key-create]') as HTMLButtonElement).click();
    await settle(harness);
    expect(desktop.key.create).toHaveBeenCalledWith(OTHER.id, 'de-CH');
  });

  it("enrolls the device's passkey, without naming a project", async () => {
    const desktop = bridge();
    window.moatDesktop = desktop;
    const { el, harness } = await openPage('/app/settings', ROUTES, {
      '/api/projects': [SUMMARY],
    });
    await settle(harness);
    expect(desktop.passkey?.status).toHaveBeenCalledWith(null);
    expect(el.querySelector('[data-passkey-none]')).not.toBeNull();
    const passkey = desktop.passkey;
    if (passkey === undefined) throw new Error('no passkey bridge');
    vi.mocked(passkey.status).mockResolvedValue({
      passkey: PASSKEY,
      gates: [],
    });
    (el.querySelector('[data-passkey-enroll]') as HTMLButtonElement).click();
    await settle(harness);
    expect(text(el.querySelector('[data-passkey-fingerprint]'))).toBe(
      PASSKEY.fingerprint,
    );
    expect(el.querySelector('[data-passkey-created]')).not.toBeNull();
  });

  it('shows a newer release and opens its page, never installs it', async () => {
    const desktop = bridge();
    window.moatDesktop = desktop;
    const { el, harness } = await openPage('/app/settings', ROUTES, {
      '/api/projects': [],
    });
    (el.querySelector('[data-update-check]') as HTMLButtonElement).click();
    await settle(harness);
    expect(
      el.querySelector('[data-update-result]')?.getAttribute('data-status'),
    ).toBe('available');
    expect(text(el.querySelector('[data-update-result]'))).toContain('0.0.2');
    (el.querySelector('[data-update-open]') as HTMLButtonElement).click();
    await settle(harness);
    expect(desktop.update?.open).toHaveBeenCalledWith('0.0.2');
    const auto = el.querySelector('[data-update-auto]') as HTMLInputElement;
    auto.click();
    await settle(harness);
    expect(desktop.update?.setAuto).toHaveBeenCalledWith(false);
  });

  it('points to the projects when there is none', async () => {
    window.moatDesktop = bridge();
    const { el } = await openPage('/app/settings', ROUTES, {
      '/api/projects': [],
    });
    expect(el.querySelector('[data-settings-no-projects]')).not.toBeNull();
  });
});
