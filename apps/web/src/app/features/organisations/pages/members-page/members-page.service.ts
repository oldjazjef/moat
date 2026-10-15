import { HttpClient, httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { firstValueFrom, type Observable } from 'rxjs';
import {
  type MemberView,
  RELEASE_ROLES,
  ROLES,
  type Role,
} from '../../../../core/auth/account.types';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { emailSchema } from '../../../../core/auth/credentials.schema';
import { apiUrl } from '../../../../core/config/runtime-env';
import { zodValidator } from '../../../../core/forms/zod-validator';
import { OrgScope } from '../../org-scope';

/**
 * «Mitglieder»: who belongs to the organisation, with role and the separate release permission
 * (SEC-52). Adding by address answers the same whether or not an account has that address (T-79),
 * so the page says only "if it exists". Which role the person may give or take is the API's rule:
 * its refusal (`forbidden`, `last_owner`, …) is shown with a translated text, never its own words.
 * The release switch is offered to Owners only, and only for roles that can hold it.
 */
@Injectable()
export class MembersPageService {
  private readonly http = inject(HttpClient);
  readonly scope = inject(OrgScope);

  readonly roles = ROLES;
  readonly members = httpResource<{ readonly members: readonly MemberView[] }>(
    () => {
      const id = this.scope.orgId();
      return id === null
        ? undefined
        : apiUrl(`/orgs/${encodeURIComponent(id)}/members`);
    },
  );

  readonly addForm = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [zodValidator(emailSchema)],
    }),
    role: new FormControl<Role>('viewer', { nonNullable: true }),
  });

  readonly canManage = computed(() => this.scope.can('members:manage'));
  readonly canGrantRelease = computed(() => this.scope.can('release:grant'));

  readonly busy = signal(false);
  /** The API's refusal of the last change, shown above the table. */
  readonly error = signal<ApiErrorCode | null>(null);
  /** The address was sent; whether an account has it stays unsaid (T-79). */
  readonly addSent = signal(false);
  /** The member whose removal waits for the second click. */
  readonly confirmingRemove = signal<string | null>(null);

  /** Whether the release permission can be set for this role at all. */
  releaseApplies(role: Role): boolean {
    return RELEASE_ROLES.includes(role);
  }

  async add(): Promise<void> {
    this.begin();
    this.addSent.set(false);
    if (this.addForm.invalid) {
      this.addForm.markAllAsTouched();
      this.busy.set(false);
      return;
    }
    const { email, role } = this.addForm.getRawValue();
    await this.send(
      this.http.post(this.url(''), { email: email.trim(), role }),
      () => {
        this.addForm.patchValue({ email: '' });
        this.addForm.markAsUntouched();
        this.addSent.set(true);
      },
    );
  }

  async changeRole(member: MemberView, role: Role): Promise<void> {
    this.begin();
    if (role === member.role) return this.busy.set(false);
    await this.send(
      this.http.patch(this.url(`/${encodeURIComponent(member.accountId)}`), {
        role,
      }),
    );
  }

  async setRelease(member: MemberView, granted: boolean): Promise<void> {
    this.begin();
    await this.send(
      this.http.patch(this.url(`/${encodeURIComponent(member.accountId)}`), {
        releaseGranted: granted,
      }),
    );
  }

  askRemove(member: MemberView): void {
    this.confirmingRemove.set(member.accountId);
  }

  cancelRemove(): void {
    this.confirmingRemove.set(null);
  }

  async remove(member: MemberView): Promise<void> {
    this.begin();
    this.confirmingRemove.set(null);
    await this.send(
      this.http.delete(this.url(`/${encodeURIComponent(member.accountId)}`)),
    );
  }

  private url(suffix: string): string {
    const id = this.scope.orgId() ?? '';
    return apiUrl(`/orgs/${encodeURIComponent(id)}/members${suffix}`);
  }

  private begin(): void {
    this.busy.set(true);
    this.error.set(null);
  }

  private async send(
    request: Observable<unknown>,
    onDone?: () => void,
  ): Promise<void> {
    try {
      await firstValueFrom(request);
      onDone?.();
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      // The list and the caller's own access may both have changed (e.g. their own role).
      this.members.reload();
      this.scope.entry.reload();
      this.busy.set(false);
    }
  }
}
