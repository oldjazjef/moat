import { ipcRenderer } from 'electron';
import {
  DATABASE_IPC,
  type DatabaseDialogInput,
  type DatabaseDialogView,
  type DatabaseDirection,
} from '../shared/database-dialog';

// The database window's preload. The page has no script of its own and this preload exposes
// nothing to it: it renders the main process's view with textContent only. The connection string
// goes to the main process once and the field is cleared at once.

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`database dialog: #${id} missing`);
  return element as T;
};

const setText = (id: string, text: string) => {
  byId(id).textContent = text;
};

let busy = false;

function render(view: DatabaseDialogView): void {
  const t = view.texts;
  document.title = t.title;
  setText('title', t.title);
  setText('intro', t.intro);
  setText('project-label', t.project);
  setText('project', view.project);
  setText('target-label', t.target);
  byId('target-row').hidden = view.target.label === null;
  setText('target', view.target.label ?? '');
  setText('url-label', t.url);
  setText('url-hint', t.urlHint);
  const remembered = byId('url-remembered');
  remembered.hidden = !view.target.urlRemembered;
  remembered.textContent = t.urlRemembered;
  setText('key-label', t.key);
  setText('key-hint', t.keyHint);
  const key = byId<HTMLInputElement>('key');
  if (key.value === '') key.value = view.target.key;
  byId('remember-row').hidden = !view.canRemember;
  setText('remember-label', t.remember);
  byId<HTMLInputElement>('remember').checked = view.target.urlRemembered;
  setText('push', t.push);
  setText('pull', t.pull);
  setText('forget', t.forget);
  byId('forget').hidden = view.target.label === null;
  setText('close', t.close);

  const notice = byId('notice');
  notice.hidden = view.notice === null;
  notice.textContent = view.notice === null ? '' : t.notices[view.notice];

  const result = view.result;
  byId('result').hidden = result === null;
  if (result !== null) {
    setText('result-title', t.resultTitle[result.direction]);
    const counts = byId('result-counts');
    const line = (text: string) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    };
    counts.replaceChildren(
      line(result.config ? t.resultConfig : t.resultUnchanged),
      line(`${t.resultGates}: ${result.gates}`),
      line(`${t.resultSecrets}: ${result.secrets}`),
      line(`${t.resultBundles}: ${result.bundles}`),
    );
    byId('result-issues-title').hidden = result.issues.length === 0;
    setText('result-issues-title', t.resultIssues);
    byId('result-issues').replaceChildren(
      ...result.issues.map((issue) =>
        line(
          [
            t.issues[issue.code],
            issue.gate,
            issue.name,
            issue.version === null ? null : `v${issue.version}`,
          ]
            .filter((part) => part !== null)
            .join(' · '),
        ),
      ),
    );
  }
  byId('form').hidden = false;
}

function setBusy(value: boolean): void {
  busy = value;
  for (const id of ['push', 'pull', 'forget', 'close'])
    byId<HTMLButtonElement>(id).disabled = value;
}

async function run(
  work: () => Promise<DatabaseDialogView | null>,
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

window.addEventListener('DOMContentLoaded', () => {
  const url = byId<HTMLInputElement>('url');
  const start = (direction: DatabaseDirection) => {
    const input: DatabaseDialogInput = {
      url: url.value,
      key: byId<HTMLInputElement>('key').value,
      remember: byId<HTMLInputElement>('remember').checked,
      direction,
    };
    url.value = '';
    void run(
      () =>
        ipcRenderer.invoke(
          DATABASE_IPC.run,
          input,
        ) as Promise<DatabaseDialogView | null>,
    );
  };
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    start('push');
  });
  byId('pull').addEventListener('click', () => start('pull'));
  byId('forget').addEventListener('click', () => {
    void run(
      () =>
        ipcRenderer.invoke(DATABASE_IPC.forget) as Promise<DatabaseDialogView>,
    );
  });
  const close = () => {
    url.value = '';
    void ipcRenderer.invoke(DATABASE_IPC.close);
  };
  byId('close').addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy) close();
  });
  void run(
    () => ipcRenderer.invoke(DATABASE_IPC.view) as Promise<DatabaseDialogView>,
  );
});
