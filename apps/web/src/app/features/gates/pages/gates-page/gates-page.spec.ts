import type { ProjectView } from '../../../../core/api/project.types';
import { openProjectTab, PROJECT } from '../../../../../testing/page-harness';
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
});
