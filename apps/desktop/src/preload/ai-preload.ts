import { ipcRenderer } from 'electron';
import {
  AI_IPC,
  type AiDialogInput,
  type AiDialogKind,
  type AiDialogView,
} from '../shared/ai-dialog';

// The AI provider window's preload. The page has no script of its own and this preload exposes
// nothing to it: it renders the main process's view with textContent only. The token goes to the
// main process once and the field is cleared at once.

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`ai dialog: #${id} missing`);
  return element as T;
};

const setText = (id: string, text: string) => {
  byId(id).textContent = text;
};

let first = true;

function render(view: AiDialogView): void {
  const t = view.texts;
  document.title = t.title;
  setText('title', t.title);
  setText('intro', t.intro);
  setText('kind-label', t.kind);
  setText('kind-anthropic', t.kinds.anthropic);
  setText('kind-openai', t.kinds.openai_compatible);
  setText('url-label', t.baseUrl);
  setText('url-hint', t.baseUrlHint);
  setText('model-label', t.model);
  setText('model-hint', t.modelHint);
  setText('key-label', t.key);
  setText('key-hint', t.keyHint);
  setText('save', t.save);
  setText('forget', t.forget);
  setText('close', t.close);
  const stored = view.stored;
  if (first && stored !== null) {
    byId<HTMLSelectElement>('kind').value = stored.kind;
    byId<HTMLInputElement>('url').value = stored.baseUrl;
    byId<HTMLInputElement>('model').value = stored.model;
  }
  first = false;
  const hint = byId('key-stored');
  hint.hidden = stored?.keyHint == null;
  hint.textContent =
    stored?.keyHint == null
      ? ''
      : t.keyStored.replace('{hint}', stored.keyHint);
  byId('forget').hidden = stored === null;
  const notice = byId('notice');
  notice.hidden = view.notice === null;
  notice.textContent = view.notice === null ? '' : t.notices[view.notice];
  notice.className =
    view.notice === 'saved' || view.notice === 'forgotten' ? 'muted' : 'error';
  byId('form').hidden = false;
}

async function run(work: () => Promise<AiDialogView | null>): Promise<void> {
  const view = await work();
  if (view !== null) render(view);
}

window.addEventListener('DOMContentLoaded', () => {
  const key = byId<HTMLInputElement>('key');
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input: AiDialogInput = {
      kind: byId<HTMLSelectElement>('kind').value as AiDialogKind,
      baseUrl: byId<HTMLInputElement>('url').value,
      model: byId<HTMLInputElement>('model').value,
      key: key.value,
    };
    key.value = '';
    void run(
      () =>
        ipcRenderer.invoke(AI_IPC.save, input) as Promise<AiDialogView | null>,
    );
  });
  byId('forget').addEventListener('click', () => {
    void run(() => ipcRenderer.invoke(AI_IPC.forget) as Promise<AiDialogView>);
  });
  const close = () => {
    key.value = '';
    void ipcRenderer.invoke(AI_IPC.close);
  };
  byId('close').addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  void run(() => ipcRenderer.invoke(AI_IPC.view) as Promise<AiDialogView>);
});
