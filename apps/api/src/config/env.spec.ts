import { describe, expect, it } from 'vitest';
import { validateEnv } from './env';

const LOCAL = {
  AUTH_MODE: 'local',
  LOCAL_MODE: 'true',
  MOAT_DATA_DIR: '/home/me/.config/moat',
};

describe('validateEnv', () => {
  it('accepts local mode with a POSIX or Windows data folder', () => {
    expect(validateEnv(LOCAL).MOAT_DATA_DIR).toBe('/home/me/.config/moat');
    expect(
      validateEnv({ ...LOCAL, MOAT_DATA_DIR: 'C:\\Users\\me\\AppData\\Moat' }),
    ).toBeTruthy();
  });

  it('refuses to boot without local mode, or with another auth mode (fail closed)', () => {
    expect(() => validateEnv({ MOAT_DATA_DIR: '/d' })).toThrow(/AUTH_MODE/);
    expect(() =>
      validateEnv({ AUTH_MODE: 'local', MOAT_DATA_DIR: '/d' }),
    ).toThrow(/LOCAL_MODE/);
    expect(() => validateEnv({ ...LOCAL, AUTH_MODE: 'dev' })).toThrow(
      /AUTH_MODE/,
    );
  });

  it('refuses a missing or relative data folder and never echoes the value', () => {
    expect(() =>
      validateEnv({ AUTH_MODE: 'local', LOCAL_MODE: 'true' }),
    ).toThrow(/MOAT_DATA_DIR/);
    expect(() =>
      validateEnv({ ...LOCAL, MOAT_DATA_DIR: 'PLANTED/relative' }),
    ).toThrow(/^Invalid API environment: MOAT_DATA_DIR$/);
  });
});
