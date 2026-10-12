import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideFolderOpen,
  lucideRefreshCw,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { ProjectResource } from '../../../../core/project/project-resource.service';
import { ProjectEdits } from '../../../../core/project/project-edits.service';
import { EditStatus } from '../../components/edit-status';
import { PageHeader } from '../../../../shared/components/page-header';
import { HelpLink } from '../../../help/components/help-link';
import { ProjectRemoveButton } from '../../components/project-remove-button';
import { ProjectWorkspaceService } from './project-workspace.service';

/**
 * `/app/projects/:id`: the project's name and folder, its tabs, and the tab's page below. The
 * workspace answers loading, errors, an unknown project and a folder that is gone itself, so the
 * tabs only ever render a readable project.
 */
@Component({
  selector: 'mt-project-workspace',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    NgIcon,
    TranslatePipe,
    PageHeader,
    HelpLink,
    ProjectRemoveButton,
    EditStatus,
    ...HlmButtonImports,
  ],
  providers: [
    ProjectResource,
    ProjectEdits,
    ProjectWorkspaceService,
    provideIcons({
      lucideArrowLeft,
      lucideFolderOpen,
      lucideRefreshCw,
      lucideTriangleAlert,
    }),
  ],
  templateUrl: './project-workspace.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectWorkspace {
  protected readonly service = inject(ProjectWorkspaceService);
  protected readonly resource = this.service.resource;
}
