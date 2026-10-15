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

  describe('AUTH_MODE=cloud', () => {
    const CLOUD = {
      AUTH_MODE: 'cloud',
      MOAT_DATA_DIR: '/var/lib/moat',
      MOAT_PUBLIC_ORIGIN: 'https://app.example.ch',
      MOAT_ACCOUNT_KEY: 'A'.repeat(43),
    };

    it('boots with an origin and an account key, secure cookies and the full password cost by default', () => {
      const env = validateEnv(CLOUD);
      expect(env.MOAT_COOKIE_SECURE).toBe('true');
      expect(env.MOAT_PASSWORD_COST).toBe('standard');
      expect(env.MOAT_DB_PROVIDER).toBe('sqlite');
    });

    it('refuses to boot without them, or with a malformed one (fail closed)', () => {
      for (const missing of ['MOAT_PUBLIC_ORIGIN', 'MOAT_ACCOUNT_KEY'])
        expect(() => validateEnv({ ...CLOUD, [missing]: undefined })).toThrow(
          new RegExp(missing),
        );
      for (const origin of [
        'http://app.example.ch',
        'https://app.example.ch/path',
        'https://',
        'javascript:alert(1)',
      ])
        expect(() =>
          validateEnv({ ...CLOUD, MOAT_PUBLIC_ORIGIN: origin }),
        ).toThrow(/MOAT_PUBLIC_ORIGIN/);
      expect(() =>
        validateEnv({ ...CLOUD, MOAT_ACCOUNT_KEY: 'short' }),
      ).toThrow(/^Invalid API environment: MOAT_ACCOUNT_KEY$/);
      expect(
        validateEnv({ ...CLOUD, MOAT_PUBLIC_ORIGIN: 'http://localhost:4200' }),
      ).toBeTruthy();
    });

    it('needs a database URL for PostgreSQL', () => {
      expect(() =>
        validateEnv({ ...CLOUD, MOAT_DB_PROVIDER: 'postgresql' }),
      ).toThrow(/MOAT_DATABASE_URL/);
      expect(
        validateEnv({
          ...CLOUD,
          MOAT_DB_PROVIDER: 'postgresql',
          MOAT_DATABASE_URL: 'postgresql://moat@db.example.ch/moat',
        }),
      ).toBeTruthy();
    });

    it('does not trust a caller: LOCAL_MODE=true is refused next to cloud', () => {
      expect(() => validateEnv({ ...CLOUD, LOCAL_MODE: 'true' })).toThrow(
        /LOCAL_MODE/,
      );
    });

    it('keeps development conveniences out of production', () => {
      const dev = {
        ...CLOUD,
        MOAT_COOKIE_SECURE: 'false',
        MOAT_PASSWORD_COST: 'fast',
      };
      expect(validateEnv(dev).MOAT_COOKIE_SECURE).toBe('false');
      expect(() => validateEnv({ ...dev, NODE_ENV: 'production' })).toThrow(
        /MOAT_COOKIE_SECURE, MOAT_PASSWORD_COST/,
      );
    });
  });
});
