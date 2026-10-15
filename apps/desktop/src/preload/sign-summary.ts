import type { SignDialogChange, SignDialogView } from '../shared/sign-dialog';

/**
 * What both signing dialogs (the key file's and the passkey's) show about the bundle: project,
 * gate, version and the changes, rendered with `textContent` only. One implementation, so the
 * person sees the same preview whichever signer they use (DT-15).
 */
export interface SummaryTexts {
  readonly project: string;
  readonly gate: string;
  readonly version: string;
  readonly firstVersion: string;
  readonly changes: string;
  readonly noChanges: string;
  readonly kinds: Readonly<Record<SignDialogChange['kind'], string>>;
  readonly change: Readonly<Record<SignDialogChange['change'], string>>;
  readonly lockAdded: string;
  readonly lockRemoved: string;
  readonly lockedWarning: string;
  readonly unverified: string;
  readonly unset: string;
}

export interface SummaryView {
  readonly project: string;
  readonly gate: string;
  readonly version: number;
  readonly previousVersion: number;
  readonly locked: boolean;
  readonly changes: readonly SignDialogChange[];
  readonly previous: SignDialogView['previous'];
}

export function renderSummary(
  view: SummaryView,
  t: SummaryTexts,
  byId: <T extends HTMLElement = HTMLElement>(id: string) => T,
): void {
  const setText = (id: string, text: string) => {
    byId(id).textContent = text;
  };
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
}
