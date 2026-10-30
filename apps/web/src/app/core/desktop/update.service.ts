import { Injectable, signal } from '@angular/core';
import { desktopBridge, type UpdateCheckResult } from './desktop-bridge';

/**
 * Moat Desktop's update check (decided 30.10.2026): shown, never downloaded or installed — the
 * person installs a new version from its release page. Once at start when the setting allows it,
 * again on «Jetzt prüfen» in «Einstellungen».
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly bridge = desktopBridge();
  readonly supported = this.bridge?.update !== undefined;
  readonly result = signal<UpdateCheckResult | null>(null);
  readonly checking = signal(false);
  readonly auto = signal(true);
  private started = false;

  /** At start: reads the setting, and checks once if it allows. */
  async start(): Promise<void> {
    const update = this.bridge?.update;
    if (update === undefined || this.started) return;
    this.started = true;
    try {
      this.auto.set(await update.auto());
    } catch {
      return;
    }
    if (this.auto()) await this.check();
  }

  async check(): Promise<void> {
    const update = this.bridge?.update;
    if (update === undefined || this.checking()) return;
    this.checking.set(true);
    try {
      this.result.set(await update.check());
    } catch {
      this.result.set({ status: 'failed', current: '' });
    } finally {
      this.checking.set(false);
    }
  }

  async setAuto(on: boolean): Promise<void> {
    const update = this.bridge?.update;
    if (update === undefined) return;
    try {
      this.auto.set(await update.setAuto(on));
    } catch {
      // The setting stays as it was.
    }
  }

  async open(): Promise<void> {
    const result = this.result();
    if (result?.status !== 'available') return;
    await this.bridge?.update?.open(result.latest);
  }
}
