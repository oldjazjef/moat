import { desktopApiEnv } from './api-env';

describe('desktopApiEnv', () => {
  it('runs the API in local mode with the desktop data folder', () => {
    expect(desktopApiEnv('/home/me/.config/Moat', true)).toEqual({
      NODE_ENV: 'production',
      AUTH_MODE: 'local',
      LOCAL_MODE: 'true',
      MOAT_DATA_DIR: '/home/me/.config/Moat',
      MOAT_GATE_TEST_LOOPBACK: 'false',
    });
  });

  it('lets «Testen» reach this computer only when unpackaged (T-59)', () => {
    expect(
      desktopApiEnv('/home/me/.config/Moat', false).MOAT_GATE_TEST_LOOPBACK,
    ).toBe('true');
  });
});
