import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AccountSession } from '../../../../core/auth/account-session.service';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import {
  codeSchema,
  currentPasswordSchema,
  newPasswordSchema,
} from '../../../../core/auth/credentials.schema';
import { apiUrl } from '../../../../core/config/runtime-env';
import { zodValidator } from '../../../../core/forms/zod-validator';

/** What the secret step shows exactly once: the API never says it again. */
export interface TotpEnrolment {
  readonly secret: string;
  readonly otpauthUri: string;
}

type Section = 'password' | 'enrol' | 'confirm' | 'disable';

/**
 * «Konto»: password change and the second factor (TOTP) with its recovery codes. The shown secret
 * and the recovery codes sit in signals only as long as the person needs them: they are dropped
 * on «Erledigt», when the factor is disabled, and when the page closes. Passwords are read from
 * the forms, sent, and wiped — never kept.
 */
@Injectable()
export class AccountPageService {
  private readonly http = inject(HttpClient);
  private readonly session = inject(AccountSession);

  readonly account = this.session.account;

  readonly passwordForm = new FormGroup({
    current: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(currentPasswordSchema)],
    }),
    next: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(newPasswordSchema)],
    }),
    repeat: new FormControl('', { nonNullable: true }),
  });
  readonly enrolForm = new FormGroup({
    password: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(currentPasswordSchema)],
    }),
  });
  readonly confirmForm = new FormGroup({
    code: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(codeSchema)],
    }),
  });
  readonly disableForm = new FormGroup({
    password: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(currentPasswordSchema)],
    }),
    code: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(codeSchema)],
    }),
  });

  readonly busy = signal<Section | null>(null);
  readonly errors = signal<Partial<Record<Section, ApiErrorCode>>>({});
  readonly passwordMismatch = signal(false);
  readonly passwordChanged = signal(false);
  /** Between «Einrichten» and the first valid code. */
  readonly enrolment = signal<TotpEnrolment | null>(null);
  /** Shown once after the confirmation. */
  readonly recoveryCodes = signal<readonly string[] | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.forget());
  }

  async changePassword(): Promise<void> {
    this.begin('password');
    this.passwordChanged.set(false);
    this.passwordMismatch.set(false);
    const form = this.passwordForm;
    if (form.invalid) {
      form.markAllAsTouched();
      return this.end();
    }
    const { current, next, repeat } = form.getRawValue();
    if (next !== repeat) {
      this.passwordMismatch.set(true);
      return this.end();
    }
    try {
      const answer = await firstValueFrom(
        this.http.post<{ csrfToken: string }>(apiUrl('/auth/password'), {
          currentPassword: current,
          newPassword: next,
        }),
      );
      // The old session is gone; the cookie of the new one came with the answer.
      this.session.adoptCsrf(answer.csrfToken);
      form.reset();
      this.passwordChanged.set(true);
    } catch (error) {
      form.patchValue({ current: '', next: '', repeat: '' });
      this.fail('password', error);
    }
    this.end();
  }

  async startEnrolment(): Promise<void> {
    this.begin('enrol');
    if (this.enrolForm.invalid) {
      this.enrolForm.markAllAsTouched();
      return this.end();
    }
    try {
      const answer = await firstValueFrom(
        this.http.post<TotpEnrolment>(apiUrl('/auth/totp/enrol'), {
          password: this.enrolForm.getRawValue().password,
        }),
      );
      this.enrolment.set({
        secret: answer.secret,
        otpauthUri: answer.otpauthUri,
      });
      this.enrolForm.reset();
    } catch (error) {
      this.enrolForm.reset();
      this.fail('enrol', error);
    }
    this.end();
  }

  async confirmEnrolment(): Promise<void> {
    this.begin('confirm');
    if (this.confirmForm.invalid) {
      this.confirmForm.markAllAsTouched();
      return this.end();
    }
    try {
      const answer = await firstValueFrom(
        this.http.post<{ recoveryCodes: readonly string[] }>(
          apiUrl('/auth/totp/confirm'),
          { code: this.confirmForm.getRawValue().code.trim() },
        ),
      );
      this.enrolment.set(null);
      this.recoveryCodes.set(answer.recoveryCodes);
      this.session.setTotp(true);
    } catch (error) {
      this.fail('confirm', error);
    }
    this.confirmForm.reset();
    this.end();
  }

  /** «Erledigt»: the recovery codes are gone from the page for good. */
  codesSaved(): void {
    this.recoveryCodes.set(null);
  }

  /** The person leaves enrolment half way: the secret is dropped (a new one needs the password). */
  cancelEnrolment(): void {
    this.enrolment.set(null);
    this.confirmForm.reset();
  }

  async disable(): Promise<void> {
    this.begin('disable');
    if (this.disableForm.invalid) {
      this.disableForm.markAllAsTouched();
      return this.end();
    }
    const { password, code } = this.disableForm.getRawValue();
    try {
      await firstValueFrom(
        this.http.post(apiUrl('/auth/totp/disable'), {
          password,
          code: code.trim(),
        }),
      );
      this.session.setTotp(false);
      this.recoveryCodes.set(null);
    } catch (error) {
      this.fail('disable', error);
    }
    this.disableForm.reset();
    this.end();
  }

  private forget(): void {
    this.enrolment.set(null);
    this.recoveryCodes.set(null);
    this.passwordForm.reset();
    this.enrolForm.reset();
    this.confirmForm.reset();
    this.disableForm.reset();
  }

  private begin(section: Section): void {
    this.busy.set(section);
    this.errors.update((errors) => ({ ...errors, [section]: undefined }));
  }

  private fail(section: Section, error: unknown): void {
    this.errors.update((errors) => ({
      ...errors,
      [section]: apiErrorCode(error),
    }));
  }

  private end(): void {
    this.busy.set(null);
  }
}
