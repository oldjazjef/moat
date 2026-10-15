import { apiUrl, isCloud, runtimeEnv } from './runtime-env';

describe('runtimeEnv', () => {
  afterEach(() => {
    delete window.__MT_ENV__;
    delete window.moatDesktop;
  });

  it('is Moat Desktop (no sign-in) unless env.js says exactly `cloud`', () => {
    expect(runtimeEnv().authMode).toBe('local');
    expect(isCloud()).toBe(false);
    for (const value of ['Cloud', 'true', 'cloud ', '', 'remote', undefined]) {
      window.__MT_ENV__ = { authMode: value as never };
      expect(isCloud()).toBe(false);
    }
    window.__MT_ENV__ = { authMode: 'cloud' };
    expect(isCloud()).toBe(true);
  });

  it('never shows a sign-in inside the desktop shell, whatever env.js says', () => {
    window.__MT_ENV__ = { authMode: 'cloud' };
    window.moatDesktop = {} as never;
    expect(isCloud()).toBe(false);
  });

  it('builds API urls from the base without a trailing slash', () => {
    window.__MT_ENV__ = { apiBaseUrl: 'https://app.example.ch//' };
    expect(apiUrl('/auth/me')).toBe('https://app.example.ch/api/auth/me');
  });
});
