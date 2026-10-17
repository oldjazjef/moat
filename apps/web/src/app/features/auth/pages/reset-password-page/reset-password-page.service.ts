import { Injectable, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { AccountSession } from '../../../../core/auth/account-session.service';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { newPasswordSchema } from '../../../../core/auth/credentials.schema';
import { zodValidator } from '../../../../core/forms/zod-validator';
import { tokenFromFragment } from '../../domain/link-token';

/**
 * «Neues Passwort». The token comes from the mailed link's fragment. A password the API refuses
 * (too short) does not use the token up, so the person can try again; a used, expired or unknown
 * token is one plain `invalid_token`. The password is wiped from the form once it was sent.
 */
@Injectable()
export class ResetPasswordPageService {
  private readonly session = inject(AccountSession);
  private readonly token: string | null = tokenFromFragment(
    inject(ActivatedRoute).snapshot.fragment,
  );

  readonly hasToken = this.token !== null;
  readonly form = new FormGroup({
    password: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(newPasswordSchema)],
    }),
    repeat: new FormControl('', { nonNullable: true }),
  });
  readonly busy = signal(false);
  readonly done = signal(false);
  readonly mismatch = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);

  async submit(): Promise<void> {
    this.error.set(null);
    this.mismatch.set(false);
    if (this.token === null) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { password, repeat } = this.form.getRawValue();
    if (password !== repeat) {
      this.mismatch.set(true);
      return;
    }
    this.busy.set(true);
    try {
      await this.session.resetPassword(this.token, password);
      this.form.reset();
      this.done.set(true);
    } catch (error) {
      this.form.reset();
      this.error.set(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }
}
