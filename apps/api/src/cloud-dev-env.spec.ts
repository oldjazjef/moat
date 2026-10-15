import { DevInProductionError, devEnvironment } from './cloud-dev-env';
import { validateEnv } from './config/env';

const dir = () => '/tmp/moat-dev-cloud';
const key = () => 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU';

describe('devEnvironment (api:serve-cloud)', () => {
  it('does nothing without the explicit dev switch', () => {
    expect(devEnvironment({}, dir, key).values).toEqual({});
    expect(devEnvironment({ MOAT_DEV: '1' }, dir, key).values).toEqual({});
    expect(devEnvironment({ MOAT_DEV: 'TRUE' }, dir, key).values).toEqual({});
  });

  it('is refused in production, whatever else is set', () => {
    expect(() =>
      devEnvironment({ MOAT_DEV: 'true', NODE_ENV: 'production' }, dir, key),
    ).toThrow(DevInProductionError);
  });

  it('fills in a complete, valid Cloud environment for development', () => {
    const { values } = devEnvironment({ MOAT_DEV: 'true' }, dir, key);
    expect(values['MOAT_PASSWORD_COST']).toBe('fast');
    expect(values['MOAT_COOKIE_SECURE']).toBe('false');
    expect(() => validateEnv({ ...values })).not.toThrow();
  });

  it('never overrides what the developer set', () => {
    const { values } = devEnvironment(
      {
        MOAT_DEV: 'true',
        MOAT_PUBLIC_ORIGIN: 'http://localhost:9999',
        MOAT_PASSWORD_COST: 'standard',
      },
      dir,
      key,
    );
    expect(values['MOAT_PUBLIC_ORIGIN']).toBeUndefined();
    expect(values['MOAT_PASSWORD_COST']).toBeUndefined();
  });

  it('the production environment still refuses the cheap hash and an unsafe cookie', () => {
    const base = {
      AUTH_MODE: 'cloud',
      NODE_ENV: 'production',
      MOAT_DATA_DIR: '/var/lib/moat',
      MOAT_PUBLIC_ORIGIN: 'https://app.example.ch',
      MOAT_ACCOUNT_KEY: key(),
    };
    expect(() => validateEnv({ ...base, MOAT_PASSWORD_COST: 'fast' })).toThrow(
      /MOAT_PASSWORD_COST/,
    );
    expect(() => validateEnv({ ...base, MOAT_COOKIE_SECURE: 'false' })).toThrow(
      /MOAT_COOKIE_SECURE/,
    );
  });
});
