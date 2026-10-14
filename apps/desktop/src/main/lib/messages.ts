/**
 * The few texts the main process shows itself (dialogs, menu), in the system's language: German
 * for any de-*, English otherwise. The window's texts live in apps/web's message files.
 */
import type { KeyDialogTexts } from '../../shared/key-dialog';
import type { DeployPackage, DeployTexts } from './deploy';
import type { SealDialogTexts } from '../../shared/seal-dialog';
import type { SignDialogTexts } from '../../shared/sign-dialog';

export type DesktopLocale = 'de-CH' | 'en';

export function systemLocale(locale: string): DesktopLocale {
  return locale.toLowerCase().startsWith('de') ? 'de-CH' : 'en';
}

/** The page's language when it is one of ours, otherwise the system's. */
export function pageLocale(locale: unknown, system: string): DesktopLocale {
  return locale === 'de-CH' || locale === 'en' ? locale : systemLocale(system);
}

export interface DesktopMessages {
  readonly chooseProject: { readonly title: string; readonly button: string };
  /** «Neues Projekt»: the folder for the new moat.yaml. */
  readonly createProject: { readonly title: string; readonly button: string };
  /** Where the new key file goes. */
  readonly saveKey: {
    readonly title: string;
    readonly button: string;
    readonly filter: string;
    readonly defaultName: string;
  };
  readonly keyDialog: KeyDialogTexts;
  readonly startFailed: {
    readonly title: string;
    readonly detail: (reason: string) => string;
  };
  readonly chooseKey: {
    readonly title: string;
    readonly button: string;
    readonly filter: string;
  };
  readonly signDialog: SignDialogTexts;
  readonly sealDialog: SealDialogTexts;
  /** «Testen» (T-59): the address of the first test request, confirmed outside the page. */
  readonly testRequest: {
    readonly title: string;
    readonly message: (host: string) => string;
    readonly detail: (origin: string) => string;
    readonly send: string;
    readonly cancel: string;
  };
  /** The deploy package (DT-05): where it goes, and the instructions inside it. */
  readonly deploy: DeployTexts & {
    readonly saveZip: {
      readonly title: string;
      readonly button: string;
      readonly filter: string;
    };
    readonly chooseFolder: { readonly title: string; readonly button: string };
  };
  readonly menu: {
    readonly file: string;
    readonly edit: string;
    readonly view: string;
    readonly quit: string;
  };
}

