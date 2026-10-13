import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ProjectSummary } from '../../../../core/api/project.types';
import {
  SETUP_STEPS,
  type SetupErrorCode,
  type SetupStep,
  type SetupStepId,
  type SetupView,
  type StepState,
  type UpdateSetupRequest,
} from '../../../../core/api/setup.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { SetupStateService } from '../../../../core/setup/setup-state.service';
import type { SetupStepComponent } from '../../components/setup-step';

/** `setup.errors.<code>`: the API's refusals and a save that failed. */
export const SETUP_ERRORS = [
  'step_required',
  'step_incomplete',
  'setup_incomplete',
  'save_failed',
] as const;

/**
 * The setup wizard (FR-73), as lazy-koins': which step is on screen, which ones may be opened
 * (visited ones), «Weiter» (the step checks itself, then its state is stored), «Später»
 * (optional steps only), «Zurück», deep links (`/app/setup?step=gate`) and «Fertig». The
 * progress lives in the API (`/api/setup`), so a closed wizard opens again where it was left.
 * The project chosen in «Erstes Projekt» is the one the gate step works on.
 */
@Injectable()
export class SetupPageService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly state = inject(SetupStateService);

  readonly view = this.state.view;
  readonly loading = signal(true);
  readonly loadFailed = signal(false);
  readonly busy = signal(false);
  /** The last save the API refused or that failed; shown above the footer. */
  readonly error = signal<(typeof SETUP_ERRORS)[number] | null>(null);
  readonly current = signal<SetupStepId>('language');
  /** The project the gate step and «Fertig» use (chosen or created in the project step). */
  readonly project = signal<string | null>(null);
  private readonly visited = signal<ReadonlySet<SetupStepId>>(new Set());

  readonly steps = computed<readonly SetupStep[]>(
    () => this.view()?.steps ?? [],
  );
  readonly index = computed(() =>
    this.steps().findIndex((step) => step.id === this.current()),
  );
  readonly step = computed(() => this.steps()[this.index()]);
  readonly isFirst = computed(() => this.index() <= 0);
  readonly isSummary = computed(() => this.current() === 'summary');
  readonly canSkip = computed(() => {
    const step = this.step();
    return step !== undefined && !step.required && step.id !== 'summary';
  });

  /** Loads the progress and opens `requested` (a deep link), else where it was left. */
  async init(requested?: string | null): Promise<void> {
    this.loading.set(true);
    const view = await this.state.load(true);
    this.loading.set(false);
    if (!view) {
      this.loadFailed.set(true);
      return;
    }
    this.loadFailed.set(false);
    const ids = view.steps.map((step) => step.id);
    const start =
      requested && (ids as string[]).includes(requested)
        ? (requested as SetupStepId)
        : ids.includes(view.currentStep)
          ? view.currentStep
          : (ids[0] ?? 'language');
    // Every step with a state counts as visited, and everything up to where it was left.
    const until = Math.max(ids.indexOf(view.currentStep), ids.indexOf(start));
    this.visited.set(
      new Set(
        view.steps
          .filter((step, i) => step.state !== 'open' || i <= until)
          .map((step) => step.id),
      ),
    );
    this.current.set(start);
    if (start !== view.currentStep) void this.patch({ currentStep: start });
    if (this.project() === null) await this.defaultProject();
  }

  /** Visited steps (and the current one) may be opened from the step bar. */
  canVisit(id: SetupStepId): boolean {
    return id === this.current() || this.visited().has(id);
  }

  goTo(id: SetupStepId): void {
    if (!this.canVisit(id) || id === this.current()) return;
    this.open(id);
  }

  back(): void {
    const previous = this.steps()[this.index() - 1];
    if (previous) this.open(previous.id);
  }

  /** «Weiter»: the step checks itself; then it is `done` and the next one opens. */
  async next(step: SetupStepComponent | undefined): Promise<boolean> {
    const current = this.step();
    if (!current || this.busy()) return false;
    this.busy.set(true);
    this.error.set(null);
    try {
      const ok = step ? await step.submit() : true;
      if (!ok) {
        await this.patch({ states: { [current.id]: 'error' } });
        return false;
      }
      const following = this.steps()[this.index() + 1];
      const saved = await this.patch(
        {
          states: { [current.id]: 'done' as StepState },
          ...(following ? { currentStep: following.id } : {}),
        },
        true,
      );
      if (!saved) return false;
      if (following) this.open(following.id, false);
      return true;
    } finally {
      this.busy.set(false);
    }
  }

  /** «Später» (optional steps): skipped, the next one opens. */
  async skip(): Promise<void> {
    const current = this.step();
    if (!current || !this.canSkip() || this.busy()) return;
    const following = this.steps()[this.index() + 1];
    this.busy.set(true);
    this.error.set(null);
    try {
      const saved = await this.patch(
        {
          states: { [current.id]: 'skipped' },
          ...(following ? { currentStep: following.id } : {}),
        },
        true,
      );
      if (saved && following) this.open(following.id, false);
    } finally {
      this.busy.set(false);
    }
  }

  /** «Fertig»: the wizard is finished; the chosen project (or the list) opens. */
  async finish(): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.error.set(null);
    try {
      const view = await firstValueFrom(
        this.http.post<SetupView>(apiUrl('/setup/complete'), null),
      );
      this.state.set(view);
      const project = this.project();
      await this.router.navigateByUrl(
        project === null ? '/app/projects' : `/app/projects/${project}`,
      );
      return true;
    } catch (error) {
      const code = codeOf(error);
      if (code === null) {
        // Not a refusal: the progress cannot be stored (full disk, read-only data folder).
        // Never lock the app behind the wizard for that: finished for this session.
        const view = this.view();
        if (view) this.state.set({ ...view, complete: true });
        this.error.set('save_failed');
        await this.router.navigateByUrl('/app/projects');
        return false;
      }
      this.error.set(code);
      const missing = missingOf(error);
      if (missing[0]) this.open(missing[0]);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Reopened at a later step: the gate step works on the first project of the list. */
  private async defaultProject(): Promise<void> {
    try {
      const projects = await firstValueFrom(
        this.http.get<readonly ProjectSummary[]>(apiUrl('/projects')),
      );
      if (this.project() === null) this.project.set(projects[0]?.id ?? null);
    } catch {
      // The project step lists them again.
    }
  }

  private open(id: SetupStepId, store = true): void {
    this.current.set(id);
    this.visited.update((visited) => new Set([...visited, id]));
    if (store) void this.patch({ currentStep: id });
  }

  /** Stores step states / the current step; with `report`, a refusal shows its reason. */
  private async patch(
    request: UpdateSetupRequest,
    report = false,
  ): Promise<boolean> {
    try {
      this.state.set(
        await firstValueFrom(
          this.http.patch<SetupView>(apiUrl('/setup'), request),
        ),
      );
      return true;
    } catch (error) {
      if (report) this.error.set(codeOf(error) ?? 'save_failed');
      return false;
    }
  }
}

const ERROR_CODES: readonly SetupErrorCode[] = [
  'step_required',
  'step_incomplete',
  'setup_incomplete',
];

function codeOf(error: unknown): SetupErrorCode | null {
  if (!(error instanceof HttpErrorResponse)) return null;
  const code = (error.error as { error?: unknown } | null)?.error;
  return ERROR_CODES.find((known) => known === code) ?? null;
}

function missingOf(error: unknown): SetupStepId[] {
  if (!(error instanceof HttpErrorResponse)) return [];
  const missing = (error.error as { missing?: unknown } | null)?.missing;
  return Array.isArray(missing)
    ? missing.filter((id): id is SetupStepId =>
        (SETUP_STEPS as readonly unknown[]).includes(id),
      )
    : [];
}
