import { Injectable, effect, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'mt-theme';

function resolveInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage blocked: the OS preference.
  }
  const prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

/**
 * Light or dark (as lazy-koins): every dark token exists in styles.css under `:root.dark`; this
 * decides which applies, remembers the choice and falls back to the OS preference.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly theme = signal<Theme>(resolveInitialTheme());
  readonly current = this.theme.asReadonly();

  constructor() {
    effect(() => {
      const theme = this.theme();
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // Storage blocked: the choice lasts until the window closes.
      }
    });
  }

  toggle(): void {
    this.theme.update((current) => (current === 'dark' ? 'light' : 'dark'));
  }
}
