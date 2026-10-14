import { ipcRenderer } from 'electron';
import {
  SFTP_IPC,
  type SftpAuth,
  type SftpDialogInput,
  type SftpDialogView,
} from '../shared/sftp-dialog';

// The SFTP window's preload. The page has no script of its own and this preload exposes nothing
// to it: it renders the main process's view with textContent only. The password or passphrase
// goes to the main process once and the field is cleared at once.

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`sftp dialog: #${id} missing`);
  return element as T;
};

const setText = (id: string, text: string) => {
  byId(id).textContent = text;
};

let busy = false;
let current: SftpDialogView | null = null;

function render(view: SftpDialogView): void {
  current = view;
  const t = view.texts;
  document.title = t.title;
  setText('title', t.title);
  setText('intro', t.intro);
  setText('project-label', t.project);
  setText('project', view.project);
  setText('gate-label', t.gate);
  setText('gate', `${view.gate} · ${view.gateId}`);
  setText('version-label', t.version);
  setText('version', String(view.version));
  setText('files-label', t.files);
  const files = byId('files');
  files.replaceChildren(
    ...view.files.map((name) => {
      const item = document.createElement('li');
      item.textContent = name;
      return item;
    }),
  );

  const target = view.step === 'target';
  byId('target-step').hidden = !target;
  byId('hostkey-step').hidden = target;
  setText('host-label', t.host);
  setText('port-label', t.port);
  setText('username-label', t.username);
  setText('remote-dir-label', t.remoteDir);
  setText('remote-dir-hint', t.remoteDirHint);
  setText('auth-label', t.auth);
  setText('auth-password', t.authPassword);
  setText('auth-key', t.authKey);
  byId<HTMLInputElement>('host').value = view.target.host;
  byId<HTMLInputElement>('port').value = view.target.port;
  byId<HTMLInputElement>('username').value = view.target.username;
  byId<HTMLInputElement>('remote-dir').value = view.target.remoteDir;
  byId<HTMLSelectElement>('auth').value = view.target.auth;
  setText('key-file-label', t.keyFile);
  setText('key-file', view.target.keyName ?? t.noKeyFile);
  setText('choose-key', t.chooseKey);
  const remembered = byId('remembered');
  remembered.hidden = !view.target.secretRemembered;
  remembered.textContent = t.secretRemembered;
  byId('remember-row').hidden = !view.canRemember;
  setText('remember-label', t.remember);
  byId<HTMLInputElement>('remember').checked = view.target.secretRemembered;
  const pinned = byId('pinned');
  pinned.hidden = view.target.hostKey === null;
  pinned.textContent =
    view.target.hostKey === null ? '' : `${t.pinned} ${view.target.hostKey}`;
  showAuth(view.target.auth);

  setText('hostkey-title', t.hostKeyTitle);
  setText('hostkey-intro', t.hostKeyIntro);
  setText('hostkey', view.hostKey ?? '');
  setText('hostkey-hint', t.hostKeyHint);

  const notice = byId('notice');
  notice.hidden = view.notice === null;
  notice.textContent = view.notice === null ? '' : t.notices[view.notice];
  setText('forget', t.forget);
  byId('forget').hidden = !target || view.target.hostKey === null;
  setText('cancel', t.cancel);
  setText('upload', t.upload);
  byId('upload').hidden = !target;
  setText('trust', t.trust);
  byId('trust').hidden = target;
  byId('form').hidden = false;
}

function showAuth(auth: SftpAuth): void {
  const t = current?.texts;
  byId('key-row').hidden = auth !== 'key';
  if (t !== undefined)
    setText('secret-label', auth === 'key' ? t.passphrase : t.password);
}

function setBusy(value: boolean): void {
  busy = value;
  for (const id of ['upload', 'trust', 'cancel', 'forget', 'choose-key'])
    byId<HTMLButtonElement>(id).disabled = value;
}

async function run(work: () => Promise<SftpDialogView | null>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const view = await work();
    // null: uploaded, the main process closes this window.
    if (view !== null) render(view);
  } finally {
    setBusy(false);
  }
}

const value = (id: string) => byId<HTMLInputElement>(id).value;

window.addEventListener('DOMContentLoaded', () => {
  const secret = byId<HTMLInputElement>('secret');
  byId<HTMLSelectElement>('auth').addEventListener('change', (event) => {
    showAuth(
      (event.target as HTMLSelectElement).value === 'key' ? 'key' : 'password',
    );
  });
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input: SftpDialogInput = {
      host: value('host'),
      port: value('port'),
      username: value('username'),
      remoteDir: value('remote-dir'),
      auth:
        byId<HTMLSelectElement>('auth').value === 'key' ? 'key' : 'password',
      secret: secret.value,
      remember: byId<HTMLInputElement>('remember').checked,
    };
    secret.value = '';
    void run(
      () =>
        ipcRenderer.invoke(
          SFTP_IPC.connect,
          input,
        ) as Promise<SftpDialogView | null>,
    );
  });
  byId('trust').addEventListener('click', () => {
    void run(
      () =>
        ipcRenderer.invoke(
          SFTP_IPC.trustHostKey,
        ) as Promise<SftpDialogView | null>,
    );
  });
  byId('choose-key').addEventListener('click', () => {
    void run(
      () => ipcRenderer.invoke(SFTP_IPC.chooseKey) as Promise<SftpDialogView>,
    );
  });
  byId('forget').addEventListener('click', () => {
    void run(
      () => ipcRenderer.invoke(SFTP_IPC.forget) as Promise<SftpDialogView>,
    );
  });
  const cancel = () => {
    secret.value = '';
    void ipcRenderer.invoke(SFTP_IPC.cancel);
  };
  byId('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy) cancel();
  });
  void run(() => ipcRenderer.invoke(SFTP_IPC.view) as Promise<SftpDialogView>);
});