export const MESSAGES: Readonly<Record<DesktopLocale, DesktopMessages>> = {
  'de-CH': {
    chooseProject: {
      title: 'Projekt hinzufügen',
      button: 'Diesen Ordner hinzufügen',
    },
    createProject: {
      title: 'Neues Projekt',
      button: 'Projekt in diesem Ordner anlegen',
    },
    saveKey: {
      title: 'Schlüsseldatei speichern',
      button: 'Hier speichern',
      filter: 'Moat-Schlüsseldatei',
      defaultName: 'moat-signing.moatkey',
    },
    keyDialog: {
      title: 'Neuen Schlüssel erstellen',
      intro:
        'Mit diesem Schlüssel gibst du jede Änderung an deinen Gates frei. Die Schlüsseldatei ist mit deiner Passphrase verschlüsselt. Die Passphrase wird nirgends gespeichert.',
      passphrase: 'Passphrase',
      repeat: 'Passphrase wiederholen',
      hint: 'Mindestens 12 Zeichen. Ein Satz aus mehreren Wörtern ist gut. Ohne Passphrase kann niemand mit der Datei signieren, auch du nicht.',
      show: 'Passphrase anzeigen',
      create: 'Erstellen und speichern…',
      working: 'Der Schlüssel wird erstellt …',
      cancel: 'Abbrechen',
      notices: {
        too_short: 'Die Passphrase ist kürzer als 12 Zeichen.',
        too_long: 'Die Passphrase ist zu lang.',
        mismatch: 'Die beiden Eingaben stimmen nicht überein.',
        exists:
          'Dort liegt schon eine Datei. Eine Schlüsseldatei wird nie überschrieben. Wähle einen anderen Namen.',
        not_writable:
          'Die Datei konnte dort nicht gespeichert werden. Wähle einen anderen Ordner.',
      },
    },
    chooseKey: {
      title: 'Schlüsseldatei wählen',
      button: 'Diese Schlüsseldatei verwenden',
      filter: 'Moat-Schlüsseldatei',
    },
    sealDialog: {
      title: 'Secret versiegeln',
      intro:
        'Der Wert wird hier auf deinem Computer für genau dieses Gate verschlüsselt. Gespeichert wird nur der verschlüsselte Text. Öffnen kann ihn nur dieses Gate, und nur unter diesem Namen.',
      project: 'Projekt',
      gate: 'Gate',
      fingerprint: 'Fingerprint',
      fingerprintHint:
        'Vergleiche den Fingerprint mit dem, den das Gate bei der Installation ausgegeben hat. Weicht er ab, brich ab.',
      secret: 'Secret',
      version: 'Version',
      firstVersion: 'erstmals',
      usedBy: 'Gesendet an',
      unused: 'Kein Upstream verwendet es zurzeit.',
      value: 'Wert',
      valueHint:
        'Füge den Schlüssel oder das Token ein. Moat zeigt ihn danach nie wieder an.',
      show: 'Wert anzeigen',
      seal: 'Versiegeln',
      cancel: 'Abbrechen',
      notices: {
        value_invalid:
          'Der Wert ist leer, länger als 8 KiB oder enthält einen Zeilenumbruch.',
        changed:
          'Gate oder Secret haben sich geändert, während dieses Fenster offen war. Prüfe die Angaben und gib den Wert noch einmal ein.',
      },
    },
    signDialog: {
      title: 'Bundle signieren',
      intro:
        'Prüfe, was das neue Bundle ändert. Erst nach deiner Bestätigung wird es mit deinem Schlüssel signiert und im Projektordner abgelegt.',
      project: 'Projekt',
      gate: 'Gate',
      version: 'Version',
      firstVersion: 'erstes Bundle',
      changes: 'Änderungen gegenüber dem letzten Bundle',
      noChanges:
        'Keine Änderungen. Das Bundle enthält dasselbe wie das letzte.',
      kinds: {
        route: 'Route',
        upstream: 'Upstream',
        secret: 'Secret',
        lock: 'Sperre',
      },
      change: { added: 'neu', removed: 'entfernt', changed: 'geändert' },
      lockAdded: 'sperrt das Gate',
      lockRemoved: 'hebt die Sperre auf',
      lockedWarning:
        'Dieses Bundle sperrt das Gate: Sobald es angenommen ist, beantwortet das Gate keine Anfrage mehr.',
      unverified:
        'Das letzte Bundle ist nicht mit dieser Schlüsseldatei signiert. Darum ist hier alles als neu aufgeführt: Prüfe jeden Eintrag.',
      unset: '(nicht gesetzt)',
      keyFile: 'Schlüsseldatei',
      noKeyFile: 'Noch keine gewählt',
      chooseKey: 'Schlüsseldatei wählen…',
      passphrase: 'Passphrase',
      passphraseRemembered:
        'Im Schlüsselbund gespeichert. Leer lassen, um sie zu verwenden.',
      remember: 'Passphrase im Schlüsselbund merken',
      sign: 'Signieren',
      cancel: 'Abbrechen',
      notices: {
        changed:
          'Das Projekt hat sich geändert, während dieser Dialog offen war. Prüfe die Änderungen noch einmal.',
        keyfile_locked: 'Die Passphrase passt nicht zu dieser Schlüsseldatei.',
        keyfile_invalid: 'Diese Datei ist keine Moat-Schlüsseldatei.',
        remembered_failed:
          'Die gespeicherte Passphrase passt nicht mehr und wurde entfernt. Gib sie neu ein.',
        key_unreadable: 'Die Schlüsseldatei kann nicht gelesen werden.',
        key_missing: 'Wähle zuerst eine Schlüsseldatei.',
        passphrase_missing: 'Gib die Passphrase ein.',
      },
    },
    startFailed: {
      title: 'Moat Desktop konnte nicht starten',
      detail: (reason) => `Grund: ${reason}`,
    },
    testRequest: {
      title: 'Gate erreichen',
      message: (host) => `Anfragen an ${host} senden?`,
      detail: (origin) =>
        `Moat sendet eine Testanfrage oder die Prüfung von aussen an ${origin}. Erlaube das nur, wenn dort dein Gate läuft. Moat fragt für diese Adresse bis zum Beenden nicht noch einmal.`,
      send: 'Erlauben',
      cancel: 'Abbrechen',
    },
    deploy: {
      readmeName: 'LIESMICH.txt',
      readme: (pkg: DeployPackage, bundle: string) =>
        [
          'Moat – Deploy-Paket',
          '',
          `Projekt:        ${pkg.project}`,
          `Gate:           ${pkg.gate}`,
          `Gate-ID:        ${pkg.gateId}`,
          `Bundle-Version: ${pkg.version}${pkg.locked ? ' (sperrt das Gate)' : ''}`,
          `SHA-256 von ${bundle}:`,
          `  ${pkg.bundleSha256}`,
          '',
          'Das Paket enthält kein Secret im Klartext: Das Bundle trägt die Secrets',
          'nur versiegelt, und nur dieses Gate kann sie öffnen.',
          '',
          'So kommt diese Version auf das Gate:',
          '',
          `1. Lade ${bundle} und policy.json auf den Server, am besten in einen`,
          '   Ordner ausserhalb des Web-Ordners.',
          '',
          '2. Vergleiche mit dem Gate, bevor du etwas installierst:',
          '     php moat-gate.php status',
          '   Die Gate-ID muss die oben sein, und die Version des aktiven Bundles',
          `   muss kleiner als ${pkg.version} sein. Sonst brich hier ab.`,
          '',
          '3. Bundle aktivieren:',
          `     php moat-gate.php accept <Pfad>/${bundle}`,
          '   Das Gate prüft Signatur, Gate-ID, Version und Policy selbst und',
          '   lehnt ab, was nicht passt.',
          '',
          '4. Nur beim ersten Mal, oder wenn accept das Bundle ablehnt, weil es',
          '   nicht zur Policy passt, und nur, wenn du die Policy auf dem Server',
          '   nicht von Hand angepasst hast (etwa für Lazy Pull): Policy',
          '   installieren und Schritt 3 wiederholen.',
          '     php moat-gate.php policy <Pfad>/policy.json',
          '',
          '5. Lösche die beiden Dateien danach wieder vom Server.',
          '',
          `Mit Lazy Pull lädst du nur ${bundle} an die Adresse aus der Policy`,
          '(pull.url) hoch, unter dem Dateinamen, den sie nennt.',
          '',
        ].join('\n'),
      saveZip: {
        title: 'Deploy-Paket speichern',
        button: 'Speichern',
        filter: 'ZIP-Archiv',
      },
      chooseFolder: {
        title: 'Ordner für das Deploy-Paket wählen',
        button: 'Hier ablegen',
      },
    },
    menu: {
      file: 'Datei',
      edit: 'Bearbeiten',
      view: 'Ansicht',
      quit: 'Beenden',
    },
  },
  en: {
    chooseProject: { title: 'Add project', button: 'Add this folder' },
    createProject: {
      title: 'New project',
      button: 'Create the project in this folder',
    },
    saveKey: {
      title: 'Save key file',
      button: 'Save here',
      filter: 'Moat key file',
      defaultName: 'moat-signing.moatkey',
    },
    keyDialog: {
      title: 'Create a new key',
      intro:
        'You approve every change to your gates with this key. The key file is encrypted with your passphrase. The passphrase is not stored anywhere.',
      passphrase: 'Passphrase',
      repeat: 'Repeat passphrase',
      hint: 'At least 12 characters. A sentence of several words works well. Without the passphrase nobody can sign with the file, not even you.',
      show: 'Show passphrase',
      create: 'Create and save…',
      working: 'Creating the key …',
      cancel: 'Cancel',
      notices: {
        too_short: 'The passphrase is shorter than 12 characters.',
        too_long: 'The passphrase is too long.',
        mismatch: 'The two entries do not match.',
        exists:
          'There is a file at that place already. A key file is never overwritten. Choose another name.',
        not_writable:
          'The file could not be saved there. Choose another folder.',
      },
    },
    chooseKey: {
      title: 'Choose key file',
      button: 'Use this key file',
      filter: 'Moat key file',
    },
    sealDialog: {
      title: 'Seal secret',
      intro:
        'The value is encrypted here on your computer for exactly this gate. Only the encrypted text is saved. Only this gate can open it, and only under this name.',
      project: 'Project',
      gate: 'Gate',
      fingerprint: 'Fingerprint',
      fingerprintHint:
        'Compare the fingerprint with the one the gate printed when it was installed. If it differs, cancel.',
      secret: 'Secret',
      version: 'Version',
      firstVersion: 'first time',
      usedBy: 'Sent to',
      unused: 'No upstream uses it at the moment.',
      value: 'Value',
      valueHint:
        'Paste the key or token. Moat never shows it again afterwards.',
      show: 'Show value',
      seal: 'Seal',
      cancel: 'Cancel',
      notices: {
        value_invalid:
          'The value is empty, longer than 8 KiB or contains a line break.',
        changed:
          'The gate or the secret changed while this window was open. Check the details and enter the value again.',
      },
    },
    signDialog: {
      title: 'Sign bundle',
      intro:
        'Check what the new bundle changes. Only after you confirm is it signed with your key and saved in the project folder.',
      project: 'Project',
      gate: 'Gate',
      version: 'Version',
      firstVersion: 'first bundle',
      changes: 'Changes since the last bundle',
      noChanges: 'No changes. The bundle holds the same as the last one.',
      kinds: {
        route: 'Route',
        upstream: 'Upstream',
        secret: 'Secret',
        lock: 'Lock',
      },
      change: { added: 'new', removed: 'removed', changed: 'changed' },
      lockAdded: 'locks the gate',
      lockRemoved: 'lifts the lock',
      lockedWarning:
        'This bundle locks the gate: once it is accepted, the gate answers no request.',
      unverified:
        'The latest bundle is not signed with this key file, so everything is listed as new: check every entry.',
      unset: '(not set)',
      keyFile: 'Key file',
      noKeyFile: 'None chosen yet',
      chooseKey: 'Choose key file…',
      passphrase: 'Passphrase',
      passphraseRemembered: 'Saved in the keychain. Leave empty to use it.',
      remember: 'Remember passphrase in the keychain',
      sign: 'Sign',
      cancel: 'Cancel',
      notices: {
        changed:
          'The project changed while this dialog was open. Check the changes again.',
        keyfile_locked: 'The passphrase does not match this key file.',
        keyfile_invalid: 'This file is not a Moat key file.',
        remembered_failed:
          'The saved passphrase no longer matches and was removed. Enter it again.',
        key_unreadable: 'The key file cannot be read.',
        key_missing: 'Choose a key file first.',
        passphrase_missing: 'Enter the passphrase.',
      },
    },
    startFailed: {
      title: 'Moat Desktop could not start',
      detail: (reason) => `Reason: ${reason}`,
    },
    testRequest: {
      title: 'Reach the gate',
      message: (host) => `Send requests to ${host}?`,
      detail: (origin) =>
        `Moat sends a test request or the check from outside to ${origin}. Allow this only if your gate runs there. Moat does not ask again for this address until it quits.`,
      send: 'Allow',
      cancel: 'Cancel',
    },
    deploy: {
      readmeName: 'README.txt',
      readme: (pkg: DeployPackage, bundle: string) =>
        [
          'Moat – deploy package',
          '',
          `Project:        ${pkg.project}`,
          `Gate:           ${pkg.gate}`,
          `Gate id:        ${pkg.gateId}`,
          `Bundle version: ${pkg.version}${pkg.locked ? ' (locks the gate)' : ''}`,
          `SHA-256 of ${bundle}:`,
          `  ${pkg.bundleSha256}`,
          '',
          'The package holds no secret in plain text: the bundle carries the secrets',
          'sealed only, and only this gate can open them.',
          '',
          'How this version gets onto the gate:',
          '',
          `1. Upload ${bundle} and policy.json to the server, preferably to a`,
          '   folder outside the web root.',
          '',
          '2. Compare with the gate before you install anything:',
          '     php moat-gate.php status',
          "   The gate id must be the one above, and the active bundle's version",
          `   must be lower than ${pkg.version}. Otherwise stop here.`,
          '',
          '3. Activate the bundle:',
          `     php moat-gate.php accept <path>/${bundle}`,
          '   The gate checks signature, gate id, version and policy itself and',
          '   refuses what does not fit.',
          '',
          '4. Only the first time, or when accept refuses the bundle because it',
          '   does not fit the policy, and only if you have not edited the policy',
          '   on the server by hand (for lazy pull, say): install the policy and',
          '   repeat step 3.',
          '     php moat-gate.php policy <path>/policy.json',
          '',
          '5. Delete both files from the server afterwards.',
          '',
          `With lazy pull, upload only ${bundle} to the address in the policy`,
          '(pull.url), under the file name it gives.',
          '',
        ].join('\n'),
      saveZip: {
        title: 'Save deploy package',
        button: 'Save',
        filter: 'ZIP archive',
      },
      chooseFolder: {
        title: 'Choose the folder for the deploy package',
        button: 'Put it here',
      },
    },
    menu: { file: 'File', edit: 'Edit', view: 'View', quit: 'Quit' },
  },
};
