import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCircleAlert,
  lucideCircleMinus,
  lucideCircle,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import type { ProjectView } from '../../../../core/api/project.types';
import type { SetupStepId } from '../../../../core/api/setup.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { desktopBridge } from '../../../../core/desktop/desktop-bridge';
import { HardeningCheck } from '../../../../shared/components/hardening-check';
import { RichText } from '../../../../shared/components/rich-text';
import { TrustModeBadge } from '../../../../shared/components/trust-mode-badge';
import { HelpLink } from '../../../help/components/help-link';
import { SetupPageService } from '../../pages/setup-page/setup-page.service';

/**
 * FR-73, step «Zusammenfassung»: every step with its state, the trust mode of the project's
 * gates and the hardening level — only what is in force (§1.5): «Signiert» once a gate is
 * pinned, and no hardening level at all, because only the gate's own check on the server can
 * tell it (SEC-49). In Moat Desktop, the check from outside (DT-07) can show that the gate's files
 * are readable from the internet, which is «Unsicher für Secrets» on its own.
 */
@Component({
  selector: 'mt-setup-summary-step',
  imports: [
    NgIcon,
    TranslatePipe,
    RichText,
    TrustModeBadge,
    HelpLink,
    HardeningCheck,
    ...HlmButtonImports,
  ],
  providers: [
    provideIcons({
      lucideCheck,
      lucideCircleAlert,
      lucideCircleMinus,
      lucideCircle,
    }),
  ],
  template: `
    <ul class="flex flex-col gap-2" data-summary-steps>
      @for (step of others(); track step.id) {
        <li
          class="flex flex-wrap items-center gap-2 text-sm"
          [attr.data-step-id]="step.id"
        >
          @switch (step.state) {
            @case ('done') {
              <ng-icon
                name="lucideCheck"
                size="16"
                class="text-[var(--trust-strong)]"
                aria-hidden="true"
              />
            }
            @case ('error') {
              <ng-icon
                name="lucideCircleAlert"
                size="16"
                class="text-destructive"
                aria-hidden="true"
              />
            }
            @case ('skipped') {
              <ng-icon
                name="lucideCircleMinus"
                size="16"
                class="text-muted-foreground"
                aria-hidden="true"
              />
            }
            @default {
              <ng-icon
                name="lucideCircle"
                size="16"
                class="text-muted-foreground"
                aria-hidden="true"
              />
            }
          }
          <span class="font-medium">{{
            'setup.steps.' + step.id + '.title' | translate
          }}</span>
          <span class="text-muted-foreground">{{
            'setup.state.' + step.state | translate
          }}</span>
          @if (step.state !== 'done') {
            <button
              hlmBtn
              variant="link"
              size="sm"
              type="button"
              class="h-auto p-0"
              (click)="open.emit(step.id)"
            >
              {{ 'setup.summary.open' | translate }}
            </button>
          }
        </li>
      }
    </ul>

    <div class="mt-6 grid gap-6 md:grid-cols-2">
      <section aria-labelledby="summary-trust" data-summary-trust>
        <h3 id="summary-trust" class="mb-2 text-sm font-semibold">
          {{ 'setup.summary.trust' | translate }}
        </h3>
        @if (hasGate()) {
          <mt-trust-mode-badge mode="signed" [detailed]="true" />
        } @else {
          <p class="text-muted-foreground text-sm" data-summary-no-gate>
            {{ 'setup.summary.noGate' | translate }}
          </p>
        }
      </section>
      <section aria-labelledby="summary-hardening" data-summary-hardening>
        <div class="mb-2 flex items-center gap-1">
          <h3 id="summary-hardening" class="text-sm font-semibold">
            {{ 'setup.summary.hardening' | translate }}
          </h3>
          <mt-help-link section="hardening" />
        </div>
        <p class="text-sm">
          {{ 'setup.summary.hardeningUnknown' | translate }}
        </p>
        <p class="text-muted-foreground mt-2 text-sm">
          <mt-rich-text [text]="'setup.summary.hardeningCheck' | translate" />
        </p>
      </section>
    </div>
    @if (outsideCheck(); as target) {
      <section class="mt-6" data-summary-outside>
        <p class="mb-3 text-sm">
          {{ 'setup.summary.hardeningOutside' | translate }}
        </p>
        <mt-hardening-check [project]="target.project" [gate]="target.gate" />
      </section>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SummaryStep {
  private readonly service = inject(SetupPageService);
  /** A step to go back to (not done yet). */
  readonly open = output<SetupStepId>();

  protected readonly others = computed(() =>
    this.service.steps().filter((step) => step.id !== 'summary'),
  );
  private readonly project = httpResource<ProjectView>(() => {
    const id = this.service.project();
    return id === null
      ? undefined
      : apiUrl(`/projects/${encodeURIComponent(id)}`);
  });
  /** A valid pinned gate in the chosen project; without a project, none is claimed (§1.5). */
  protected readonly hasGate = computed(() => {
    if (this.service.project() === null) return false;
    const view = this.project.hasValue() ? this.project.value() : null;
    return (view?.project?.gates ?? []).some((gate) => gate.status === 'valid');
  });
  /** The first pinned gate, for the check from outside (Moat Desktop only, DT-07). */
  protected readonly outsideCheck = computed(() => {
    const project = this.service.project();
    if (project === null || desktopBridge() === null) return null;
    const view = this.project.hasValue() ? this.project.value() : null;
    const gate = (view?.project?.gates ?? []).find(
      (entry) => entry.status === 'valid',
    );
    return gate === undefined ? null : { project, gate: gate.name };
  });
}
