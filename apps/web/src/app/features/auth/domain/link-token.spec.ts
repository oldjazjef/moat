import { tokenFromFragment } from './link-token';

const TOKEN = 'abcDEF0123456789_-abcDEF0123456789_-abcDEF0123456789_-'.slice(
  0,
  43,
);

describe('tokenFromFragment', () => {
  it('takes the token of a mailed link', () => {
    expect(TOKEN).toHaveLength(43);
    expect(tokenFromFragment(`token=${TOKEN}`)).toBe(TOKEN);
  });

  it('knows nothing for a missing, short, long or foreign value', () => {
    for (const fragment of [
      null,
      '',
      'token=',
      'token=short',
      `token=${TOKEN}x`,
      `other=${TOKEN}`,
      `token=${TOKEN.slice(0, 42)}!`,
    ])
      expect(tokenFromFragment(fragment)).toBeNull();
  });
});
