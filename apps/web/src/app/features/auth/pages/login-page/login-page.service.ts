import { Injectable, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { Router } from '@angular/router';
import { AccountSession } from '../../../../core/auth/account-session.service';
import type { MfaMethod } from '../../../../core/auth/account.types';
import {
  PasskeyBrowser,
  PasskeyBrowserError,
  type PasskeyProblem,
} from '../../../../core/auth/passkey-browser';
import {
  type ApiErrorCode,
  apiErrorCode,
  apiErrorMethods,
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
  private readonly browser = inject(PasskeyBrowser);

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
  /** Which factors the API named after the password was right. */
  readonly methods = signal<readonly MfaMethod[]>([]);
  /** The browser's side of a passkey sign-in went wrong (cancelled, unsupported, failed). */
  readonly passkeyProblem = signal<PasskeyProblem | null>(null);
  readonly busy = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);
  /** A new confirmation mail was asked for (the answer is the same for every address, T-79). */
  readonly resent = signal(false);

  async submit(): Promise<void> {
    this.error.set(null);
    this.resent.set(false);
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
      this.fail(apiErrorCode(error), apiErrorMethods(error));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Second step with a passkey: Moat Cloud makes a challenge (the password is checked again, as
   * for any sign-in), the browser signs it, and the assertion goes to `login`.
   */
  async usePasskey(): Promise<void> {
    this.error.set(null);
    this.passkeyProblem.set(null);
    const { email, password } = this.form.getRawValue();
    this.busy.set(true);
    try {
      const options = await this.session.passkeyChallenge(
        email.trim(),
        password,
      );
      const assertion = await this.browser.get(options);
      await this.session.login(email.trim(), password, undefined, assertion);
      this.form.reset();
      await this.router.navigate(['/app']);
    } catch (error) {
      if (error instanceof PasskeyBrowserError) {
        this.passkeyProblem.set(error.problem);
      } else {
        this.fail(apiErrorCode(error), apiErrorMethods(error));
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** Asks for a new confirmation mail for the address in the form. */
  async resend(): Promise<void> {
    const email = this.form.controls.email.value.trim();
    if (!emailSchema.safeParse(email).success) {
      this.form.controls.email.markAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      await this.session.resendVerification(email);
      this.error.set(null);
      this.resent.set(true);
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Back from the code step to the password. */
  back(): void {
    this.needsCode.set(false);
    this.methods.set([]);
    this.passkeyProblem.set(null);
    this.error.set(null);
    this.form.patchValue({ password: '', code: '' });
  }

  private fail(code: ApiErrorCode, methods: readonly MfaMethod[] = []): void {
    if (code === 'mfa_required') {
      this.needsCode.set(true);
      this.methods.set(methods);
      this.form.patchValue({ code: '' });
      return;
    }
    if (code === 'invalid_code') {
      // Same step, same password: only the code was wrong.
      this.form.patchValue({ code: '' });
    } else {
      this.needsCode.set(false);
      this.methods.set([]);
      this.form.patchValue({ password: '', code: '' });
    }
    this.error.set(code);
  }
}
