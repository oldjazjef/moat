import { FormControl } from '@angular/forms';
import { z } from 'zod';
import { zodValidator } from './zod-validator';

describe('zodValidator', () => {
  const validator = zodValidator(z.string().min(3));

  it('accepts what the schema parses and refuses the rest', () => {
    expect(validator(new FormControl('abc'))).toBeNull();
    expect(validator(new FormControl('ab'))).toEqual({ schema: true });
  });

  it('puts no value into the error (a password must not leak through it)', () => {
    const error = validator(new FormControl('zq'));
    expect(JSON.stringify(error)).not.toContain('zq');
  });
});
