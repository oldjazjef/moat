import { ipcRenderer } from 'electron';
import {
  FTPS_IPC,
  type FtpsDialogInput,
  type FtpsDialogView,
} from '../shared/ftps-dialog';

// The FTPS window's preload. The page has no script of its own and this preload exposes nothing
// to it: it renders the main process's view with textContent only. The password goes to the
// main process once and the field is cleared at once.

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`ftps dialog: #${id} missing`);
  return element as T;
};

const setText = (id: string, text: string) => {
  byId(id).textContent = text;
};

let busy = false;

function render(view: FtpsDialogView): void {
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
  byId('files').replaceChildren(
    ...view.files.map((name) => {
      const item = document.createElement('li');
      item.textContent = name;
      return item;
    }),
  );

  const target = view.step === 'target';
  byId('target-step').hidden = !target;
  byId('certificate-step').hidden = target;
  setText('host-label', t.host);
  setText('port-label', t.port);
  setText('mode-label', t.mode);
  setText('mode-explicit', t.modeExplicit);
  setText('mode-implicit', t.modeImplicit);
  setText('mode-hint', t.modeHint);
  setText('username-label', t.username);
  setText('remote-dir-label', t.remoteDir);
  setText('remote-dir-hint', t.remoteDirHint);
  setText('secret-label', t.password);
  byId<HTMLInputElement>('host').value = view.target.host;
  byId<HTMLInputElement>('port').value = view.target.port;
  byId<HTMLSelectElement>('mode').value = view.target.mode;
  byId<HTMLInputElement>('username').value = view.target.username;
  byId<HTMLInputElement>('remote-dir').value = view.target.remoteDir;
  const remembered = byId('remembered');
  remembered.hidden = !view.target.secretRemembered;
  remembered.textContent = t.secretRemembered;
  byId('remember-row').hidden = !view.canRemember;
  setText('remember-label', t.remember);
  byId<HTMLInputElement>('remember').checked = view.target.secretRemembered;
  const pinned = byId('pinned');
  pinned.hidden = view.target.certificate === null;
  pinned.textContent =
    view.target.certificate === null
      ? ''
      : `${t.pinned} ${view.target.certificate}`;

  setText('certificate-title', t.certificateTitle);
  setText('certificate-intro', t.certificateIntro);
  setText('fingerprint-label', t.fingerprint);
  setText('fingerprint', view.certificate?.fingerprint ?? '');
  setText('subject-label', t.subject);
  setText('subject', view.certificate?.subject ?? '');
  setText('issuer-label', t.issuer);
  setText('issuer', view.certificate?.issuer ?? '');
  setText('valid-to-label', t.validTo);
  setText('valid-to', view.certificate?.validTo ?? '');
  setText('certificate-hint', t.certificateHint);

  const notice = byId('notice');
  notice.hidden = view.notice === null;
  notice.textContent = view.notice === null ? '' : t.notices[view.notice];
  setText('forget', t.forget);
  byId('forget').hidden = !target || view.target.certificate === null;
  setText('cancel', t.cancel);
  setText('upload', t.upload);
  byId('upload').hidden = !target;
  setText('trust', t.trust);
  byId('trust').hidden = target;
  byId('form').hidden = false;
}

function setBusy(value: boolean): void {
  busy = value;
  for (const id of ['upload', 'trust', 'cancel', 'forget'])
    byId<HTMLButtonElement>(id).disabled = value;
}

async function run(work: () => Promise<FtpsDialogView | null>): Promise<void> {
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
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input: FtpsDialogInput = {
      host: value('host'),
      port: value('port'),
      username: value('username'),
      remoteDir: value('remote-dir'),
      mode:
        byId<HTMLSelectElement>('mode').value === 'implicit'
          ? 'implicit'
          : 'explicit',
      secret: secret.value,
      remember: byId<HTMLInputElement>('remember').checked,
    };
    secret.value = '';
    void run(
      () =>
        ipcRenderer.invoke(
          FTPS_IPC.connect,
          input,
        ) as Promise<FtpsDialogView | null>,
    );
  });
  byId('trust').addEventListener('click', () => {
    void run(
      () =>
        ipcRenderer.invoke(
          FTPS_IPC.trustCertificate,
        ) as Promise<FtpsDialogView | null>,
    );
  });
  byId('forget').addEventListener('click', () => {
    void run(
      () => ipcRenderer.invoke(FTPS_IPC.forget) as Promise<FtpsDialogView>,
    );
  });
  const cancel = () => {
    secret.value = '';
    void ipcRenderer.invoke(FTPS_IPC.cancel);
  };
  byId('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy) cancel();
  });
  void run(() => ipcRenderer.invoke(FTPS_IPC.view) as Promise<FtpsDialogView>);
});
