import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';

/**
 * jsdom has no layout engine and therefore no native ResizeObserver. Spartan overlays use one to
 * position their portals, while the tests only need the observer contract (not measured geometry).
 */
if (typeof ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {
      return undefined;
    }

    unobserve(): void {
      return undefined;
    }

    disconnect(): void {
      return undefined;
    }
  }

  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

/**
 * Initialises Angular's TestBed once per worker.
 *
 * `zoneless: true` is the default and the right one here: the app runs zoneless
 * (`provideZonelessChangeDetection` in `app.config.ts`), so tests must not pull in `zone.js` —
 * doing so would give the specs a change-detection model the application does not have.
 */
setupTestBed();
