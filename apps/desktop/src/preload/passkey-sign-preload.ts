import { ipcRenderer } from 'electron';
import {
  PASSKEY_SIGN_IPC,
  type PasskeyAssertionOutcome,
  type PasskeySignBegin,
  type PasskeySignView,
} from '../shared/passkey-dialog';
import { getAssertion, passkeyAvailable } from './passkey-ceremony';
import { renderSummary } from './sign-summary';

// The passkey signing dialog's preload (DT-15, trust mode 2). The page has no script of its own
// and this preload exposes nothing to it: it renders the main process's view with textContent
// only. On «Signieren» the main process makes the challenge from the bundle the person is
// looking at; this preload hands it to the passkey and returns the signature.

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`passkey sign dialog: #${id} missing`);
  return element as T;
};

const setText = (id: string, text: string) => {
  byId(id).textContent = text;
};

let busy = false;
let current: PasskeySignView | null = null;

function render(view: PasskeySignView): void {
  current = view;
  const t = view.texts;
  document.title = t.title;
  setText('title', t.title);
  setText('intro', t.intro);
  renderSummary(view, t, byId);
  setText('passkey-label', t.passkey);
  setText('passkey', `${view.fingerprint} · ${view.rpId}`);
  const notice = byId('notice');
  notice.hidden = view.notice === null;
  notice.textContent = view.notice === null ? '' : t.notices[view.notice];
  setText('working', t.signing);
  setText('cancel', t.cancel);
  setText('sign', t.sign);
  byId('form').hidden = false;
}

function setBusy(value: boolean): void {
  busy = value;
  byId('working').hidden = !value;
  byId<HTMLButtonElement>('sign').disabled = value;
}

async function run(work: () => Promise<PasskeySignView | null>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const view = await work();
    // null: signed or ended, the main process closes this window.
    if (view !== null) render(view);
  } finally {
    setBusy(false);
  }
}

async function sign(): Promise<PasskeySignView | null> {
  const send = (outcome: PasskeyAssertionOutcome) =>
    ipcRenderer.invoke(
      PASSKEY_SIGN_IPC.deliver,
      outcome,
    ) as Promise<PasskeySignView | null>;
  if (!(await passkeyAvailable()) && current !== null)
    return { ...current, notice: 'unavailable' };
  const begin = (await ipcRenderer.invoke(
    PASSKEY_SIGN_IPC.begin,
  )) as PasskeySignBegin | null;
  if (begin === null) return null;
  if (begin.kind === 'view') return begin.view;
  return send(await getAssertion(begin.request));
}

window.addEventListener('DOMContentLoaded', () => {
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(sign);
  });
  // Cancelling while the system asks for the passkey also lets that request go.
  const cancel = () => void ipcRenderer.invoke(PASSKEY_SIGN_IPC.cancel);
  byId('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy) cancel();
  });
  void run(
    () => ipcRenderer.invoke(PASSKEY_SIGN_IPC.view) as Promise<PasskeySignView>,
  );
});
