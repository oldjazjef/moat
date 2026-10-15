import { HttpClient, httpResource } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { OrganisationEntry } from '../../../../core/auth/account.types';
import { ActiveOrganisation } from '../../../../core/auth/active-organisation.service';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { nameSchema } from '../../../../core/auth/credentials.schema';
import { apiUrl } from '../../../../core/config/runtime-env';
import { zodValidator } from '../../../../core/forms/zod-validator';

/**
 * «Organisationen»: the organisations the account belongs to, with its role in each, a form for a
 * new one, and the switch — choosing one remembers it for the sidebar and opens its projects.
 * What the account may do inside is the API's answer (`access`), shown, never assumed.
 */
@Injectable()
export class OrganisationsPageService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  readonly active = inject(ActiveOrganisation);

  readonly list = httpResource<readonly OrganisationEntry[]>(() =>
    apiUrl('/orgs'),
  );

  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(nameSchema)],
    }),
  });
  readonly busy = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);

  async create(): Promise<void> {
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    try {
      const created = await firstValueFrom(
        this.http.post<OrganisationEntry>(apiUrl('/orgs'), {
          name: this.form.getRawValue().name.trim(),
        }),
      );
      this.form.reset();
      await this.open(created.organisation.id);
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Switch to an organisation: it becomes the one the sidebar shows, and its projects open. */
  async open(id: string): Promise<void> {
    this.active.set(id);
    await this.router.navigate(['/app/organisations', id, 'projects']);
  }
}
