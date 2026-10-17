import { Injectable, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { AccountSession } from '../../../../core/auth/account-session.service';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { emailSchema } from '../../../../core/auth/credentials.schema';
import { zodValidator } from '../../../../core/forms/zod-validator';

/**
 * «Passwort vergessen». The API answers 202 for every address (T-79), so the page can only say
 * that a mail is on its way *if* the address has an account — never that it has one.
 */
@Injectable()
export class ForgotPasswordPageService {
  private readonly session = inject(AccountSession);

  readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(emailSchema)],
    }),
  });
  readonly busy = signal(false);
  readonly accepted = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);

  async submit(): Promise<void> {
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      await this.session.forgotPassword(this.form.controls.email.value.trim());
      this.accepted.set(true);
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }
}
