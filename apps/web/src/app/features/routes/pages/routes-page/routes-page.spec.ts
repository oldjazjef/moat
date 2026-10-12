import { openPage, PROJECT } from '../../../../../testing/page-harness';
import { RoutesPage } from './routes-page';

const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('RoutesPage', () => {
  it('shows each route as the gate enforces it, and the upstream with its secret by name', async () => {
    const { el } = await openPage('/app/routes', RoutesPage, PROJECT);
    const row = text(el, '[data-route-name="newsletter"]');
    expect(row).toContain('POST /newsletter');
    expect(row).toContain('https://api.hubapi.com/crm/v3/objects/contacts');
    expect(text(el, '[data-origins]')).toBe('https://www.example.ch');
    expect(text(el, '[data-rate-limit]')).toBe('5 pro 10 min je Besucher');
    expect(row).toContain('4 KiB');
    expect(text(el, '[data-upstream]')).toContain(
      'Bearer-Token aus Secret «hubspot-token»',
    );
  });

  it('sends to the overview when moat.yaml cannot be used', async () => {
    const { el } = await openPage('/app/routes', RoutesPage, {
      folder: '/p',
      project: { config: { status: 'missing' }, gates: [] },
    });
    expect(el.querySelector('[data-config-unusable]')).not.toBeNull();
  });
});
