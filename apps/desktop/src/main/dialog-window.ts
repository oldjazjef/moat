import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';

/**
 * A modal window of the main process for a step the page must not do itself (DT-15: signing;
 * sealing a secret): loaded from a local file with no script of its own and its own sandboxed
 * preload. The app's page cannot reach it: `from()` answers only that window's main frame, and
 * the page only ever learns the outcome. One per kind at a time.
 */
export class DialogSlot<Session, Result> {
  private current: {
    readonly window: BrowserWindow;
    readonly session: Session;
    finish(result: Result): void;
    working<T>(work: Promise<T>): Promise<T>;
  } | null = null;

  /**
   * The open dialog's session when `event` comes from its main frame — nothing else. `working`
   * keeps the window open until the work is done, so a close never reports `cancelled` for a
   * step that still saves.
   */
  from(event: IpcMainInvokeEvent): {
    session: Session;
    finish(result: Result): void;
    working<T>(work: Promise<T>): Promise<T>;
  } | null {
    const dialog = this.current;
    if (dialog === null || dialog.window.isDestroyed()) return null;
    const contents = dialog.window.webContents;
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame)
      return null;
    return dialog;
  }

  /** Shows the dialog; resolves when its session finishes, or `cancelled` when it is closed. */
  show(options: {
    parent: BrowserWindow;
    appDir: string;
    title: string;
    /** File names next to main.js (scripts/stage.mjs). */
    preload: string;
    page: string;
    height: number;
    session: Session;
    cancelled: Result;
    /** When one is open already (it gets the focus). */
    busy: Result;
  }): Promise<Result> {
    if (this.current !== null && !this.current.window.isDestroyed()) {
      this.current.window.focus();
      return Promise.resolve(options.busy);
    }
    return new Promise((resolve) => {
      const window = new BrowserWindow({
        parent: options.parent,
        modal: true,
        width: 560,
        height: options.height,
        minWidth: 360,
        minHeight: 420,
        title: options.title,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(options.appDir, options.preload),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          spellcheck: false,
          devTools: false,
        },
      });
      window.setMenu(null);
      let done = false;
      let busy = 0;
      const dialog = {
        window,
        session: options.session,
        working: async <T>(work: Promise<T>): Promise<T> => {
          busy += 1;
          try {
            return await work;
          } finally {
            busy -= 1;
          }
        },
        finish: (result: Result) => {
          if (done) return;
          done = true;
          if (this.current === dialog) this.current = null;
          resolve(result);
          if (!window.isDestroyed()) window.close();
        },
      };
      this.current = dialog;
      window.once('ready-to-show', () => window.show());
      window.on('close', (event) => {
        if (busy > 0 && !done) event.preventDefault();
      });
      window.on('closed', () => dialog.finish(options.cancelled));
      void window.loadURL(
        pathToFileURL(join(options.appDir, options.page)).href,
      );
    });
  }
}
