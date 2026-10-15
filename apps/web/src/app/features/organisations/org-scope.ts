import { httpResource } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { Action, OrganisationEntry } from '../../core/auth/account.types';
import { ActiveOrganisation } from '../../core/auth/active-organisation.service';
import { apiUrl } from '../../core/config/runtime-env';

/**
 * The organisation of the open page (`/app/organisations/:orgId/…`): its name and what the
 * account may do in it, as the API answers (`GET /orgs/:id`). A foreign or unknown id is the same
 * 404 (SEC-50), shown as one message. The UI only hides what the API would refuse — the API
 * decides.
 */
@Injectable()
export class OrgScope {
  private readonly active = inject(ActiveOrganisation);
  private readonly source = signal<(() => string) | null>(null);
  /** The page's `:orgId`; null until the page has bound its input. */
  readonly orgId = computed(() => this.source()?.() ?? null);

  /** The page hands over its route input (read lazily, when the first request is made). */
  bind(orgId: () => string): void {
    this.source.set(orgId);
  }

  readonly entry = httpResource<OrganisationEntry>(() => {
    const id = this.orgId();
    return id === null ? undefined : apiUrl(`/orgs/${encodeURIComponent(id)}`);
  });

  readonly name = computed(() =>
    this.entry.hasValue() ? this.entry.value().organisation.name : null,
  );
  readonly access = computed(() =>
    this.entry.hasValue() ? this.entry.value().access : null,
  );

  constructor() {
    // A page that opened proves the organisation exists for this account: the sidebar follows.
    effect(() => {
      if (this.entry.hasValue()) {
        this.active.set(this.entry.value().organisation.id);
      }
    });
  }

  /** The API listed this permission for the account (not a guess from the role). */
  can(action: Action): boolean {
    return this.access()?.permissions.includes(action) === true;
  }
}
