import {
  ACCOUNT_NAV_ITEM,
  HELP_NAV_ITEM,
  isNavActive,
  NAV_ICONS,
  NAV_ITEMS,
  ORGANISATIONS_NAV_ITEM,
  organisationNavItems,
} from './nav-config';

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

  it("Moat Cloud: registers icons for its entries and lists the active organisation's pages", () => {
    const items = [
      ORGANISATIONS_NAV_ITEM,
      ACCOUNT_NAV_ITEM,
      ...organisationNavItems('OOOOOOOOOOOOOOOOOOOOOO'),
    ];
    for (const item of items) {
      expect(Object.keys(NAV_ICONS)).toContain(item.icon);
    }
    expect(items.map((item) => item.path)).toEqual([
      '/app/organisations',
      '/app/account',
      '/app/organisations/OOOOOOOOOOOOOOOOOOOOOO/projects',
      '/app/organisations/OOOOOOOOOOOOOOOOOOOOOO/members',
    ]);
  });

  it("the list of organisations is active on itself only, not on an organisation's pages", () => {
    expect(isNavActive('/app/organisations', ORGANISATIONS_NAV_ITEM)).toBe(
      true,
    );
    expect(
      isNavActive('/app/organisations/abc/members', ORGANISATIONS_NAV_ITEM),
    ).toBe(false);
    const [projects] = organisationNavItems('abc');
    if (!projects) throw new Error('no projects entry');
    expect(isNavActive('/app/organisations/abc/projects', projects)).toBe(true);
  });
});
