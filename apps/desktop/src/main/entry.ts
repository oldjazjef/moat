import { app, dialog } from 'electron';

/**
 * The bundle's entry point (as lazy-koins): installs the last-resort error handler FIRST, then
 * loads the app. Without it, a failure while loading shows Electron's raw "A JavaScript error
 * occurred in the main process" stack.
 */
let failed = false;

function fatal(error: unknown): void {
  if (failed) return;
  failed = true;
  console.error('[desktop] fatal', error);
  try {
    dialog.showErrorBox(
      'Moat Desktop',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    app.exit(1);
  }
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

// esbuild inlines this (no code splitting) but evaluates main.ts only now, after the handlers.
import('./main').catch(fatal);
