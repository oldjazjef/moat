import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AccountSession } from '../../../../core/auth/account-session.service';
import type { PasskeyView } from '../../../../core/auth/account.types';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { currentPasswordSchema } from '../../../../core/auth/credentials.schema';
import {
  PasskeyBrowser,
  PasskeyBrowserError,
  type PasskeyCreateOptions,
  type PasskeyProblem,
} from '../../../../core/auth/passkey-browser';
import { apiUrl } from '../../../../core/config/runtime-env';
import { zodValidator } from '../../../../core/forms/zod-validator';

/**
 * «Passkeys» on the account page: a second factor next to the authenticator app (SEC-51). Adding
 * and removing ask for the password again. The browser makes the key; Moat Cloud keeps its public
 * part. The password is read from the form, sent and wiped — never kept.
 */
@Injectable()
export class PasskeysSectionService {
  private readonly http = inject(HttpClient);
  private readonly session = inject(AccountSession);
  private readonly browser = inject(PasskeyBrowser);

  readonly supported = this.browser.supported;
  readonly passkeys = signal<readonly PasskeyView[] | null>(null);
  readonly loadFailed = signal(false);
  readonly busy = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);
  readonly problem = signal<PasskeyProblem | null>(null);
  /** The passkey whose removal waits for the password. */
  readonly removing = signal<string | null>(null);
  readonly added = signal(false);

  readonly addForm = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(currentPasswordSchema)],
    }),
  });
  readonly removeForm = new FormGroup({
    password: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(currentPasswordSchema)],
    }),
  });

  async load(): Promise<void> {
    try {
      const answer = await firstValueFrom(
        this.http.get<{ passkeys: readonly PasskeyView[] }>(
          apiUrl('/auth/passkeys'),
        ),
      );
      this.passkeys.set(answer.passkeys);
      this.session.setPasskeyCount(answer.passkeys.length);
    } catch {
      this.loadFailed.set(true);
    }
  }

  async add(): Promise<void> {
    this.begin();
    const { name, password } = this.addForm.getRawValue();
    if (this.addForm.invalid || name.trim() === '') {
      this.addForm.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      const options = await firstValueFrom(
        this.http.post<PasskeyCreateOptions>(apiUrl('/auth/passkeys/options'), {
          password,
        }),
      );
      const made = await this.browser.create(options);
      await firstValueFrom(
        this.http.post(apiUrl('/auth/passkeys'), {
          name: name.trim(),
          ...made,
        }),
      );
      this.addForm.reset();
      this.added.set(true);
      await this.load();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  askRemove(id: string): void {
    this.begin();
    this.removeForm.reset();
    this.removing.set(id);
  }

  cancelRemove(): void {
    this.removing.set(null);
    this.removeForm.reset();
  }

  async remove(): Promise<void> {
    const id = this.removing();
    if (id === null) return;
    this.begin();
    if (this.removeForm.invalid) {
      this.removeForm.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      await firstValueFrom(
        this.http.post(
          apiUrl(`/auth/passkeys/${encodeURIComponent(id)}/remove`),
          {
            password: this.removeForm.getRawValue().password,
          },
        ),
      );
      this.cancelRemove();
      await this.load();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  private begin(): void {
    this.error.set(null);
    this.problem.set(null);
    this.added.set(false);
  }

  private fail(error: unknown): void {
    if (error instanceof PasskeyBrowserError) this.problem.set(error.problem);
    else this.error.set(apiErrorCode(error));
  }
}
