import { HttpClient, httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { OrgProjectView } from '../../../../core/auth/account.types';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { nameSchema } from '../../../../core/auth/credentials.schema';
import { apiUrl } from '../../../../core/config/runtime-env';
import { zodValidator } from '../../../../core/forms/zod-validator';
import { OrgScope } from '../../org-scope';

/**
 * «Projekte» of an organisation: the list, and a form for a new one when the API granted
 * `project:create`. A project here is a name only (this slice); gates, routes and secrets of a
 * Cloud project are not built yet and the page does not suggest otherwise.
 */
@Injectable()
export class OrgProjectsPageService {
  private readonly http = inject(HttpClient);
  readonly scope = inject(OrgScope);

  readonly projects = httpResource<{
    readonly projects: readonly OrgProjectView[];
  }>(() => {
    const id = this.scope.orgId();
    return id === null
      ? undefined
      : apiUrl(`/orgs/${encodeURIComponent(id)}/projects`);
  });

  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(nameSchema)],
    }),
  });

  readonly canCreate = computed(() => this.scope.can('project:create'));
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
      const id = encodeURIComponent(this.scope.orgId() ?? '');
      await firstValueFrom(
        this.http.post(apiUrl(`/orgs/${id}/projects`), {
          name: this.form.getRawValue().name.trim(),
        }),
      );
      this.form.reset();
      this.projects.reload();
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }
}
