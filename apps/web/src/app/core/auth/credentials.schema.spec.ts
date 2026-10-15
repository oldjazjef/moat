import {
  codeSchema,
  emailSchema,
  nameSchema,
  newPasswordSchema,
} from './credentials.schema';

describe("credential schemas (the API's bounds)", () => {
  it('counts a password in characters, 12 to 256', () => {
    expect(newPasswordSchema.safeParse('x'.repeat(11)).success).toBe(false);
    expect(newPasswordSchema.safeParse('x'.repeat(12)).success).toBe(true);
    expect(newPasswordSchema.safeParse('x'.repeat(256)).success).toBe(true);
    expect(newPasswordSchema.safeParse('x'.repeat(257)).success).toBe(false);
    // Twelve emoji are twelve characters, not twenty-four.
    expect(newPasswordSchema.safeParse('🔑'.repeat(12)).success).toBe(true);
  });

  it('accepts an address with a dotted domain only', () => {
    expect(emailSchema.safeParse(' eme@example.ch ').success).toBe(true);
    for (const bad of [
      '',
      'eme',
      'eme@host',
      '@example.ch',
      'a b@example.ch',
    ]) {
      expect(emailSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('wants a code and a name to be there, and not absurdly long', () => {
    expect(codeSchema.safeParse('  ').success).toBe(false);
    expect(codeSchema.safeParse('123456').success).toBe(true);
    expect(nameSchema.safeParse('x'.repeat(401)).success).toBe(false);
    expect(nameSchema.safeParse('Muster AG').success).toBe(true);
  });
});
