import { HttpClient, httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AccountSession } from '../../../../core/auth/account-session.service';
import type { OidcProviderView } from '../../../../core/auth/account.types';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { currentPasswordSchema } from '../../../../core/auth/credentials.schema';
import { PageNavigation } from '../../../../core/auth/page-navigation';
import { apiUrl } from '../../../../core/config/runtime-env';
import { zodValidator } from '../../../../core/forms/zod-validator';

/**
 * «Single Sign-on» on the account page: which providers are linked, and linking another. Linking
 * asks for the password again (a signed-in session alone must not be able to attach someone else's
 * provider account), then the browser leaves for the provider and comes back with `?sso=…`.
 */
@Injectable()
export class SsoSectionService {
  private readonly http = inject(HttpClient);
  private readonly session = inject(AccountSession);
  private readonly navigation = inject(PageNavigation);

  readonly providers = httpResource<{
    readonly providers: readonly OidcProviderView[];
  }>(() => apiUrl('/auth/oidc/providers'));

  readonly linked = computed(() => this.session.account()?.identities ?? []);
  readonly hasPassword = computed(
    () => this.session.account()?.hasPassword === true,
  );
  /** Providers not linked yet. */
  readonly linkable = computed(() =>
    this.providers.hasValue()
      ? this.providers
          .value()
          .providers.filter((p) => !this.linked().includes(p.id))
      : [],
  );
  readonly nameOf = (id: string): string =>
    (this.providers.hasValue()
      ? this.providers.value().providers.find((p) => p.id === id)?.name
      : undefined) ?? id;

  /** The provider whose link waits for the password. */
  readonly linking = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);

  readonly form = new FormGroup({
    password: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(currentPasswordSchema)],
    }),
  });

  askLink(id: string): void {
    this.error.set(null);
    this.form.reset();
    this.linking.set(id);
  }

  cancel(): void {
    this.linking.set(null);
    this.form.reset();
  }

  /** Password → the address at the provider → the browser goes there. */
  async link(): Promise<void> {
    const id = this.linking();
    if (id === null) return;
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      const answer = await firstValueFrom(
        this.http.post<{ url: string }>(
          apiUrl(`/auth/oidc/${encodeURIComponent(id)}/link`),
          { password: this.form.getRawValue().password },
        ),
      );
      this.form.reset();
      this.navigation.go(answer.url);
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }
}
