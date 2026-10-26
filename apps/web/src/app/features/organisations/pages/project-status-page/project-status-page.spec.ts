import {
  ADMIN_ACCESS,
  ORG_ID,
  VIEWER_ACCESS,
  entry,
  openCloudPage,
  text,
} from '../../../../../testing/cloud-harness';
import type {
  GateStatus,
  ProjectStatus,
} from '../../../../core/api/gates.types';
import type { MyAccess } from '../../../../core/auth/account.types';
import { ProjectStatusPage } from './project-status-page';

const PROJECT = 'PPPPPPPPPPPPPPPPPPPPP1';
const BASE = `/api/orgs/${ORG_ID}/projects/${PROJECT}`;
const ROUTES = [
  {
    path: 'app/organisations/:orgId/projects/:projectId/status',
    component: ProjectStatusPage,
  },
  { path: 'app/organisations/:orgId/projects/:projectId', children: [] },
  { path: 'app/organisations/:orgId/projects/:projectId/config', children: [] },
  { path: 'app/organisations/:orgId/projects', children: [] },
  { path: 'app/organisations/:orgId/members', children: [] },
  { path: 'app/organisations/:orgId/audit', children: [] },
];
const gate = (patch: Partial<GateStatus> = {}): GateStatus => ({
  name: 'site',
  mode: 'managed',
  latestVersion: 2,
  issuedAt: '2026-10-20T08:00:00.000Z',
  expiresAt: null,
  findings: [],
  ...patch,
});

const open = (
  status: ProjectStatus | { failStatus: number },
  access: MyAccess = ADMIN_ACCESS,
) =>
  openCloudPage(
    `/app/organisations/${ORG_ID}/projects/${PROJECT}/status`,
    ROUTES,
    {
      [`/api/orgs/${ORG_ID}`]: entry(access),
      [BASE]: { project: { id: PROJECT, name: 'Shop' } },
      [`${BASE}/status`]: status,
    },
  );

describe('ProjectStatusPage (Status eines Cloud-Projekts)', () => {
  afterEach(() => localStorage.clear());

  it('says plainly that nothing needs attention, and that it knows nothing about traffic', async () => {
    const { el } = await open({ project: [], gates: [gate()] });
    expect(text(el, '[data-status-ok]')).toBe('Nichts braucht Aufmerksamkeit.');
    expect(text(el, '[data-status-scope]')).toContain('nichts über Verkehr');
    expect(text(el, '[data-version]')).toBe('2');
    expect(text(el, '[data-issued]')).toBe('2026-10-20');
    expect(text(el, '[data-expires]')).toBe('läuft nicht ab');
    expect(text(el, '[data-gate-ok]')).toContain('braucht nichts');
  });

  it('lists the findings with their severity, the missing secrets by name only', async () => {
    const { el } = await open({
      project: [{ kind: 'config_missing', severity: 'warning' }],
      gates: [
        gate({
          latestVersion: 0,
          issuedAt: null,
          findings: [
            { kind: 'no_bundle', severity: 'warning' },
            {
              kind: 'secrets_missing',
              severity: 'warning',
              names: ['hubspot-token', 'other'],
            },
            { kind: 'bundle_expired', severity: 'error' },
          ],
        }),
      ],
    });
    expect(text(el, '[data-status-attention]')).toBe(
      '4 Punkt(e) brauchen Aufmerksamkeit.',
    );
    expect(text(el, '[data-status-project]')).toContain('noch keine moat.yaml');
    const gateEl = el.querySelector('[data-gate]') as HTMLElement;
    expect(gateEl.querySelectorAll('[data-finding]').length).toBe(3);
    expect(text(gateEl, '[data-names]')).toBe('hubspot-token, other');
    expect(
      gateEl.querySelector('[data-severity="error"]')?.textContent?.trim(),
    ).toBe('Fehler');
    expect(text(gateEl, '[data-version]')).toBe('noch keines');
  });

  it('counts a note (a pending release) as information, not as attention', async () => {
    const { el } = await open({
      project: [],
      gates: [
        gate({ findings: [{ kind: 'release_pending', severity: 'info' }] }),
      ],
    });
    expect(el.querySelector('[data-status-ok]')).not.toBeNull();
    expect(text(el, '[data-finding]')).toContain('Hinweis');
  });

  it('a viewer reads the status too', async () => {
    const { el } = await open({ project: [], gates: [] }, VIEWER_ACCESS);
    expect(el.querySelector('[data-no-gates]')).not.toBeNull();
  });

  it('shows a refused read as a translated text', async () => {
    const { el } = await open({ failStatus: 500 });
    expect(el.querySelector('[data-load-error]')).not.toBeNull();
  });
});
