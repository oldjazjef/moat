import { ipcRenderer } from 'electron';
import {
  PASSKEY_ENROLL_IPC,
  type PasskeyCreateRequest,
  type PasskeyEnrollOutcome,
  type PasskeyEnrollView,
} from '../shared/passkey-dialog';
import { createPasskey, passkeyAvailable } from './passkey-ceremony';

// The «Passkey anlegen» window's preload (trust mode 2). The page has no script of its own and
// this preload exposes nothing to it: it renders the main process's view with textContent only,
// asks the system for a passkey with the challenge the main process made, and hands the answer
// back. Nothing the page of the app could read passes through here.

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`passkey dialog: #${id} missing`);
  return element as T;
};

const setText = (id: string, text: string) => {
  byId(id).textContent = text;
};

let busy = false;

function render(view: PasskeyEnrollView): void {
  const t = view.texts;
  document.title = t.title;
  setText('title', t.title);
  setText('intro', t.intro);
  setText('honesty', t.honesty);
  setText('rpid-label', t.rpId);
  setText('rpid', view.rpId);
  setText('origin-label', t.origin);
  setText('origin', view.origin);
  const replaces = byId('replaces');
  replaces.hidden = !view.replaces;
  replaces.textContent = t.replaces;

  const notice = byId('notice');
  notice.hidden = view.notice === null;
  notice.textContent = view.notice === null ? '' : t.notices[view.notice];

  const done = byId('done');
  done.hidden = view.done === null;
  if (view.done !== null) {
    setText('done-title', t.doneTitle);
    setText('done-intro', t.doneIntro);
    setText('fingerprint-label', t.fingerprint);
    setText('fingerprint', view.done.fingerprint);
    setText('publickey-label', t.publicKey);
    setText('publickey', view.done.publicKey);
    setText('trust-label', t.trustCommand);
    setText('trust', view.done.trustCommand);
    setText('install-label', t.installCommand);
    setText('install', view.done.installCommand);
    setText('compare', t.compare);
  }
  byId('create').hidden = view.done !== null;
  setText('create', t.create);
  setText('cancel', view.done === null ? t.cancel : t.close);
  byId('form').hidden = false;
}

function setBusy(value: boolean): void {
  busy = value;
  for (const id of ['create']) byId<HTMLButtonElement>(id).disabled = value;
}

async function run(
  work: () => Promise<PasskeyEnrollView | null>,
): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const view = await work();
    if (view !== null) render(view);
  } finally {
    setBusy(false);
  }
}

async function ceremony(): Promise<PasskeyEnrollView | null> {
  const send = (outcome: PasskeyEnrollOutcome) =>
    ipcRenderer.invoke(
      PASSKEY_ENROLL_IPC.finish,
      outcome,
    ) as Promise<PasskeyEnrollView | null>;
  // Nothing to ask for when the system has no passkey: say so, plainly.
  if (!(await passkeyAvailable()))
    return send({ status: 'failed', reason: 'unavailable' });
  const request = (await ipcRenderer.invoke(
    PASSKEY_ENROLL_IPC.begin,
  )) as PasskeyCreateRequest | null;
  if (request === null) return null;
  return send(await createPasskey(request));
}

window.addEventListener('DOMContentLoaded', () => {
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(ceremony);
  });
  const cancel = () => void ipcRenderer.invoke(PASSKEY_ENROLL_IPC.cancel);
  byId('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy) cancel();
  });
  void run(
    () =>
      ipcRenderer.invoke(PASSKEY_ENROLL_IPC.view) as Promise<PasskeyEnrollView>,
  );
});
