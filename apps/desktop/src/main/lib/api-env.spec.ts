import { desktopApiEnv } from './api-env';

describe('desktopApiEnv', () => {
  it('runs the API in local mode with the desktop data folder', () => {
    expect(desktopApiEnv('/home/me/.config/Moat')).toEqual({
      NODE_ENV: 'production',
      AUTH_MODE: 'local',
      LOCAL_MODE: 'true',
      MOAT_DATA_DIR: '/home/me/.config/Moat',
    });
  });
});
