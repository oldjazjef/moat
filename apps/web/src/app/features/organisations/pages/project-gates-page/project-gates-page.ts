import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  signal,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { TrustModeBadge } from '../../../../shared/components/trust-mode-badge';
import { PageHeader } from '../../../../shared/components/page-header';
import { HelpLink } from '../../../help/components/help-link';
import { OrgTabs } from '../../components/org-tabs';
import { ProjectTabs } from '../../components/project-tabs';
import { OrgScope } from '../../org-scope';
import { ProjectGatesPageService } from './project-gates-page.service';

@Component({
  selector: 'mt-project-gates-page',
  imports: [
    ReactiveFormsModule,
    NgIcon,
    TranslatePipe,
    PageHeader,
    HelpLink,
    OrgTabs,
    ProjectTabs,
    TrustModeBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [
    OrgScope,
    ProjectGatesPageService,
    provideIcons({ lucideTriangleAlert }),
  ],
  templateUrl: './project-gates-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectGatesPage {
  readonly orgId = input.required<string>();
  readonly projectId = input.required<string>();
  protected readonly service = inject(ProjectGatesPageService);
  protected readonly errorKey = apiErrorKey;
  /** What the person typed or pasted per gate: kept here, never sent anywhere until they press. */
  protected readonly secretName = signal<Readonly<Record<string, string>>>({});
  protected readonly sealedText = signal<Readonly<Record<string, string>>>({});
  protected readonly envelope = signal<Readonly<Record<string, string>>>({});

  constructor() {
    inject(OrgScope).bind(this.orgId);
    this.service.bind(this.projectId);
  }

  protected type(
    store: typeof this.secretName,
    gate: string,
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement)
      .value;
    store.update((all) => ({ ...all, [gate]: value }));
  }
}
