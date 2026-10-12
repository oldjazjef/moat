import { HELP_NAV_ITEM, isNavActive, NAV_ICONS, NAV_ITEMS } from './nav-config';

describe('nav-config', () => {
  it('registers an icon for every entry', () => {
    for (const item of [...NAV_ITEMS, HELP_NAV_ITEM]) {
      expect(Object.keys(NAV_ICONS)).toContain(item.icon);
    }
  });

  it('marks the entry whose path the URL lies under', () => {
    const gates = NAV_ITEMS.find((item) => item.path === '/app/gates');
    if (!gates) throw new Error('no gates entry');
    expect(isNavActive('/app/gates', gates)).toBe(true);
    expect(isNavActive('/app/gates?x=1#y', gates)).toBe(true);
    expect(isNavActive('/app/gatesx', gates)).toBe(false);
    expect(isNavActive('/app/routes', gates)).toBe(false);
  });
});
