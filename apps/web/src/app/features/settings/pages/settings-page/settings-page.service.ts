import { httpResource } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { ProjectSummary } from '../../../../core/api/project.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import {
  desktopBridge,
  type PasskeyStatus,
} from '../../../../core/desktop/desktop-bridge';
import type { PasskeyNotice } from '../../../gates/pages/gates-page/gates-page.service';

/**
 * «Einstellungen» of Moat Desktop: the passkey of this device (trust mode 2, one per device) and
 * the signing key of every project (each has its own `.moatkey` file). Which gate signs with the
 * passkey stays a choice per gate under «Gates».
 */
@Injectable()
export class SettingsPageService {
  private readonly bridge = desktopBridge();
  private readonly translate = inject(TranslateService);

  readonly projects = httpResource<readonly ProjectSummary[]>(() =>
    apiUrl('/projects'),
  );
  readonly projectList = computed(() =>
    this.projects.hasValue() ? this.projects.value() : [],
  );

  /** The desktop shell offers the passkey windows. */
  readonly canPasskey = this.bridge?.passkey !== undefined;
  readonly passkey = signal<PasskeyStatus | null>(null);
  readonly passkeyBusy = signal(false);
  readonly passkeyNotice = signal<PasskeyNotice | null>(null);
  /** The passkey was created just now: say what to do next. */
  readonly passkeyCreated = signal(false);

  constructor() {
    void this.loadPasskey();
  }

  /** «Passkey anlegen»: the main process's passkey window; the page learns the outcome only. */
  async enrollPasskey(): Promise<void> {
    if (this.bridge?.passkey === undefined || this.passkeyBusy()) return;
    this.passkeyBusy.set(true);
    this.passkeyNotice.set(null);
    this.passkeyCreated.set(false);
    try {
      const result = await this.bridge.passkey.enroll(
        this.translate.getCurrentLang() ?? '',
      );
      if (result.status === 'created') {
        this.passkeyCreated.set(true);
        await this.loadPasskey();
      } else {
        this.passkeyNotice.set(result.status);
      }
    } catch {
      this.passkeyNotice.set('failed');
    } finally {
      this.passkeyBusy.set(false);
    }
  }

  private async loadPasskey(): Promise<void> {
    if (this.bridge?.passkey === undefined) return;
    try {
      this.passkey.set(await this.bridge.passkey.status(null));
    } catch {
      this.passkey.set({ passkey: null, gates: [] });
    }
  }
}
