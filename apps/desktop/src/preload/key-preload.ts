import { ipcRenderer } from 'electron';
import {
  KEY_IPC,
  type KeyDialogConfirm,
  type KeyDialogView,
} from '../shared/key-dialog';

// The key window's preload. The page has no script of its own and this preload exposes nothing
// to it: it renders the main process's view with textContent only. The passphrase goes to the
// main process once and the fields are cleared at once.

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`key dialog: #${id} missing`);
  return element as T;
};

const setText = (id: string, text: string) => {
  byId(id).textContent = text;
};

let busy = false;

function render(view: KeyDialogView): void {
  const t = view.texts;
  document.title = t.title;
  setText('title', t.title);
  setText('intro', t.intro);
  setText('passphrase-label', t.passphrase);
  setText('repeat-label', t.repeat);
  setText('hint', t.hint);
  setText('show-label', t.show);
  setText('working', t.working);
  const notice = byId('notice');
  notice.hidden = view.notice === null;
  notice.textContent = view.notice === null ? '' : t.notices[view.notice];
  setText('cancel', t.cancel);
  setText('create', t.create);
  byId('form').hidden = false;
  byId('passphrase').focus();
}

function setBusy(value: boolean): void {
  busy = value;
  byId('working').hidden = !value;
  for (const id of ['create', 'cancel', 'passphrase', 'repeat'])
    byId<HTMLButtonElement | HTMLInputElement>(id).disabled = value;
}

async function run(work: () => Promise<KeyDialogView | null>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const view = await work();
    // null: created, the main process closes this window.
    if (view !== null) render(view);
  } finally {
    setBusy(false);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const passphrase = byId<HTMLInputElement>('passphrase');
  const repeat = byId<HTMLInputElement>('repeat');
  const show = byId<HTMLInputElement>('show');
  show.addEventListener('change', () => {
    passphrase.type = repeat.type = show.checked ? 'text' : 'password';
  });
  // A notice is about what was sent; typing again takes it away.
  for (const field of [passphrase, repeat])
    field.addEventListener('input', () => {
      byId('notice').hidden = true;
    });
  const clear = () => {
    passphrase.value = '';
    repeat.value = '';
  };
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input: KeyDialogConfirm = {
      passphrase: passphrase.value,
      repeat: repeat.value,
    };
    clear();
    void run(
      () =>
        ipcRenderer.invoke(
          KEY_IPC.confirm,
          input,
        ) as Promise<KeyDialogView | null>,
    );
  });
  const cancel = () => {
    clear();
    void ipcRenderer.invoke(KEY_IPC.cancel);
  };
  byId('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy) cancel();
  });
  void run(() => ipcRenderer.invoke(KEY_IPC.view) as Promise<KeyDialogView>);
});
