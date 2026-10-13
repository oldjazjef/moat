import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import type { ProjectSummary } from '../../../../core/api/project.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { desktopBridge } from '../../../../core/desktop/desktop-bridge';
import { SetupPageService } from '../../pages/setup-page/setup-page.service';
import { provideSetupStep, SetupStepComponent } from '../setup-step';

/** `setup.project.notices.<notice>` */
export const PROJECT_NOTICES = ['failed', 'required', 'existing'] as const;
type Notice = (typeof PROJECT_NOTICES)[number] | null;

/**
 * FR-73, step «Erstes Projekt»: a new project (a folder with a new moat.yaml) or an existing
 * folder, both through the main process's folder dialog (DT-08). The project chosen here is the
 * one the gate step works on.
 */
@Component({
  selector: 'mt-setup-project-step',
  imports: [TranslatePipe, ...HlmButtonImports],
  providers: [provideSetupStep(() => ProjectStep)],
  template: `
    @if (projects().length > 0) {
      <fieldset class="flex flex-col gap-2" data-project-choices>
        <legend class="mb-2 text-sm font-medium">
          {{ 'setup.project.choose' | translate }}
        </legend>
        @for (project of projects(); track project.id) {
          <label class="mt-choice" [attr.data-project]="project.name">
            <input
              type="radio"
              name="project"
              [value]="project.id"
              [checked]="selected() === project.id"
              (change)="service.project.set(project.id)"
            />
            <span class="min-w-0">
              <span class="block font-medium">{{ project.name }}</span>
              <span class="mt-code text-muted-foreground block">{{
                project.folder
              }}</span>
            </span>
          </label>
        }
      </fieldset>
    } @else if (list.hasValue()) {
      <p class="text-sm" data-project-none>
        {{ 'setup.project.none' | translate }}
      </p>
    }
    @if (desktop) {
      <div class="mt-4 flex flex-wrap gap-2">
        <button
          hlmBtn
          type="button"
          data-project-create
          [variant]="projects().length > 0 ? 'outline' : 'default'"
          [disabled]="busy()"
          (click)="create()"
        >
          {{ 'setup.project.create' | translate }}
        </button>
        <button
          hlmBtn
          variant="outline"
          type="button"
          data-project-add
          [disabled]="busy()"
          (click)="add()"
        >
          {{ 'setup.project.add' | translate }}
        </button>
      </div>
      <p class="text-muted-foreground mt-3 text-sm">
        {{ 'setup.project.hint' | translate }}
      </p>
    }
    @if (notice(); as code) {
      <p
        class="mt-3 text-sm"
        [class.text-destructive]="code !== 'existing'"
        [class.text-muted-foreground]="code === 'existing'"
        role="status"
        data-project-notice
      >
        {{ 'setup.project.notices.' + code | translate }}
      </p>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectStep extends SetupStepComponent {
  protected readonly service = inject(SetupPageService);
  private readonly bridge = desktopBridge();
  protected readonly desktop = this.bridge !== null;
  protected readonly list = httpResource<readonly ProjectSummary[]>(() =>
    apiUrl('/projects'),
  );
  protected readonly projects = computed(() =>
    this.list.hasValue() ? this.list.value() : [],
  );
  /** The chosen project, or the first one when none was chosen (or it left the list). */
  protected readonly selected = computed(() => {
    const chosen = this.service.project();
    const projects = this.projects();
    return projects.some((project) => project.id === chosen)
      ? chosen
      : (projects[0]?.id ?? null);
  });
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice>(null);

  constructor() {
    super();
    effect(() => {
      const selected = this.selected();
      if (selected !== this.service.project())
        this.service.project.set(selected);
    });
  }

  protected async create(): Promise<void> {
    await this.run(async () => {
      const result = await this.bridge?.project.create();
      if (result?.status === 'added') {
        this.service.project.set(result.id);
        if (!result.created) this.notice.set('existing');
      }
      return result?.status !== 'failed';
    });
  }

  protected async add(): Promise<void> {
    await this.run(async () => {
      const result = await this.bridge?.project.add();
      if (result?.status === 'added') this.service.project.set(result.id);
      return result?.status !== 'failed';
    });
  }

  async submit(): Promise<boolean> {
    if (this.selected() !== null) return true;
    this.notice.set('required');
    return false;
  }

  private async run(action: () => Promise<boolean>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      if (!(await action())) this.notice.set('failed');
    } catch {
      this.notice.set('failed');
    } finally {
      this.busy.set(false);
      this.list.reload();
    }
  }
}
