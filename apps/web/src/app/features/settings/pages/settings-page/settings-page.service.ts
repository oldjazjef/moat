import { httpResource } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { ProjectSummary } from '../../../../core/api/project.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import type { AssistantStatus } from '../../../../core/api/assistant.types';
import {
  desktopBridge,
  type McpStatus,
  type PasskeyStatus,
} from '../../../../core/desktop/desktop-bridge';

import type { PasskeyNotice } from '../../../gates/pages/gates-page/gates-page.service';

/** `settings.mcp.notices.<code>`: why the MCP settings did not change. */
export const MCP_NOTICES = [
  'name_invalid',
  'too_many',
  'port_invalid',
  'failed',
] as const;
export type McpNotice = (typeof MCP_NOTICES)[number];

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

  /** The assistant's provider as the API knows it (never the token). */
  readonly canAssistant = this.bridge?.assistant !== undefined;
  readonly assistant = httpResource<AssistantStatus>(() =>
    this.canAssistant ? apiUrl('/assistant/status') : undefined,
  );
  readonly mcp = signal<McpStatus | null>(null);
  readonly mcpBusy = signal(false);
  readonly mcpNotice = signal<McpNotice | null>(null);
  /** A token just created: shown once, here, and never again. */
  readonly newToken = signal<string | null>(null);

  constructor() {
    void this.loadPasskey();
    void this.loadMcp();
  }

  /** «AI-Anbieter einrichten»: the main process's own window; the token is typed only there. */
  async openProvider(): Promise<void> {
    if (this.bridge?.assistant === undefined) return;
    await this.bridge.assistant.openProvider(
      this.translate.getCurrentLang() ?? '',
    );
    this.assistant.reload();
  }

  async setMcpEnabled(on: boolean): Promise<void> {
    await this.mcpStep((bridge) => bridge.mcpSetEnabled(on));
  }

  async setMcpPort(value: string): Promise<void> {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
      this.mcpNotice.set('port_invalid');
      return;
    }
    await this.mcpStep((bridge) => bridge.mcpSetPort(port));
  }

  async createToken(name: string): Promise<boolean> {
    const bridge = this.bridge?.assistant;
    if (bridge === undefined || this.mcpBusy()) return false;
    this.mcpBusy.set(true);
    this.mcpNotice.set(null);
    this.newToken.set(null);
    try {
      const result = await bridge.mcpTokenCreate(name);
      if (result.status === 'created') {
        this.newToken.set(result.token);
        this.mcp.set(result.mcp);
        return true;
      }
      this.mcpNotice.set(result.code);
      return false;
    } catch {
      this.mcpNotice.set('failed');
      return false;
    } finally {
      this.mcpBusy.set(false);
    }
  }

  async revokeToken(id: string): Promise<void> {
    this.newToken.set(null);
    await this.mcpStep((bridge) => bridge.mcpTokenRevoke(id));
  }

  /** «Fertig»: the shown token goes away; it cannot be shown again. */
  hideToken(): void {
    this.newToken.set(null);
  }

  private async mcpStep(
    step: (
      bridge: NonNullable<NonNullable<typeof this.bridge>['assistant']>,
    ) => Promise<McpStatus | null>,
  ): Promise<void> {
    const bridge = this.bridge?.assistant;
    if (bridge === undefined || this.mcpBusy()) return;
    this.mcpBusy.set(true);
    this.mcpNotice.set(null);
    try {
      const status = await step(bridge);
      if (status === null) this.mcpNotice.set('failed');
      else this.mcp.set(status);
    } catch {
      this.mcpNotice.set('failed');
    } finally {
      this.mcpBusy.set(false);
    }
  }

  private async loadMcp(): Promise<void> {
    if (this.bridge?.assistant === undefined) return;
    try {
      this.mcp.set(await this.bridge.assistant.mcpStatus());
    } catch {
      this.mcp.set(null);
    }
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
