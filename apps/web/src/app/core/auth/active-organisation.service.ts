import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'mt-active-organisation';

/** An organisation id as the API issues it (22 characters of base64url; it lands in URLs). */
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * The organisation the sidebar offers «Projekte» and «Mitglieder» for. A per-viewer convenience
 * only: the id (not a token) is remembered in `localStorage` when the browser lets us, and
 * whether the account may open it is always the API's decision (a foreign id is a 404, SEC-50).
 */
@Injectable({ providedIn: 'root' })
export class ActiveOrganisation {
  private readonly current = signal<string | null>(read());
  readonly id = this.current.asReadonly();

  set(id: string | null): void {
    const next = id !== null && ID_PATTERN.test(id) ? id : null;
    this.current.set(next);
    try {
      if (next === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice lasts until the page closes.
    }
  }
}

function read(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== null && ID_PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}
