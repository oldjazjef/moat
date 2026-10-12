import { HELP_NAV_ITEM, isNavActive, NAV_ICONS, NAV_ITEMS } from './nav-config';

describe('nav-config', () => {
  it('registers an icon for every entry', () => {
    for (const item of [...NAV_ITEMS, HELP_NAV_ITEM]) {
      expect(Object.keys(NAV_ICONS)).toContain(item.icon);
    }
  });

  it('marks the entry whose path the URL lies under', () => {
    const projects = NAV_ITEMS.find((item) => item.path === '/app/projects');
    if (!projects) throw new Error('no projects entry');
    expect(isNavActive('/app/projects', projects)).toBe(true);
    expect(isNavActive('/app/projects/abc/gates?x=1#y', projects)).toBe(true);
    expect(isNavActive('/app/projectsx', projects)).toBe(false);
    expect(isNavActive('/app/help', projects)).toBe(false);
  });
});
