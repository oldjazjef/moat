import {
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http';
import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideSpartanHlm } from '@moat/ui/utils';
import { appRoutes } from './app.routes';
import {
  csrfInterceptor,
  sessionEndedInterceptor,
} from './core/auth/csrf.interceptor';
import { provideI18n } from './core/i18n/i18n.config';
import { provideAppSidebar } from './core/layout/sidebar-config';

/**
 * Zoneless (as lazy-koins): Angular 22 schedules change detection from signals and events, so
 * there is no zone.js anywhere.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes, withComponentInputBinding()),
    provideHttpClient(
      withFetch(),
      withInterceptors([csrfInterceptor, sessionEndedInterceptor]),
    ),
    provideI18n(),
    provideSpartanHlm(),
    provideAppSidebar(),
  ],
};
