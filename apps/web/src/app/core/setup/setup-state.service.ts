import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { type CanActivateChildFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { SetupView } from '../api/setup.types';
import { apiUrl, isCloud } from '../config/runtime-env';

/**
 * The setup wizard's state for the whole app (FR-73): whether it is finished. Until then the
 * guard opens the wizard instead of any other page and the shell hides the main navigation.
 */
@Injectable({ providedIn: 'root' })
export class SetupStateService {
  private readonly http = inject(HttpClient);
  private readonly current = signal<SetupView | null>(null);
  private loading: Promise<SetupView | null> | null = null;

  readonly view = this.current.asReadonly();
  /** Known and not finished yet. */
  readonly incomplete = computed(() => this.current()?.complete === false);

  /** The wizard's state (cached; `force` reloads). `null` when the API cannot be reached. */
  load(force = false): Promise<SetupView | null> {
    const known = this.current();
    if (known && !force) return Promise.resolve(known);
    this.loading ??= firstValueFrom(this.http.get<SetupView>(apiUrl('/setup')))
      .then((view) => {
        this.current.set(view);
        return view;
      })
      .catch(() => null)
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  set(view: SetupView): void {
    this.current.set(view);
  }
}

/** Pages open while the wizard is not finished: the wizard itself and the guide (FR-70). */
export const OPEN_DURING_SETUP = ['/app/setup', '/app/help'];

/**
 * FR-73: while the wizard is not finished, every page of /app opens the wizard instead —
 * except the help. If the API cannot be reached the app opens normally (and shows that error).
 */
export const setupGuard: CanActivateChildFn = async (_route, state) => {
  // The wizard sets up Moat Desktop (key file, project folder); the Cloud has none.
  if (isCloud()) return true;
  const path = state.url.split(/[?#]/)[0] ?? '';
  if (
    OPEN_DURING_SETUP.some(
      (open) => path === open || path.startsWith(`${open}/`),
    )
  ) {
    return true;
  }
  const setup = inject(SetupStateService);
  const router = inject(Router);
  const view = await setup.load();
  return !view || view.complete ? true : router.createUrlTree(['/app/setup']);
};
