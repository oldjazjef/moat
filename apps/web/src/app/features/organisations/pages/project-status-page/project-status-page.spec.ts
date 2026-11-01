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
  GateTraffic,
  ProjectStatus,
  ProjectTraffic,
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

const quiet = (patch: Partial<GateTraffic> = {}): GateTraffic => ({
  gate: 'site',
  hasReportAddress: false,
  lastReceivedAt: null,
  totals: {
    requests: 0,
    s2: 0,
    s3: 0,
    s4: 0,
    s5: 0,
    msAverage: null,
    msMax: 0,
  },
  routes: [],
  errors: [],
  hours: [],
  ...patch,
});
const NO_TRAFFIC: ProjectTraffic = { from: 0, to: 0, gates: [quiet()] };

const open = (
  status: ProjectStatus | { failStatus: number },
  access: MyAccess = ADMIN_ACCESS,
  traffic: ProjectTraffic = NO_TRAFFIC,
) =>
  openCloudPage(
    `/app/organisations/${ORG_ID}/projects/${PROJECT}/status`,
    ROUTES,
    {
      [`/api/orgs/${ORG_ID}`]: entry(access),
      [BASE]: { project: { id: PROJECT, name: 'Shop' } },
      [`${BASE}/status`]: status,
      [`${BASE}/traffic?days=7`]: traffic,
      [`${BASE}/traffic?days=30`]: traffic,
    },
  );

describe('ProjectStatusPage (Status eines Cloud-Projekts)', () => {
  afterEach(() => localStorage.clear());

  it('says plainly that nothing needs attention, and that a gate without an address reports nothing', async () => {
    const { el } = await open({ project: [], gates: [gate()] });
    expect(text(el, '[data-status-ok]')).toBe('Nichts braucht Aufmerksamkeit.');
    expect(text(el, '[data-status-scope]')).toContain(
      'nicht als geprüfte Tatsache',
    );
    expect(text(el, '[data-traffic-off]')).toContain('meldet nichts');
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

  it("shows the reported traffic as the gate's claim: sums, routes, error codes (FR-51, T-110)", async () => {
    const { el } = await open({ project: [], gates: [gate()] }, ADMIN_ACCESS, {
      from: 0,
      to: 0,
      gates: [
        quiet({
          hasReportAddress: true,
          lastReceivedAt: '2026-11-01T10:05:00.000Z',
          totals: {
            requests: 40,
            s2: 36,
            s3: 0,
            s4: 3,
            s5: 1,
            msAverage: 120,
            msMax: 900,
          },
          routes: [
            {
              route: 'newsletter',
              requests: 30,
              s2: 27,
              s3: 0,
              s4: 3,
              s5: 0,
              msAverage: 100,
              msMax: 300,
            },
            {
              route: null,
              requests: 10,
              s2: 9,
              s3: 0,
              s4: 0,
              s5: 1,
              msAverage: 180,
              msMax: 900,
            },
          ],
          errors: [{ code: 'rate_limited', count: 3 }],
          hours: [
            { hour: 3600, requests: 10, failed: 1 },
            { hour: 7200, requests: 30, failed: 3 },
          ],
        }),
      ],
    });
    expect(text(el, '[data-traffic-claim]')).toContain('2026-11-01 10:05');
    expect(text(el, '[data-requests]')).toBe('40');
    expect(text(el, '[data-failed]')).toBe('4 (10.0 %)');
    expect(text(el, '[data-latency]')).toContain('120 ms');
    expect(el.querySelectorAll('[data-traffic-route]').length).toBe(2);
    expect(text(el, '[data-traffic-routes]')).toContain('keine Route');
    expect(text(el, '[data-traffic-codes]')).toContain('rate_limited');
    expect(el.querySelectorAll('[data-traffic-chart] rect').length).toBe(2);
  });
});
