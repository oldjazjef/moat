import {
  ChangeDetectionStrategy,
  Component,
  inject,
  viewChild,
} from '@angular/core';
import { ProjectKey } from '../../../../shared/components/project-key';
import { desktopBridge } from '../../../../core/desktop/desktop-bridge';
import { SetupPageService } from '../../pages/setup-page/setup-page.service';
import { provideSetupStep, SetupStepComponent } from '../setup-step';

/**
 * FR-73, step «Signaturschlüssel»: the signing key of the project chosen in «Erstes Projekt»
 * (DT-15); every project has its own. The same panel as in the settings.
 */
@Component({
  selector: 'mt-setup-key-step',
  imports: [ProjectKey],
  providers: [provideSetupStep(() => KeyStep)],
  template: `<mt-project-key [projectId]="service.project()" />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyStep extends SetupStepComponent {
  protected readonly service = inject(SetupPageService);
  private readonly panel = viewChild.required(ProjectKey);
  private readonly desktop = desktopBridge() !== null;

  /** «Weiter» needs a usable key; without one, «Später». In a browser there is nothing to do. */
  async submit(): Promise<boolean> {
    if (!this.desktop) return true;
    const panel = this.panel();
    if (await panel.ready()) return true;
    panel.notice.set('required');
    return false;
  }
}
