import { Injectable, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { AccountSession } from '../../../../core/auth/account-session.service';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import {
  emailSchema,
  newPasswordSchema,
} from '../../../../core/auth/credentials.schema';
import { zodValidator } from '../../../../core/forms/zod-validator';

/**
 * «Registrieren». The API answers 202 whether the address was new or taken (T-79), so the page
 * can only say that — it never claims an account exists, and it does not sign in. The password
 * is wiped from the form once it was sent.
 */
@Injectable()
export class RegisterPageService {
  private readonly session = inject(AccountSession);

  readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(emailSchema)],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(newPasswordSchema)],
    }),
    repeat: new FormControl('', { nonNullable: true }),
  });

  readonly busy = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);
  /** The request was accepted (not: "the account exists"). */
  readonly accepted = signal(false);
  readonly mismatch = signal(false);

  async submit(): Promise<void> {
    this.error.set(null);
    this.mismatch.set(false);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { email, password, repeat } = this.form.getRawValue();
    if (password !== repeat) {
      this.mismatch.set(true);
      return;
    }
    this.busy.set(true);
    try {
      await this.session.register(email.trim(), password);
      this.form.reset();
      this.accepted.set(true);
    } catch (error) {
      this.form.patchValue({ password: '', repeat: '' });
      this.error.set(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }
}
