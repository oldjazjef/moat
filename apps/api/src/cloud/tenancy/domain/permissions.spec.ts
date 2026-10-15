import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  type Action,
  can,
  canChangeRole,
  canHoldRelease,
  permissionsOf,
  ROLES,
  type Role,
} from './permissions';

/** The whole table, written out: a change to the permissions has to change this too. */
const EXPECTED: Record<Role, Action[]> = {
  owner: [
    'org:read',
    'members:read',
    'members:manage',
    'release:grant',
    'project:read',
    'project:create',
    'project:delete',
    'billing:manage',
  ],
  admin: [
    'org:read',
    'members:read',
    'members:manage',
    'project:read',
    'project:create',
    'project:delete',
  ],
  editor: ['org:read', 'members:read', 'project:read', 'project:create'],
  viewer: ['org:read', 'members:read', 'project:read'],
  billing: ['org:read', 'billing:manage'],
};

describe('can(role, releaseGranted, action) (SEC-52)', () => {
  for (const role of ROLES) {
    for (const releaseGranted of [false, true]) {
      for (const action of ACTIONS) {
        const expected =
          action === 'release'
            ? releaseGranted && canHoldRelease(role)
            : EXPECTED[role].includes(action);
        it(`${role} / release ${releaseGranted} / ${action} → ${expected}`, () => {
          expect(can(role, releaseGranted, action)).toBe(expected);
        });
      }
    }
  }

  it('keeps the sign/release permission separate from every role (SEC-52)', () => {
    for (const role of ROLES) expect(can(role, false, 'release')).toBe(false);
  });

  it('lets only Owner, Admin and Editor hold it; Viewer and Billing never', () => {
    expect(ROLES.filter(canHoldRelease)).toEqual(['owner', 'admin', 'editor']);
    expect(can('viewer', true, 'release')).toBe(false);
    expect(can('billing', true, 'release')).toBe(false);
  });

  it('lets only an Owner grant it, and covers every action in the table', () => {
    expect(ROLES.filter((r) => can(r, true, 'release:grant'))).toEqual([
      'owner',
    ]);
    for (const role of ROLES)
      expect(permissionsOf(role, false)).toEqual(EXPECTED[role]);
  });

  it('refuses an unknown role or action (fail closed)', () => {
    expect(can('root' as Role, true, 'org:read')).toBe(false);
    expect(can('owner', true, 'everything' as Action)).toBe(false);
  });
});

describe('canChangeRole (role escalation, SEC-52)', () => {
  it('lets an Owner do anything', () => {
    for (const from of [null, ...ROLES])
      for (const to of [null, ...ROLES])
        expect(canChangeRole('owner', from, to)).toBe(true);
  });

  it('keeps an Admin among Editor, Viewer and Billing', () => {
    expect(canChangeRole('admin', null, 'editor')).toBe(true);
    expect(canChangeRole('admin', 'viewer', 'billing')).toBe(true);
    expect(canChangeRole('admin', 'editor', null)).toBe(true);
    for (const high of ['owner', 'admin'] as const) {
      expect(canChangeRole('admin', null, high)).toBe(false);
      expect(canChangeRole('admin', 'editor', high)).toBe(false);
      expect(canChangeRole('admin', high, 'viewer')).toBe(false);
      expect(canChangeRole('admin', high, null)).toBe(false);
    }
  });

  it('lets nobody else change roles', () => {
    for (const actor of ['editor', 'viewer', 'billing'] as const)
      for (const from of [null, ...ROLES])
        for (const to of [null, ...ROLES])
          expect(canChangeRole(actor, from, to)).toBe(false);
  });
});
