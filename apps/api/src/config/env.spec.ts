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

    describe('SMTP', () => {
      const SMTP = {
        ...CLOUD,
        MOAT_SMTP_HOST: 'smtp.example.org',
        MOAT_MAIL_FROM: 'noreply@example.org',
        MOAT_PUBLIC_URL: 'https://moat.example.org',
      };

      it('is off without a host, and on with a sender and a public URL', () => {
        expect(validateEnv(CLOUD).MOAT_SMTP_HOST).toBeUndefined();
        expect(validateEnv(SMTP).MOAT_SMTP_SECURITY).toBe('starttls');
      });

      it('needs the sender and the public URL once there is a host, and a host once there is a port or a user', () => {
        expect(() =>
          validateEnv({ ...SMTP, MOAT_MAIL_FROM: undefined }),
        ).toThrow(/MOAT_MAIL_FROM/);
        expect(() =>
          validateEnv({ ...SMTP, MOAT_PUBLIC_URL: undefined }),
        ).toThrow(/MOAT_PUBLIC_URL/);
        expect(() => validateEnv({ ...CLOUD, MOAT_SMTP_PORT: '25' })).toThrow(
          /MOAT_SMTP_HOST/,
        );
      });

      it('wants both user and password or neither, and a port that exists', () => {
        expect(() => validateEnv({ ...SMTP, MOAT_SMTP_USER: 'u' })).toThrow(
          /MOAT_SMTP_USER/,
        );
        expect(
          validateEnv({ ...SMTP, MOAT_SMTP_USER: 'u', MOAT_SMTP_PASSWORD: 'p' })
            .MOAT_SMTP_USER,
        ).toBe('u');
        expect(() => validateEnv({ ...SMTP, MOAT_SMTP_PORT: '70000' })).toThrow(
          /MOAT_SMTP_PORT/,
        );
      });

      it('allows no TLS only for a server on this machine, and no http link in production', () => {
        expect(() =>
          validateEnv({ ...SMTP, MOAT_SMTP_SECURITY: 'none' }),
        ).toThrow(/MOAT_SMTP_SECURITY/);
        expect(
          validateEnv({
            ...SMTP,
            MOAT_SMTP_HOST: '127.0.0.1',
            MOAT_SMTP_SECURITY: 'none',
          }).MOAT_SMTP_SECURITY,
        ).toBe('none');
        const http = { ...SMTP, MOAT_PUBLIC_URL: 'http://localhost:4200' };
        expect(validateEnv(http).MOAT_PUBLIC_URL).toBe('http://localhost:4200');
        expect(() => validateEnv({ ...http, NODE_ENV: 'production' })).toThrow(
          /MOAT_PUBLIC_URL/,
        );
      });

      it('never puts a value in the error', () => {
        try {
          validateEnv({
            ...SMTP,
            MOAT_SMTP_USER: 'someone',
            MOAT_SMTP_PASSWORD: undefined,
          });
          throw new Error('should have thrown');
        } catch (error) {
          expect(String(error)).not.toContain('someone');
          expect(String(error)).not.toContain('smtp.example.org');
        }
      });
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
