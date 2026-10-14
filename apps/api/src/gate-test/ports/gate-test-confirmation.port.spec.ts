import { describe, expect, it } from 'vitest';
import { MainProcessConfirmation } from './gate-test-confirmation.port';

const TARGET = new URL('https://www.example.ch/moat-gate.php/newsletter');

describe('MainProcessConfirmation (T-59)', () => {
  it('refuses while the main process registered nothing', async () => {
    expect(await new MainProcessConfirmation().confirm(TARGET, 'en')).toBe(
      false,
    );
  });

  it('passes the address and language on and takes only a plain yes', async () => {
    const confirmation = new MainProcessConfirmation();
    const asked: string[] = [];
    confirmation.register(async (target, locale) => {
      asked.push(`${locale} ${target}`);
      return true;
    });
    expect(await confirmation.confirm(TARGET, 'de-CH')).toBe(true);
    expect(asked).toEqual([`de-CH ${TARGET.href}`]);
    confirmation.register(async () => 'yes' as unknown as boolean);
    expect(await confirmation.confirm(TARGET, 'en')).toBe(false);
    confirmation.register(async () => {
      throw new Error('window gone');
    });
    expect(await confirmation.confirm(TARGET, 'en')).toBe(false);
  });
});
