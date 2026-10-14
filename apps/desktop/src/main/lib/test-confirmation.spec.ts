import { gateTestConfirmation } from './test-confirmation';

describe('gateTestConfirmation (T-59)', () => {
  it('asks once per origin and remembers only a yes', async () => {
    const answers = [false, true];
    const shown: string[] = [];
    const confirm = gateTestConfirmation(async (origin, host) => {
      shown.push(`${origin} ${host}`);
      return answers.shift() ?? false;
    });
    const target = 'https://www.example.ch/moat-gate.php/newsletter';
    expect(await confirm(target)).toBe(false);
    expect(await confirm(target)).toBe(true);
    expect(await confirm('https://www.example.ch/other/chat')).toBe(true);
    expect(shown).toEqual([
      'https://www.example.ch www.example.ch',
      'https://www.example.ch www.example.ch',
    ]);
    // Another port is another origin: asked again (and refused here).
    expect(await confirm('https://www.example.ch:8443/moat-gate.php/x')).toBe(
      false,
    );
  });

  it('refuses what is not a web address without asking', async () => {
    let asked = false;
    const confirm = gateTestConfirmation(async () => (asked = true));
    expect(await confirm('file:///etc/passwd')).toBe(false);
    expect(await confirm('not a url')).toBe(false);
    expect(asked).toBe(false);
  });
});
