import { Injectable, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { Router } from '@angular/router';
import { AccountSession } from '../../../../core/auth/account-session.service';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import {
  codeSchema,
  currentPasswordSchema,
  emailSchema,
} from '../../../../core/auth/credentials.schema';
import { zodValidator } from '../../../../core/forms/zod-validator';

/**
 * «Anmelden». The password lives in the form control while the page is open (the second step
 * needs it again) and nowhere else: not in a signal, a service field, storage or an error. Every
 * refusal is the API's uniform one — an unknown address and a wrong password read the same.
 */
@Injectable()
export class LoginPageService {
  private readonly session = inject(AccountSession);
  private readonly router = inject(Router);

  readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(emailSchema)],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(currentPasswordSchema)],
    }),
    code: new FormControl('', { nonNullable: true }),
  });

  /** The API asked for the second factor (`mfa_required`). */
  readonly needsCode = signal(false);
  readonly busy = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);

  async submit(): Promise<void> {
    this.error.set(null);
    const { email, password, code } = this.form.getRawValue();
    if (this.needsCode()) {
      if (!codeSchema.safeParse(code).success) {
        this.form.controls.code.markAsTouched();
        return;
      }
    } else if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      await this.session.login(
        email.trim(),
        password,
        this.needsCode() ? code.trim() : undefined,
      );
      this.form.reset();
      await this.router.navigate(['/app']);
    } catch (error) {
      this.fail(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Back from the code step to the password. */
  back(): void {
    this.needsCode.set(false);
    this.error.set(null);
    this.form.patchValue({ password: '', code: '' });
  }

  private fail(code: ApiErrorCode): void {
    if (code === 'mfa_required') {
      this.needsCode.set(true);
      this.form.patchValue({ code: '' });
      return;
    }
    if (code === 'invalid_code') {
      // Same step, same password: only the code was wrong.
      this.form.patchValue({ code: '' });
    } else {
      this.needsCode.set(false);
      this.form.patchValue({ password: '', code: '' });
    }
    this.error.set(code);
  }
}
