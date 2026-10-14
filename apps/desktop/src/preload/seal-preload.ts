import { ipcRenderer } from 'electron';
import {
  SEAL_IPC,
  type SealDialogConfirm,
  type SealDialogView,
} from '../shared/seal-dialog';

// The seal dialog's preload. The page has no script of its own and this preload exposes nothing
// to it: it renders the main process's view with textContent only. The value goes to the main
// process as bytes, the field is cleared at once, and the bytes are zeroed after sending.

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`seal dialog: #${id} missing`);
  return element as T;
};

const setText = (id: string, text: string) => {
  byId(id).textContent = text;
};

let busy = false;

function render(view: SealDialogView): void {
  const t = view.texts;
  document.title = t.title;
  setText('title', t.title);
  setText('intro', t.intro);
  setText('project-label', t.project);
  setText('project', view.project);
  setText('gate-label', t.gate);
  setText('gate', `${view.gate} · ${view.gateId}`);
  setText('fingerprint-label', t.fingerprint);
  setText('fingerprint', view.fingerprint);
  setText('fingerprint-hint', t.fingerprintHint);
  setText('secret-label', t.secret);
  setText('secret', view.name);
  setText('version-label', t.version);
  setText(
    'version',
    view.currentVersion === null
      ? `${view.nextVersion} (${t.firstVersion})`
      : `${view.currentVersion} → ${view.nextVersion}`,
  );
  setText('used-by-label', t.usedBy);
  setText(
    'used-by',
    view.usedBy.length === 0
      ? t.unused
      : view.usedBy
          .map(({ upstream, origin }) => `${upstream} (${origin})`)
          .join(', '),
  );
  byId('compared-by-label').hidden = view.comparedBy.length === 0;
  byId('compared-by').hidden = view.comparedBy.length === 0;
  setText('compared-by-label', t.comparedBy);
  setText('compared-by', view.comparedBy.join(', '));
  setText('value-label', t.value);
  setText('value-hint', t.valueHint);
  setText('show-label', t.show);
  const notice = byId('notice');
  notice.hidden = view.notice === null;
  notice.textContent = view.notice === null ? '' : t.notices[view.notice];
  setText('cancel', t.cancel);
  setText('seal', t.seal);
  byId('form').hidden = false;
  byId('value').focus();
}

function setBusy(value: boolean): void {
  busy = value;
  for (const id of ['seal', 'cancel'])
    byId<HTMLButtonElement>(id).disabled = value;
}

async function run(work: () => Promise<SealDialogView | null>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const view = await work();
    // null: sealed, the main process closes this window.
    if (view !== null) render(view);
  } finally {
    setBusy(false);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const value = byId<HTMLInputElement>('value');
  const show = byId<HTMLInputElement>('show');
  show.addEventListener('change', () => {
    value.type = show.checked ? 'text' : 'password';
  });
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input: SealDialogConfirm = {
      value: new TextEncoder().encode(value.value),
    };
    value.value = '';
    void run(async () => {
      try {
        return (await ipcRenderer.invoke(
          SEAL_IPC.confirm,
          input,
        )) as SealDialogView | null;
      } finally {
        input.value.fill(0);
      }
    });
  });
  const cancel = () => {
    value.value = '';
    void ipcRenderer.invoke(SEAL_IPC.cancel);
  };
  byId('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy) cancel();
  });
  void run(() => ipcRenderer.invoke(SEAL_IPC.view) as Promise<SealDialogView>);
});
