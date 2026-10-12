import { ipcRenderer } from 'electron';
import {
  SIGN_IPC,
  type SignDialogConfirm,
  type SignDialogView,
} from '../shared/sign-dialog';

// The signing dialog's preload (DT-15). The page has no script of its own and this preload
// exposes nothing to it: it renders the main process's view with textContent only and sends back
// the person's choice. The passphrase goes to the main process and is cleared from the field.

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`sign dialog: #${id} missing`);
  return element as T;
};

const setText = (id: string, text: string) => {
  byId(id).textContent = text;
};

let busy = false;

function render(view: SignDialogView): void {
  const t = view.texts;
  document.title = t.title;
  setText('title', t.title);
  setText('intro', t.intro);
  setText('project-label', t.project);
  setText('project', view.project);
  setText('gate-label', t.gate);
  setText('gate', view.gate);
  setText('version-label', t.version);
  setText(
    'version',
    view.previousVersion === 0
      ? `${view.version} (${t.firstVersion})`
      : `${view.previousVersion} → ${view.version}`,
  );
  setText('changes-label', t.changes);

  const list = byId('changes');
  list.replaceChildren();
  if (view.changes.length === 0) {
    const item = document.createElement('li');
    item.className = 'muted';
    item.textContent = t.noChanges;
    list.append(item);
  }
  for (const change of view.changes) {
    const item = document.createElement('li');
    item.dataset['change'] = `${change.kind}:${change.name}:${change.change}`;
    const kind = document.createElement('span');
    kind.textContent = `${t.kinds[change.kind]} `;
    item.append(kind);
    if (change.kind === 'lock') {
      const what = document.createElement('strong');
      what.textContent =
        change.change === 'added' ? t.lockAdded : t.lockRemoved;
      item.append(what);
    } else {
      const name = document.createElement('span');
      name.className = 'code';
      name.textContent = change.name;
      const what = document.createElement('span');
      what.className = 'muted';
      what.textContent = ` (${t.change[change.change]})`;
      item.append(name, what);
    }
    if (change.fields.length > 0) {
      const fields = document.createElement('ul');
      fields.className = 'fields';
      for (const field of change.fields) {
        const line = document.createElement('li');
        const label = document.createElement('span');
        label.className = 'muted';
        label.textContent = `${field.field}: `;
        const value = document.createElement('span');
        value.className = 'code';
        value.textContent =
          change.change === 'added'
            ? (field.after ?? t.unset)
            : `${field.before ?? t.unset} → ${field.after ?? t.unset}`;
        line.append(label, value);
        fields.append(line);
      }
      item.append(fields);
    }
    list.append(item);
  }

  const unverified = byId('unverified');
  unverified.hidden = view.previous !== 'unverified';
  unverified.textContent = t.unverified;

  const locked = byId('locked');
  locked.hidden = !view.locked;
  locked.textContent = t.lockedWarning;

  setText('key-label', t.keyFile);
  setText(
    'key',
    view.keyFile === null
      ? t.noKeyFile
      : view.keyFile.kid === null
        ? view.keyFile.name
        : `${view.keyFile.name} · ${view.keyFile.kid}`,
  );
  setText('choose-key', t.chooseKey);
  setText('passphrase-label', t.passphrase);
  const remembered = byId('remembered');
  remembered.hidden = !view.remembered;
  remembered.textContent = t.passphraseRemembered;
  byId('remember-row').hidden = !view.canRemember;
  setText('remember-label', t.remember);
  byId<HTMLInputElement>('remember').checked = view.remembered;

  const notice = byId('notice');
  notice.hidden = view.notice === null;
  notice.textContent = view.notice === null ? '' : t.notices[view.notice];

  setText('cancel', t.cancel);
  setText('sign', t.sign);
  byId('form').hidden = false;
  byId('passphrase').focus();
}

function setBusy(value: boolean): void {
  busy = value;
  for (const id of ['sign', 'cancel', 'choose-key'])
    byId<HTMLButtonElement>(id).disabled = value;
}

async function run(work: () => Promise<SignDialogView | null>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const view = await work();
    // null: signed, the main process closes this window.
    if (view !== null) render(view);
  } finally {
    setBusy(false);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const passphrase = byId<HTMLInputElement>('passphrase');
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input: SignDialogConfirm = {
      passphrase: passphrase.value,
      remember: byId<HTMLInputElement>('remember').checked,
    };
    passphrase.value = '';
    void run(
      () =>
        ipcRenderer.invoke(
          SIGN_IPC.confirm,
          input,
        ) as Promise<SignDialogView | null>,
    );
  });
  byId('choose-key').addEventListener('click', () => {
    void run(
      () =>
        ipcRenderer.invoke(
          SIGN_IPC.chooseKey,
        ) as Promise<SignDialogView | null>,
    );
  });
  const cancel = () => void ipcRenderer.invoke(SIGN_IPC.cancel);
  byId('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy) cancel();
  });
  void run(() => ipcRenderer.invoke(SIGN_IPC.view) as Promise<SignDialogView>);
});
