import { desktopApiEnv } from './api-env';

describe('desktopApiEnv', () => {
  it('runs the API in local mode with the open project', () => {
    expect(desktopApiEnv('/home/me/site')).toEqual({
      set: {
        NODE_ENV: 'production',
        AUTH_MODE: 'local',
        LOCAL_MODE: 'true',
        MOAT_PROJECT_DIR: '/home/me/site',
      },
      unset: [],
    });
  });

  it('removes an inherited MOAT_PROJECT_DIR when no project is open', () => {
    expect(desktopApiEnv(null).unset).toEqual(['MOAT_PROJECT_DIR']);
    expect(desktopApiEnv(null).set).not.toHaveProperty('MOAT_PROJECT_DIR');
  });
});
