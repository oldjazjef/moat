import {
  compareVersions,
  latestVersionOf,
  releasePageOf,
  updateCheckOf,
} from './update-check';

const answer = (tag: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    tag_name: tag,
    html_url: 'https://evil.example/',
    ...extra,
  });

describe('update check (show, never install)', () => {
  it('reads only a plain vX.Y.Z release', () => {
    expect(latestVersionOf(answer('v1.2.3'))).toBe('1.2.3');
    for (const tag of ['1.2.3', 'v1.2', 'v1.2.3-rc1', 'v1.2.3 ', 42])
      expect(latestVersionOf(answer(tag))).toBeNull();
    expect(latestVersionOf(answer('v1.2.3', { draft: true }))).toBeNull();
    expect(latestVersionOf(answer('v1.2.3', { prerelease: true }))).toBeNull();
    expect(latestVersionOf('not json')).toBeNull();
    expect(latestVersionOf('null')).toBeNull();
  });

  it('compares versions as numbers', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(compareVersions('x', '1.0.0')).toBeNull();
  });

  it('says whether a newer release exists', () => {
    expect(updateCheckOf('0.0.1', answer('v0.0.2'))).toEqual({
      status: 'available',
      current: '0.0.1',
      latest: '0.0.2',
    });
    expect(updateCheckOf('0.0.2', answer('v0.0.2')).status).toBe('current');
    expect(updateCheckOf('0.0.3', answer('v0.0.2')).status).toBe('current');
    expect(updateCheckOf('0.0.1', null).status).toBe('failed');
    expect(updateCheckOf('0.0.0', answer('v9.9.9')).status).toBe('development');
  });

  it('builds the release page itself, never taking an address from the answer', () => {
    expect(releasePageOf('1.2.3')).toBe(
      'https://github.com/oldjazjef/moat/releases/tag/v1.2.3',
    );
    expect(releasePageOf('1.2.3/../../evil')).toBeNull();
  });
});
