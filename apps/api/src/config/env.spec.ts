import { describe, expect, it } from 'vitest';
import { validateEnv } from './env';

const LOCAL = { AUTH_MODE: 'local', LOCAL_MODE: 'true' };

describe('validateEnv', () => {
  it('accepts local mode with and without a project folder', () => {
    expect(validateEnv(LOCAL).MOAT_PROJECT_DIR).toBeUndefined();
    expect(
      validateEnv({ ...LOCAL, MOAT_PROJECT_DIR: '/home/me/site' })
        .MOAT_PROJECT_DIR,
    ).toBe('/home/me/site');
    expect(
      validateEnv({ ...LOCAL, MOAT_PROJECT_DIR: 'C:\\Users\\me\\site' }),
    ).toBeTruthy();
  });

  it('refuses to boot without local mode, or with another auth mode (fail closed)', () => {
    expect(() => validateEnv({})).toThrow(/AUTH_MODE/);
    expect(() => validateEnv({ AUTH_MODE: 'local' })).toThrow(/LOCAL_MODE/);
    expect(() => validateEnv({ AUTH_MODE: 'dev', LOCAL_MODE: 'true' })).toThrow(
      /AUTH_MODE/,
    );
  });

  it('refuses a relative project folder and never echoes the value', () => {
    expect(() =>
      validateEnv({ ...LOCAL, MOAT_PROJECT_DIR: 'PLANTED/relative' }),
    ).toThrow(/^Invalid API environment: MOAT_PROJECT_DIR$/);
  });
});
