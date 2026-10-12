import { DOCUMENT, effect, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  initialLocale,
  LOCALE_STORAGE_KEY,
  type SupportedLocale,
} from './locales';

/**
 * The app's language, switched at runtime without a reload: ngx-translate's language,
 * `<html lang>` and the language remembered on this device.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly translate = inject(TranslateService);
  private readonly document = inject(DOCUMENT);
  private readonly current = signal<SupportedLocale>(initialLocale());

  /** The active language (a signal: `computed`s that translate in code read it). */
  readonly locale = this.current.asReadonly();

  constructor() {
    effect(() => this.activate(this.current()));
  }

  use(locale: SupportedLocale): void {
    this.current.set(locale);
  }

  private activate(locale: SupportedLocale): void {
    if (this.translate.getCurrentLang() !== locale) this.translate.use(locale);
    this.document.documentElement.lang = locale;
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Storage blocked: the browser's language next time.
    }
  }
}
