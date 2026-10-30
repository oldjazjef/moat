import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import {
  AI_IPC,
  type AiDialogInput,
  type AiDialogView,
} from '../shared/ai-dialog';
import { DialogSlot } from './dialog-window';
import type { AiSettingsSession } from './lib/ai-settings';
import {
  MAX_BASE_URL_LENGTH,
  MAX_KEY_LENGTH,
  MAX_MODEL_LENGTH,
} from './lib/assistant';

/** The AI provider window (T-108): the token is typed here, never in the app's page. */
const slot = new DialogSlot<AiSettingsSession, boolean>();

export function registerAiDialogIpc(): void {
  ipcMain.handle(AI_IPC.view, (event): AiDialogView | null => {
    return slot.from(event)?.session.view() ?? null;
  });
  ipcMain.handle(
    AI_IPC.save,
    (event: IpcMainInvokeEvent, input: unknown): AiDialogView | null => {
      const dialog = slot.from(event);
      const parsed = inputOf(input);
      if (dialog === null || parsed === null) return null;
      try {
        return dialog.session.save(parsed);
      } catch {
        // Never the error's text: it could carry the token (SEC-34).
        console.error('[desktop] saving the AI provider failed');
        return null;
      }
    },
  );
  ipcMain.handle(AI_IPC.forget, (event): AiDialogView | null => {
    return slot.from(event)?.session.forget() ?? null;
  });
  ipcMain.handle(AI_IPC.close, (event): void => {
    slot.from(event)?.finish(true);
  });
}

function inputOf(input: unknown): AiDialogInput | null {
  if (typeof input !== 'object' || input === null) return null;
  const { kind, baseUrl, model, key } = input as Record<string, unknown>;
  if (
    (kind !== 'anthropic' && kind !== 'openai_compatible') ||
    typeof baseUrl !== 'string' ||
    baseUrl.length > MAX_BASE_URL_LENGTH + 10 ||
    typeof model !== 'string' ||
    model.length > MAX_MODEL_LENGTH + 10 ||
    typeof key !== 'string' ||
    key.length > MAX_KEY_LENGTH + 10
  )
    return null;
  return { kind, baseUrl, model, key };
}

/** Resolves when the window closes; the page then asks for the new state. */
export function showAiDialog(options: {
  parent: BrowserWindow;
  appDir: string;
  title: string;
  session: AiSettingsSession;
}): Promise<boolean> {
  return slot.show({
    ...options,
    preload: 'ai-preload.js',
    page: 'dialogs/ai-dialog.html',
    height: 640,
    cancelled: true,
    busy: false,
  });
}
