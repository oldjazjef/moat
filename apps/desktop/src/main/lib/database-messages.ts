import type { DatabaseDialogTexts } from '../../shared/database-dialog';
import type { DesktopLocale } from './messages';

/**
 * The database window's texts (DT-03), in the page's language. Kept apart from messages.ts so the
 * window and its texts travel together.
 */
export const DATABASE_MESSAGES: Readonly<
  Record<DesktopLocale, DatabaseDialogTexts>
> = {
  'de-CH': {
    title: 'Externe Datenbank',
    intro:
      'Moat legt eine Kopie des Projekts in einer PostgreSQL-Datenbank ab oder holt neuere Dateien von dort: moat.yaml, die öffentlichen Gate-Dateien, versiegelte Secrets und signierte Bundles. Nie ein Secret im Klartext, nie der Schlüssel. Fehlt Moats Struktur in der Datenbank, legt Moat sie an.',
    project: 'Projekt',
    target: 'Verbindung',
    url: 'Verbindungs-URL',
    urlHint:
      'postgresql://benutzer:passwort@host:5432/datenbank — ausser für diesen Rechner nur mit geprüftem TLS.',
    urlRemembered: 'Leer lassen, um die gespeicherte Verbindung zu verwenden.',
    key: 'Name in der Datenbank',
    keyHint:
      'Alle, die dasselbe Projekt teilen, verwenden denselben Namen (Kleinbuchstaben, Ziffern, «-»).',
    remember: 'Verbindung im Schlüsselbund des Systems merken',
    push: 'In Datenbank sichern',
    pull: 'Aus Datenbank holen',
    forget: 'Verbindung vergessen',
    close: 'Schliessen',
    resultTitle: {
      push: 'In die Datenbank gesichert',
      pull: 'Aus der Datenbank geholt',
    },
    resultConfig: 'moat.yaml geschrieben',
    resultUnchanged: 'moat.yaml unverändert',
    resultGates: 'Gates',
    resultSecrets: 'Versiegelte Secrets',
    resultBundles: 'Bundles',
    resultIssues: 'Nichts überschrieben bei:',
    notices: {
      url_missing: 'Bitte die Verbindungs-URL eingeben.',
      url_invalid:
        'Das ist keine PostgreSQL-URL, die Moat annimmt (nur «sslmode» als Option).',
      tls_required:
        'Für eine Datenbank auf einem anderen Rechner verlangt Moat TLS mit geprüftem Zertifikat.',
      connect_failed:
        'Keine Verbindung: Adresse, Anmeldung oder Zertifikat stimmen nicht.',
      foreign_tables:
        'Die Datenbank enthält Tabellen, die nicht von Moat sind. Moat verwendet nur eine eigene, leere Datenbank.',
      schema_newer:
        'Eine neuere Moat-Version hat diese Datenbank eingerichtet. Bitte Moat aktualisieren.',
      schema_damaged:
        'Moats Struktur in dieser Datenbank ist unvollständig oder verändert. Moat ändert nichts daran.',
      key_invalid:
        'Der Name: Kleinbuchstaben, Ziffern und «-», mit einem Buchstaben am Anfang.',
      key_missing:
        'Zuerst einen Signaturschlüssel wählen: Moat kopiert nur Bundles, die damit signiert sind.',
      config_missing: 'Das Projekt hat noch keine moat.yaml.',
      changed:
        'Die Datenbank hat sich währenddessen geändert. Nichts wurde geschrieben; bitte nochmals.',
      not_writable: 'Der Projektordner kann nicht geschrieben werden.',
      failed: 'Das hat nicht geklappt.',
      forgotten: 'Die gespeicherte Verbindung ist gelöscht.',
    },
    issues: {
      config_conflict:
        'moat.yaml wurde hier und in der Datenbank geändert — beide bleiben, wie sie sind.',
      config_invalid: 'Die moat.yaml der anderen Seite lässt sich nicht laden.',
      gate_conflict: 'Die Gate-Datei unterscheidet sich',
      gate_not_pinned:
        'Gate nur in der Datenbank: erst unter «Gates» mit Fingerprint hinzufügen',
      secret_conflict: 'Dieselbe Secret-Version mit anderem Inhalt',
      secret_newer_elsewhere: 'Neuere Secret-Version in der Datenbank',
      bundle_conflict: 'Dieselbe Bundle-Version anders signiert',
      bundle_newer_elsewhere: 'Neuere Bundle-Version in der Datenbank',
      bundle_unverified:
        'Bundle nicht mit diesem Schlüssel für dieses Gate signiert',
    },
  },
  en: {
    title: 'External database',
    intro:
      'Moat keeps a copy of the project in a PostgreSQL database or fetches newer files from it: moat.yaml, the gates’ public files, sealed secrets and signed bundles. Never a plaintext secret, never the key. When the database lacks Moat’s structure, Moat creates it.',
    project: 'Project',
    target: 'Connection',
    url: 'Connection URL',
    urlHint:
      'postgresql://user:password@host:5432/database — verified TLS required except for this computer.',
    urlRemembered: 'Leave empty to use the saved connection.',
    key: 'Name in the database',
    keyHint:
      'Everyone sharing the project uses the same name (lower-case letters, digits, “-”).',
    remember: 'Remember the connection in the system keychain',
    push: 'Back up to database',
    pull: 'Fetch from database',
    forget: 'Forget connection',
    close: 'Close',
    resultTitle: {
      push: 'Backed up to the database',
      pull: 'Fetched from the database',
    },
    resultConfig: 'moat.yaml written',
    resultUnchanged: 'moat.yaml unchanged',
    resultGates: 'Gates',
    resultSecrets: 'Sealed secrets',
    resultBundles: 'Bundles',
    resultIssues: 'Nothing overwritten for:',
    notices: {
      url_missing: 'Please enter the connection URL.',
      url_invalid:
        'That is not a PostgreSQL URL Moat accepts (only “sslmode” as an option).',
      tls_required:
        'For a database on another computer Moat requires TLS with a verified certificate.',
      connect_failed:
        'No connection: the address, sign-in or certificate is not right.',
      foreign_tables:
        'The database holds tables that are not Moat’s. Moat only uses an empty database of its own.',
      schema_newer:
        'A newer version of Moat set this database up. Please update Moat.',
      schema_damaged:
        'Moat’s structure in this database is incomplete or changed. Moat changes nothing.',
      key_invalid:
        'The name: lower-case letters, digits and “-”, starting with a letter.',
      key_missing:
        'Choose a signing key first: Moat copies only bundles signed with it.',
      config_missing: 'The project has no moat.yaml yet.',
      changed:
        'The database changed meanwhile. Nothing was written; please try again.',
      not_writable: 'The project folder cannot be written.',
      failed: 'That did not work.',
      forgotten: 'The saved connection is deleted.',
    },
    issues: {
      config_conflict:
        'moat.yaml changed here and in the database — both stay as they are.',
      config_invalid: 'The other side’s moat.yaml does not load.',
      gate_conflict: 'The gate file differs',
      gate_not_pinned:
        'Gate only in the database: add it under “Gates” with its fingerprint first',
      secret_conflict: 'The same secret version with other content',
      secret_newer_elsewhere: 'Newer secret version in the database',
      bundle_conflict: 'The same bundle version signed differently',
      bundle_newer_elsewhere: 'Newer bundle version in the database',
      bundle_unverified: 'Bundle not signed with this key for this gate',
    },
  },
};
