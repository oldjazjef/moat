import type {
  AbstractControl,
  ValidationErrors,
  ValidatorFn,
} from '@angular/forms';
import type { ZodType } from 'zod';

/**
 * A reactive-forms validator from a Zod schema (typed forms + Zod, CLAUDE.md): the control is
 * valid when its value parses. The error carries no value (a password must not end up in an
 * error object), only that the schema refused it.
 */
export function zodValidator(schema: ZodType): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null =>
    schema.safeParse(control.value).success ? null : { schema: true };
}
