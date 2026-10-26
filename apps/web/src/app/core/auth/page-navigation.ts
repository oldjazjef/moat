import { Injectable } from '@angular/core';

/** Leaves the app for another address (the identity provider). Specs replace it. */
@Injectable({ providedIn: 'root' })
export class PageNavigation {
  go(url: string): void {
    window.location.assign(url);
  }
}
