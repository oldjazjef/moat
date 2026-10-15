/**
 * The few texts the main process shows itself (dialogs, menu), in the system's language: German
 * for any de-*, English otherwise. The window's texts live in apps/web's message files.
 */
import type { KeyDialogTexts } from '../../shared/key-dialog';
import type { DeployPackage, DeployTexts } from './deploy';
import type { FtpsDialogTexts } from '../../shared/ftps-dialog';
import type { SealDialogTexts } from '../../shared/seal-dialog';
import type { SftpDialogTexts } from '../../shared/sftp-dialog';
import type {
  PasskeyEnrollTexts,
  PasskeySignTexts,
} from '../../shared/passkey-dialog';
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
  /** Trust mode 2: «Passkey anlegen» and signing with the passkey. */
  readonly passkeyDialog: PasskeyEnrollTexts;
  readonly passkeySignDialog: PasskeySignTexts;
  readonly sealDialog: SealDialogTexts;
  /** «Testen» (T-59): the address of the first test request, confirmed outside the page. */
  readonly testRequest: {
    readonly title: string;
    readonly message: (host: string) => string;
    readonly detail: (origin: string) => string;
    readonly send: string;
    readonly cancel: string;
  };
  /** Settings the page asks to change, confirmed in a message box of the main process. */
  readonly confirmChange: {
    readonly keyRotationDone: {
      readonly title: string;
      readonly message: string;
      readonly detail: string;
      readonly confirm: string;
    };
    readonly passkeyUse: {
      readonly title: string;
      readonly on: string;
      readonly off: string;
      readonly detail: (gate: string) => string;
      readonly confirm: string;
    };
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
    /** Git (T-68): the working copy folder, then a confirmation with branch and remote. */
    readonly git: {
      readonly chooseFolder: {
        readonly title: string;
        readonly button: string;
      };
      readonly confirm: {
        readonly title: string;
        /** {package}, {folder} */
        readonly message: string;
        /** {branch}, {remote}, {remoteBranch}, {url} */
        readonly detail: string;
        readonly push: string;
        readonly other: string;
        readonly cancel: string;
      };
    };
  };
  /** The SFTP window (DT-05) and its file dialog for a private key. */
  readonly sftpDialog: SftpDialogTexts;
  readonly sftpKey: { readonly title: string; readonly button: string };
  /** Import (FR-45): a bundle file or package ZIP, or a package folder. */
  /** «Log ansehen» (DT-12): the dialog that chooses a gate's log files. */
  readonly requestLog: {
    readonly title: string;
    readonly button: string;
    readonly filter: string;
  };
  readonly importBundle: {
    readonly chooseFile: {
      readonly title: string;
      readonly button: string;
      readonly filter: string;
    };
    readonly chooseFolder: { readonly title: string; readonly button: string };
  };
  /** The FTPS window (DT-05, T-69). */
  readonly ftpsDialog: FtpsDialogTexts;
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
      comparedBy: 'Nur verglichen mit dem API-Schlüssel des Aufrufers (Routen)',
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
    passkeyDialog: {
      title: 'Passkey anlegen',
      intro:
        'Moat legt auf diesem Gerät einen Passkey an. Er gibt künftig deine Bundles frei (Vertrauensmodus 2, „Signiert mit Passkey“). Der private Schlüssel verlässt den Passkey nie; Moat speichert nur den öffentlichen Schlüssel.',
      honesty:
        'Moat Desktop hat keine eigene Passkey-Oberfläche. Es klappt nur, wenn dein Betriebssystem Chromium einen Passkey anbietet (zum Beispiel Windows Hello). Sonst meldet dieses Fenster, dass keiner verfügbar ist, und Modus 2 bleibt aus.',
      rpId: 'Relying-Party-ID',
      origin: 'Origin',
      replaces:
        'Es gibt schon einen Passkey. Der neue ersetzt ihn: Gates, die den alten gepinnt haben, nehmen deine Bundles nicht mehr an, bis du den neuen am Gate pinnst.',
      create: 'Passkey anlegen',
      cancel: 'Abbrechen',
      close: 'Schliessen',
      doneTitle: 'Passkey angelegt',
      doneIntro:
        'Pinne den Passkey jetzt am Gate, auf dem Server. Vergleiche vorher den Fingerprint, den das Gate ausgibt, mit diesem.',
      fingerprint: 'Fingerprint',
      publicKey: 'Öffentlicher Schlüssel',
      trustCommand: 'Befehl für ein bestehendes Gate',
      installCommand: 'Befehl für ein neues Gate',
      compare:
        'Der Befehl pinnt den Passkey als einzigen Signer. Den Modus wechseln kannst du nur am Gate selbst.',
      notices: {
        cancelled:
          'Der Passkey wurde nicht angelegt (abgebrochen oder Zeit abgelaufen).',
        unavailable:
          'Auf diesem System steht Moat Desktop kein Passkey zur Verfügung. Vertrauensmodus 2 ist hier nicht möglich; nutze eine Schlüsseldatei (Modus 1).',
        failed: 'Das System hat keinen Passkey geliefert.',
        invalid:
          'Der Passkey passt nicht zu dem, was Moat angefordert hat. Er wurde nicht gespeichert.',
        not_writable: 'Die Einstellungen konnten nicht gespeichert werden.',
      },
    },
    passkeySignDialog: {
      title: 'Bundle mit Passkey signieren',
      intro:
        'Prüfe, was das neue Bundle ändert. Erst nach deiner Bestätigung am Passkey wird es signiert und im Projektordner abgelegt. Der Passkey signiert genau dieses Bundle.',
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
        'Das letzte Bundle ist nicht mit diesem Passkey signiert. Darum ist hier alles als neu aufgeführt: Prüfe jeden Eintrag.',
      unset: '(nicht gesetzt)',
      passkey: 'Passkey',
      sign: 'Mit Passkey signieren',
      signing: 'Warte auf den Passkey …',
      cancel: 'Abbrechen',
      notices: {
        changed:
          'Das Projekt hat sich geändert, während dieser Dialog offen war. Prüfe die Änderungen noch einmal.',
        cancelled:
          'Der Passkey hat nicht signiert (abgebrochen oder Zeit abgelaufen). Es wurde nichts gespeichert.',
        unavailable:
          'Auf diesem System steht Moat Desktop kein Passkey zur Verfügung. Es wurde nichts gespeichert.',
        failed:
          'Das System hat keine Signatur geliefert. Es wurde nichts gespeichert.',
        assertion_invalid:
          'Die Signatur gehört nicht zum gepinnten Passkey oder zu diesem Bundle. Es wurde nichts gespeichert.',
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
    confirmChange: {
      keyRotationDone: {
        title: 'Schlüsselwechsel abschliessen',
        message: 'Den alten Schlüssel vergessen?',
        detail:
          'Moat vergisst den alten Signaturschlüssel. Bestätige das nur, wenn jedes Gate den neuen Schlüssel allein eingetragen hat (SEC-08).',
        confirm: 'Alten Schlüssel vergessen',
      },
      passkeyUse: {
        title: 'Passkey für ein Gate',
        on: 'Dieses Gate mit dem Passkey signieren?',
        off: 'Dieses Gate nicht mehr mit dem Passkey signieren?',
        detail: (gate) =>
          `Gate «${gate}»: Neue Bundles signierst du danach mit der Passkey-Bestätigung am Gerät, sofern das Gate den Passkey angenommen hat. Erlaube das nur, wenn du es selbst ausgelöst hast.`,
        confirm: 'Ändern',
      },
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
      git: {
        chooseFolder: {
          title: 'Ordner in deiner Git-Arbeitskopie wählen',
          button: 'Diesen Ordner verwenden',
        },
        confirm: {
          title: 'Per Git ausliefern',
          message: 'Paket {package} nach {folder} committen und pushen?',
          detail:
            'Moat legt das Paket als neuen Ordner an, committet nur diesen Ordner auf den Branch {branch} und pusht ihn nach {remote} ({remoteBranch}): {url}. Deine anderen Änderungen bleiben ungepusht in deiner Arbeitskopie. Hooks des Repositorys führt Moat nicht aus.',
          push: 'Committen und pushen',
          other: 'Anderen Ordner wählen',
          cancel: 'Abbrechen',
        },
      },
    },
    sftpDialog: {
      title: 'Per SFTP hochladen',
      intro:
        'Moat Desktop legt das Paket als neuen Ordner auf deinem Server ab. Es ersetzt dort nichts und führt keinen Befehl aus. Danach aktivierst du das Bundle wie in der Anleitung im Paket.',
      project: 'Projekt',
      gate: 'Gate',
      version: 'Version',
      files: 'Dateien',
      host: 'Server',
      port: 'Port',
      username: 'Benutzer',
      remoteDir: 'Ordner auf dem Server',
      remoteDirHint:
        'Relativ zu deinem Login-Ordner oder absolut, etwa moat-uploads. Der Ordner muss es schon geben, am besten ausserhalb des Web-Ordners.',
      auth: 'Anmeldung',
      authPassword: 'Passwort',
      authKey: 'SSH-Schlüssel',
      keyFile: 'Schlüsseldatei',
      noKeyFile: 'Noch keine gewählt',
      chooseKey: 'Schlüsseldatei wählen…',
      password: 'Passwort',
      passphrase: 'Passphrase des Schlüssels (leer, wenn er keine hat)',
      secretRemembered:
        'Im Schlüsselbund gespeichert. Leer lassen, um es zu verwenden.',
      remember: 'Im Schlüsselbund merken',
      pinned: 'Host-Key bestätigt:',
      upload: 'Hochladen',
      forget: 'Ziel entfernen',
      cancel: 'Abbrechen',
      hostKeyTitle: 'Host-Key des Servers prüfen',
      hostKeyIntro:
        'Moat Desktop verbindet sich zum ersten Mal mit diesem Server. Er hat sich mit diesem Schlüssel ausgewiesen:',
      hostKeyHint:
        'Vergleiche ihn mit dem Fingerprint, den dein Hoster nennt, oder mit ssh-keyscan auf einem Rechner, dem du vertraust. Erst nach deiner Bestätigung sendet Moat Benutzer, Passwort und Dateien. Moat merkt sich den Schlüssel und bricht ab, wenn der Server später einen anderen zeigt.',
      trust: 'Schlüssel stimmt, hochladen',
      notices: {
        target_invalid:
          'Prüfe Server, Port, Benutzer und Ordner. Der Ordner darf nur Buchstaben, Ziffern und . _ ~ - enthalten, ohne . oder .. als Teil.',
        key_missing: 'Wähle zuerst die Schlüsseldatei.',
        key_unreadable: 'Die Schlüsseldatei kann nicht gelesen werden.',
        secret_missing: 'Gib das Passwort ein.',
        connect_failed:
          'Der Server ist nicht erreichbar oder hat die Verbindung beendet.',
        auth_failed:
          'Die Anmeldung wurde abgelehnt. Prüfe Benutzer und Passwort oder Schlüssel.',
        hostkey_changed:
          'Der Server zeigt einen anderen Host-Key als beim letzten Mal. Moat hat nichts gesendet. Frag deinen Hoster, ob der Schlüssel gewechselt hat. Nur dann entfernst du das Ziel und bestätigst den neuen Schlüssel.',
        exists:
          'Auf dem Server liegt schon ein Ordner mit dem Namen dieses Pakets. Es wurde nichts überschrieben.',
        partial:
          'Das Hochladen brach mittendrin ab. Der Paketordner auf dem Server ist unvollständig: Lösche ihn, bevor du es noch einmal versuchst.',
        upload_failed:
          'Hochladen hat nicht geklappt. Gibt es den Ordner auf dem Server, und darfst du dort schreiben?',
        forgotten:
          'Das Ziel ist entfernt. Beim nächsten Hochladen bestätigst du den Host-Key neu.',
      },
    },
    sftpKey: {
      title: 'SSH-Schlüssel wählen',
      button: 'Diesen Schlüssel verwenden',
    },
    requestLog: {
      title: 'Log-Dateien des Gates wählen (log.php, logold.php)',
      button: 'Öffnen',
      filter: 'Log des Gates',
    },
    importBundle: {
      chooseFile: {
        title: 'Bundle oder Deploy-Paket importieren',
        button: 'Importieren',
        filter: 'Bundle oder ZIP',
      },
      chooseFolder: {
        title: 'Ordner des Deploy-Pakets wählen',
        button: 'Diesen Ordner importieren',
      },
    },
    ftpsDialog: {
      title: 'Per FTPS hochladen',
      intro:
        'Moat Desktop legt das Paket als neuen Ordner auf deinem Server ab, immer verschlüsselt (FTP über TLS). Es ersetzt dort nichts. Danach aktivierst du das Bundle wie in der Anleitung im Paket.',
      project: 'Projekt',
      gate: 'Gate',
      version: 'Version',
      files: 'Dateien',
      host: 'Server',
      port: 'Port',
      username: 'Benutzer',
      remoteDir: 'Ordner auf dem Server',
      remoteDirHint:
        'Relativ zu deinem Login-Ordner oder absolut, etwa moat-uploads. Der Ordner muss es schon geben, am besten ausserhalb des Web-Ordners.',
      mode: 'Verschlüsselung',
      modeExplicit: 'Explizites FTPS (AUTH TLS, meist Port 21)',
      modeImplicit: 'Implizites FTPS (meist Port 990)',
      modeHint:
        'Unverschlüsseltes FTP bietet Moat nicht an: Spricht der Server kein TLS, bricht Moat ab, bevor es Benutzer oder Passwort sendet.',
      password: 'Passwort',
      secretRemembered:
        'Im Schlüsselbund gespeichert. Leer lassen, um es zu verwenden.',
      remember: 'Im Schlüsselbund merken',
      pinned: 'Zertifikat bestätigt:',
      upload: 'Hochladen',
      forget: 'Ziel entfernen',
      cancel: 'Abbrechen',
      certificateTitle: 'Zertifikat des Servers prüfen',
      certificateIntro:
        'Keine bekannte Zertifizierungsstelle bestätigt dieses Zertifikat für diesen Server, etwa weil es selbst signiert ist. Der Server hat sich damit ausgewiesen:',
      fingerprint: 'SHA-256-Fingerprint',
      subject: 'Ausgestellt für',
      issuer: 'Ausgestellt von',
      validTo: 'Gültig bis',
      certificateHint:
        'Vergleiche den Fingerprint mit dem, den dein Hoster nennt, oder mit openssl s_client auf einem Rechner, dem du vertraust. Erst nach deiner Bestätigung sendet Moat Benutzer, Passwort und Dateien. Moat merkt sich das Zertifikat und bricht ab, wenn der Server später ein anderes zeigt.',
      trust: 'Zertifikat stimmt, hochladen',
      notices: {
        target_invalid:
          'Prüfe Server, Port, Benutzer und Ordner. Der Ordner darf nur Buchstaben, Ziffern und . _ ~ - enthalten, ohne . oder .. als Teil.',
        secret_missing: 'Gib das Passwort ein.',
        connect_failed:
          'Der Server ist nicht erreichbar oder hat die Verbindung beendet.',
        tls_failed:
          'Der Server bietet hier kein FTPS an (nur unverschlüsseltes FTP), oder die TLS-Verbindung kam nicht zustande. Moat hat weder Benutzer noch Passwort gesendet. Prüfe Port und Art der Verschlüsselung.',
        auth_failed:
          'Die Anmeldung wurde abgelehnt. Prüfe Benutzer und Passwort.',
        certificate_changed:
          'Der Server zeigt ein anderes Zertifikat als beim letzten Mal. Moat hat weder Benutzer noch Passwort gesendet. Frag deinen Hoster, ob das Zertifikat gewechselt hat. Nur dann entfernst du das Ziel und bestätigst das neue.',
        exists:
          'Auf dem Server liegt schon ein Ordner mit dem Namen dieses Pakets. Es wurde nichts überschrieben.',
        partial:
          'Das Hochladen brach mittendrin ab. Der Paketordner auf dem Server ist unvollständig: Lösche ihn, bevor du es noch einmal versuchst.',
        upload_failed:
          'Hochladen hat nicht geklappt. Gibt es den Ordner auf dem Server, und darfst du dort schreiben?',
        forgotten:
          'Das Ziel ist entfernt. Beim nächsten Hochladen bestätigst du das Zertifikat neu, falls keine Zertifizierungsstelle es bestätigt.',
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
      comparedBy: "Only compared with the caller's API key (routes)",
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
    passkeyDialog: {
      title: 'Create passkey',
      intro:
        'Moat creates a passkey on this device. From now on it approves your bundles (trust mode 2, “Signed with passkey”). The private key never leaves the passkey; Moat stores only the public key.',
      honesty:
        'Moat Desktop has no passkey interface of its own. It works only when your operating system offers Chromium a passkey (for example Windows Hello). Otherwise this window says none is available, and mode 2 stays off.',
      rpId: 'Relying party ID',
      origin: 'Origin',
      replaces:
        'A passkey exists already. The new one replaces it: gates that pinned the old one no longer accept your bundles until you pin the new one on the gate.',
      create: 'Create passkey',
      cancel: 'Cancel',
      close: 'Close',
      doneTitle: 'Passkey created',
      doneIntro:
        'Pin the passkey on the gate, on the server, now. First compare the fingerprint the gate prints with this one.',
      fingerprint: 'Fingerprint',
      publicKey: 'Public key',
      trustCommand: 'Command for an existing gate',
      installCommand: 'Command for a new gate',
      compare:
        'The command pins the passkey as the only signer. You can change the mode only on the gate itself.',
      notices: {
        cancelled: 'No passkey was created (cancelled or timed out).',
        unavailable:
          'This system offers Moat Desktop no passkey. Trust mode 2 is not possible here; use a key file (mode 1).',
        failed: 'The system did not return a passkey.',
        invalid:
          'The passkey does not match what Moat asked for. It was not stored.',
        not_writable: 'The settings could not be saved.',
      },
    },
    passkeySignDialog: {
      title: 'Sign bundle with passkey',
      intro:
        'Check what the new bundle changes. Only after you confirm at the passkey is it signed and saved in the project folder. The passkey signs exactly this bundle.',
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
        'The latest bundle is not signed with this passkey, so everything is listed as new: check every entry.',
      unset: '(not set)',
      passkey: 'Passkey',
      sign: 'Sign with passkey',
      signing: 'Waiting for the passkey …',
      cancel: 'Cancel',
      notices: {
        changed:
          'The project changed while this dialog was open. Check the changes again.',
        cancelled:
          'The passkey did not sign (cancelled or timed out). Nothing was saved.',
        unavailable:
          'This system offers Moat Desktop no passkey. Nothing was saved.',
        failed: 'The system returned no signature. Nothing was saved.',
        assertion_invalid:
          'The signature does not belong to the pinned passkey or to this bundle. Nothing was saved.',
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
    confirmChange: {
      keyRotationDone: {
        title: 'Finish the key change',
        message: 'Forget the old key?',
        detail:
          'Moat forgets the old signing key. Confirm only if every gate now pins the new key alone (SEC-08).',
        confirm: 'Forget old key',
      },
      passkeyUse: {
        title: 'Passkey for a gate',
        on: 'Sign this gate with the passkey?',
        off: 'Stop signing this gate with the passkey?',
        detail: (gate) =>
          `Gate “${gate}”: new bundles are then signed with the passkey confirmation on your device, provided the gate has accepted the passkey. Allow this only if you started it yourself.`,
        confirm: 'Change',
      },
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
      git: {
        chooseFolder: {
          title: 'Choose a folder in your Git working copy',
          button: 'Use this folder',
        },
        confirm: {
          title: 'Deliver via Git',
          message: 'Commit and push package {package} to {folder}?',
          detail:
            "Moat adds the package as a new folder, commits only that folder on branch {branch} and pushes it to {remote} ({remoteBranch}). Your other changes stay as they are. Moat runs none of the repository's hooks.",
          push: 'Commit and push',
          other: 'Choose another folder',
          cancel: 'Cancel',
        },
      },
    },
    sftpDialog: {
      title: 'Upload via SFTP',
      intro:
        'Moat Desktop puts the package on your server as a new folder. It replaces nothing there and runs no command. Then you activate the bundle as the instructions in the package say.',
      project: 'Project',
      gate: 'Gate',
      version: 'Version',
      files: 'Files',
      host: 'Server',
      port: 'Port',
      username: 'User',
      remoteDir: 'Folder on the server',
      remoteDirHint:
        'Relative to your login folder or absolute, e.g. moat-uploads. The folder must exist already, preferably outside the web root.',
      auth: 'Sign in with',
      authPassword: 'Password',
      authKey: 'SSH key',
      keyFile: 'Key file',
      noKeyFile: 'None chosen yet',
      chooseKey: 'Choose key file…',
      password: 'Password',
      passphrase: 'The key’s passphrase (empty if it has none)',
      secretRemembered: 'Saved in the keychain. Leave empty to use it.',
      remember: 'Remember in the keychain',
      pinned: 'Host key confirmed:',
      upload: 'Upload',
      forget: 'Remove target',
      cancel: 'Cancel',
      hostKeyTitle: 'Check the server’s host key',
      hostKeyIntro:
        'Moat Desktop connects to this server for the first time. It identified itself with this key:',
      hostKeyHint:
        'Compare it with the fingerprint your hoster gives, or with ssh-keyscan on a computer you trust. Only after you confirm does Moat send user, password and files. Moat remembers the key and stops if the server later shows another.',
      trust: 'Key matches, upload',
      notices: {
        target_invalid:
          'Check server, port, user and folder. The folder may hold only letters, digits and . _ ~ -, with no . or .. as a part.',
        key_missing: 'Choose the key file first.',
        key_unreadable: 'The key file cannot be read.',
        secret_missing: 'Enter the password.',
        connect_failed:
          'The server cannot be reached or closed the connection.',
        auth_failed: 'Sign-in was refused. Check user and password or key.',
        hostkey_changed:
          'The server shows another host key than last time. Moat sent nothing. Ask your hoster whether the key changed. Only then remove the target and confirm the new key.',
        exists:
          "A folder with this package's name is on the server already. Nothing was replaced.",
        partial:
          'The upload stopped halfway. The package folder on the server is incomplete: delete it before you try again.',
        upload_failed:
          'The upload did not work. Does the folder exist on the server, and may you write there?',
        forgotten:
          'The target is removed. On the next upload you confirm the host key again.',
      },
    },
    sftpKey: { title: 'Choose SSH key', button: 'Use this key' },
    requestLog: {
      title: "Choose the gate's log files (log.php, logold.php)",
      button: 'Open',
      filter: 'Gate log',
    },
    importBundle: {
      chooseFile: {
        title: 'Import bundle or deploy package',
        button: 'Import',
        filter: 'Bundle or ZIP',
      },
      chooseFolder: {
        title: 'Choose the deploy package folder',
        button: 'Import this folder',
      },
    },
    ftpsDialog: {
      title: 'Upload via FTPS',
      intro:
        'Moat Desktop puts the package on your server as a new folder, always encrypted (FTP over TLS). It replaces nothing there. Then you activate the bundle as the instructions in the package say.',
      project: 'Project',
      gate: 'Gate',
      version: 'Version',
      files: 'Files',
      host: 'Server',
      port: 'Port',
      username: 'User',
      remoteDir: 'Folder on the server',
      remoteDirHint:
        'Relative to your login folder or absolute, e.g. moat-uploads. The folder must exist already, preferably outside the web root.',
      mode: 'Encryption',
      modeExplicit: 'Explicit FTPS (AUTH TLS, usually port 21)',
      modeImplicit: 'Implicit FTPS (usually port 990)',
      modeHint:
        'Moat does not offer unencrypted FTP: if the server speaks no TLS, Moat stops before it sends user or password.',
      password: 'Password',
      secretRemembered: 'Saved in the keychain. Leave empty to use it.',
      remember: 'Remember in the keychain',
      pinned: 'Certificate confirmed:',
      upload: 'Upload',
      forget: 'Remove target',
      cancel: 'Cancel',
      certificateTitle: 'Check the server’s certificate',
      certificateIntro:
        'No known certificate authority vouches for this certificate for this server, for example because it is self-signed. The server identified itself with it:',
      fingerprint: 'SHA-256 fingerprint',
      subject: 'Issued to',
      issuer: 'Issued by',
      validTo: 'Valid until',
      certificateHint:
        'Compare the fingerprint with the one your hoster gives, or with openssl s_client on a computer you trust. Only after you confirm does Moat send user, password and files. Moat remembers the certificate and stops if the server later shows another.',
      trust: 'Certificate matches, upload',
      notices: {
        target_invalid:
          'Check server, port, user and folder. The folder may hold only letters, digits and . _ ~ -, with no . or .. as a part.',
        secret_missing: 'Enter the password.',
        connect_failed:
          'The server cannot be reached or closed the connection.',
        tls_failed:
          'The server offers no FTPS here (only unencrypted FTP), or the TLS connection failed. Moat sent neither user nor password. Check the port and the kind of encryption.',
        auth_failed: 'Sign-in was refused. Check user and password.',
        certificate_changed:
          'The server shows another certificate than last time. Moat sent neither user nor password. Ask your hoster whether the certificate changed. Only then remove the target and confirm the new one.',
        exists:
          "A folder with this package's name is on the server already. Nothing was replaced.",
        partial:
          'The upload stopped halfway. The package folder on the server is incomplete: delete it before you try again.',
        upload_failed:
          'The upload did not work. Does the folder exist on the server, and may you write there?',
        forgotten:
          'The target is removed. On the next upload you confirm the certificate again, unless a certificate authority vouches for it.',
      },
    },
    menu: { file: 'File', edit: 'Edit', view: 'View', quit: 'Quit' },
  },
};
