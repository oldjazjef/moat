import { describe, expect, it } from 'vitest';
import { DevInProductionError, devEnvironment } from '../cloud-dev-env';
import {
  assertRunMode,
  resolveSecretFiles,
  serverSettings,
} from './server-settings';

describe('serverSettings', () => {
  const base = { MOAT_WEB_DIR: '/app/web' };

  it('defaults to the loopback address and port 3000', () => {
    expect(serverSettings(base)).toEqual({
      host: '127.0.0.1',
      port: 3000,
      webDir: '/app/web',
    });
    expect(
      serverSettings({ ...base, HOST: '0.0.0.0', PORT: '8080' }),
    ).toMatchObject({ host: '0.0.0.0', port: 8080 });
  });

  it.each([
    [{ HOST: 'example.org' }, 'HOST'],
    [{ HOST: '0.0.0.0; rm' }, 'HOST'],
    [{ PORT: '0' }, 'PORT'],
    [{ PORT: '70000' }, 'PORT'],
    [{ PORT: '80a' }, 'PORT'],
    [{ PORT: '-1' }, 'PORT'],
    [{ MOAT_WEB_DIR: 'web' }, 'MOAT_WEB_DIR'],
    [{ MOAT_WEB_DIR: '' }, 'MOAT_WEB_DIR'],
  ])('refuses %j, naming only %s', (extra, name) => {
    let message = '';
    try {
      serverSettings({ ...base, ...extra });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`Invalid server environment: ${name}`);
  });

  it('requires the dashboard folder outside development, and allows its absence in development', () => {
    expect(() => serverSettings({})).toThrow(/MOAT_WEB_DIR/);
    expect(serverSettings({ MOAT_DEV: 'true' }).webDir).toBeUndefined();
  });
});

describe('assertRunMode', () => {
  it('runs only as NODE_ENV=production unless MOAT_DEV=true (a forgotten variable is not development)', () => {
    expect(() => assertRunMode({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertRunMode({})).toThrow(/NODE_ENV/);
    expect(() => assertRunMode({ NODE_ENV: 'development' })).toThrow(
      /NODE_ENV/,
    );
    expect(() => assertRunMode({ NODE_ENV: 'test' })).toThrow(/NODE_ENV/);
    expect(() => assertRunMode({ MOAT_DEV: 'true' })).not.toThrow();
  });

  it('the dev switch next to NODE_ENV=production is refused, not ignored (T-84)', () => {
    expect(() =>
      devEnvironment(
        { MOAT_DEV: 'true', NODE_ENV: 'production' },
        () => '/tmp/x',
        () => 'k',
      ),
    ).toThrow(DevInProductionError);
  });
});

describe('resolveSecretFiles', () => {
  const files: Record<string, string> = {
    '/run/secrets/key': 'KEYKEYKEY\n',
    '/run/secrets/url': 'postgresql://u:p@db/x\r\n',
  };
  const read = (path: string): string => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT ${path}`);
    return content;
  };

  it('reads NAME_FILE into NAME and removes one trailing newline', () => {
    expect(
      resolveSecretFiles(
        {
          MOAT_ACCOUNT_KEY_FILE: '/run/secrets/key',
          MOAT_DATABASE_URL_FILE: '/run/secrets/url',
        },
        read,
      ),
    ).toEqual({
      MOAT_ACCOUNT_KEY: 'KEYKEYKEY',
      MOAT_DATABASE_URL: 'postgresql://u:p@db/x',
    });
    expect(resolveSecretFiles({}, read)).toEqual({});
  });

  it('refuses both sources, a relative path and an unreadable file, without echoing a value', () => {
    expect(() =>
      resolveSecretFiles(
        { MOAT_ACCOUNT_KEY: 'x', MOAT_ACCOUNT_KEY_FILE: '/run/secrets/key' },
        read,
      ),
    ).toThrow('Invalid server environment: MOAT_ACCOUNT_KEY');
    expect(() =>
      resolveSecretFiles({ MOAT_ACCOUNT_KEY_FILE: 'secrets/key' }, read),
    ).toThrow('Invalid server environment: MOAT_ACCOUNT_KEY_FILE');
    let message = '';
    try {
      resolveSecretFiles({ MOAT_DATABASE_URL_FILE: '/nope/secret-path' }, read);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('Invalid server environment: MOAT_DATABASE_URL_FILE');
    expect(message).not.toContain('secret-path');
  });
});
