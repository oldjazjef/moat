# Moat: Anforderungen (v0.3)

**Produkt:** API-Management für Websites auf normalem Hosting: Secrets verwalten, Proxy, Endpunkt-Gating.
**Komponenten:**
- **Moat Core:** gemeinsame Bibliothek für Schema, Bundle-Bau, Signierung, Verschlüsselung und Gate-Generator. Wird von Cloud, Desktop und CLI genutzt.
- **Moat Desktop:** Desktop-App, die Gates **ohne Cloud** erzeugt, konfiguriert, signiert und deployt.
- **Moat Cloud:** SaaS oder self-hosted (Docker/K8s), Verwaltung, Teams, Monitoring.
- **Moat Gate:** läuft auf dem Hosting des Kunden.
**Priorität:** **M** = MVP, **S** = bald danach, **K** = später.

## Änderungen gegenüber v0.2

| Thema | Entscheidung |
|---|---|
| Betrieb ohne Cloud | Neue Komponente **Moat Desktop** (Abschnitt 3.8). Die Cloud ist optional. |
| Gemeinsamer Kern | **Moat Core** wird von Desktop, Cloud und CLI geteilt (DT-02). |
| Speicherung | Pro Projekt wählbar: Projektordner, SQLite, externe DB, Dateispeicher (DT-03). |
| Vertrauensmodus 0 | In Moat Desktop nicht verfügbar (kein Server, dem das Gate vertrauen könnte). |
| Browser-JS-Problem | Entfällt in der Desktop-App (SEC-37). |

## Änderungen gegenüber v0.1

| Thema | Entscheidung |
|---|---|
| Signierung | Nicht mehr zwingend. Benutzer wählen pro Gate einen **Vertrauensmodus** (0 bis 3, siehe 2.1). Einfachster Weg zuerst. |
| Shared-Hosting-Realität | Gate erkennt seine Umgebung und arbeitet mit **Härtungsstufen** (H1 bis H3) inkl. Fallbacks (siehe 2.5). |
| Manuelle Updates | Gate-Updates und Config-Updates sind getrennt und je einzeln auf **auto / benachrichtigen / aus** stellbar. Manuelles Ablegen von Dateien ist ein vollwertiger Weg. |
| Bundle-Ablauf | **Deaktivierbar, Default: kein Ablauf** (immer gültig). |
| Compromise-Test | Gilt für Vertrauensmodus 1 bis 3. Modus 0 ist bewusst ein Komfort-Modus mit geringerer Garantie. |

---

## 1. Sicherheitsprinzipien

1. **Cloud ist nicht Vertrauensanker** (in den Modi 1 bis 3). Sie speichert und verteilt, aber autorisiert nichts allein.
2. **Config ≠ Code.** Die Cloud liefert nur Daten, nie ausführbaren Code.
3. **Cloud-Config ≤ lokale Policy.** Jedes Gate hat eine lokale Obergrenze, die die Cloud nicht überschreiben kann. Das gilt in **allen** Modi.
4. **Fail-Closed** bei Fehlern, ausser der Benutzer konfiguriert es explizit anders.
5. **Ehrlichkeit im Produkt:** Das Dashboard zeigt pro Gate an, welche Sicherheitsgarantie aktuell gilt (Vertrauensmodus + Härtungsstufe).

**Angriffsszenario (Modus 1 bis 3):** Der Angreifer hat volle Kontrolle über Moat Cloud (DB, Server, Pipeline, Admin-Accounts). Er darf höchstens erreichen, dass Gates nicht mehr aktualisiert werden oder auf der letzten gültigen Config weiterlaufen.

**Angriffsszenario (Modus 0):** Gleicher Angreifer. Er kann die Config ändern, aber nur **innerhalb der lokalen Policy** des Gates (erlaubte Upstreams, Methoden, Limits). Er kann weder Code ausführen noch Secrets im Klartext lesen noch Secrets an fremde Hosts senden.

---

## 2. Sicherheitsanforderungen

### 2.1 Vertrauensmodi (Wer darf Konfiguration freigeben?)

Der Modus wird pro Gate gewählt und kann später gewechselt werden (Wechsel nur mit Bestätigung am Gate, siehe SEC-06).

| Modus | Name | So funktioniert es | Garantie bei gehackter Cloud |
|---|---|---|---|
| **0** | **Managed** (Default in der Cloud, am einfachsten; in Moat Desktop nicht verfügbar) | Gate vertraut der Cloud nach Enrollment (Fingerprint-Bestätigung + gepinnter Cloud-Schlüssel). Keine Signatur durch den Kunden. | Config kann manipuliert werden, aber nur innerhalb der lokalen Policy. Kein Code, keine Klartext-Secrets. |
| **1** | **Key-Datei + Passphrase** (einfaches Signieren) | Beim Setup wird ein Signaturschlüssel erzeugt und als passphrase-geschützte Datei **heruntergeladen**. Die Cloud speichert ihn nie. Signiert wird lokal im Browser, per CLI oder in Moat Desktop. Der Public Key wird am Gate gepinnt (Fingerprint-Bestätigung). | Volle Garantie, sofern der ausgelieferte Browser-Code vertrauenswürdig ist. Für maximale Garantie CLI oder Moat Desktop nutzen (SEC-37). |
| **2** | **Passkey / Hardware-Key** (WebAuthn) | Signieren mit Passkey oder Hardware-Key. Schlüssel verlässt das Gerät nie. | Wie Modus 1, zusätzlich Schutz vor Schlüsseldiebstahl. |
| **3** | **Eigener Signer-Dienst** (S) | Kunde betreibt einen Dienst (oder CI-Job), der Bundles signiert. | Volle Garantie, geeignet für GitOps und Teams. |

Regeln:

| ID | Anforderung | Prio |
|---|---|---|
| SEC-01 | Das Gate führt Bundles nur aus, wenn sie zum **gewählten Modus** passen: Modus 0 prüft die Authentizität gegen den beim Enrollment gepinnten Cloud-Schlüssel, Modus 1 bis 3 gegen den gepinnten **Kunden-Public-Key** (Ed25519 o. ä.). | M |
| SEC-02 | In den Modi 1 bis 3 liegt der private Signaturschlüssel **nie** in der Cloud. Die Cloud kann Bundles nur ablegen und ausliefern. | M |
| SEC-03 | Signatur- oder Authentizitätsfehler führen zum Verwerfen des Bundles. Das Gate läuft mit der letzten gültigen Config weiter. | M |
| SEC-04 | **Rollback-Schutz:** Bundles tragen eine monoton steigende Versionsnummer. Das Gate akzeptiert nur höhere Versionen. Ein Rollback im Dashboard erzeugt eine neue, höhere Version mit altem Inhalt. | M |
| SEC-05 | **Ablauf ist optional.** Default: Bundles laufen nie ab. Wer es aktiviert, wählt Gültigkeitsdauer und Verhalten bei Ablauf (weiterlaufen / eingeschränkt / deny). Das Dashboard warnt vor Ablauf. | M |
| SEC-06 | **Wechsel des Vertrauensmodus oder des gepinnten Schlüssels** ist nur möglich mit lokaler Bestätigung am Gate (Fingerprint-Eingabe oder Datei-Austausch). Die Cloud allein kann den Modus nie abschwächen. | M |
| SEC-07 | Bundles sind an eine **Gate-ID** gebunden (kein Replay zwischen Gates). | M |
| SEC-08 | Schlüsselrotation in Modus 1 bis 3 über eine Schlüsselkette (Root-Key offline, Betriebs-Key rotierbar). Verlust des Keys: dokumentierter Recovery-Weg über manuelles Re-Pinning am Gate. | S |
| SEC-09 | Optional: Vier-Augen-Prinzip (M-of-N-Signaturen) für kritische Änderungen (neuer Upstream, neues Secret). | K |

### 2.2 Lokale Policy (Obergrenze auf dem Gate)

| ID | Anforderung | Prio |
|---|---|---|
| SEC-10 | Das Gate hat eine **lokale Policy** ausserhalb der Cloud-Kontrolle: erlaubte Upstream-Hosts, nur HTTPS, maximale Methoden, maximale Body-Grösse. Sie gilt in allen Vertrauensmodi. | M |
| SEC-11 | Die Cloud-Config kann die Policy nur **einschränken**, nie erweitern. Ein Upstream ausserhalb der lokalen Allowlist wird abgelehnt, auch bei gültiger Signatur. | M |
| SEC-12 | Die Policy ist wenn möglich ausserhalb des Webroots und für den Webserver-Prozess nicht beschreibbar (siehe Härtungsstufen 2.5). | S |
| SEC-13 | Policy-Änderungen erfolgen **nur lokal** (Datei, Env oder Installer), nie über die Cloud. | M |

### 2.3 Keine Code-Injektion

| ID | Anforderung | Prio |
|---|---|---|
| SEC-20 | Konfiguration ist **rein deklarativ** (JSON Schema, `additionalProperties: false`). Keine Skripte, Expressions, `eval`, dynamische Includes oder Template-Engines mit Codeausführung. | M |
| SEC-21 | Das Gate ist ein **fest ausgeliefertes, signiertes Artefakt**. Die Cloud kann es nicht überschreiben, nachladen oder erweitern. | M |
| SEC-22 | **Gate-Updates sind vom Config-Kanal getrennt.** Update-Modus pro Gate: **aus** (nur manuell durch den Kunden), **benachrichtigen** (Gate meldet eine neue Version, Kunde installiert), **auto** (Pull aus Release-Kanal mit Signaturprüfung gegen einen im Gate fest eingebauten Release-Key). Updates kommen nie über den Config-Kanal der Cloud. | M |
| SEC-23 | Eigene Logik nur über vordefinierte, getestete Bausteine (Feld umbenennen, Wert aus Secret einsetzen, Feld entfernen), nicht über frei programmierbare Regeln. | M |
| SEC-24 | Parser-Härtung: Grössen- und Tiefenlimits, keine externen Referenzen (`$ref` auf URLs, XML-Entities). | M |
| SEC-25 | **Manueller Betrieb ist erstklassig:** Das Gate funktioniert vollständig mit manuell abgelegten Dateien (Gate-Artefakt und Config-Bundle). Der Pull von Updates und Configs lässt sich jeweils komplett abschalten. | M |

### 2.4 Secrets

| ID | Anforderung | Prio |
|---|---|---|
| SEC-30 | Jedes Gate erzeugt sein **Schlüsselpaar selbst**. Der private Schlüssel verlässt das Gate nie. | M |
| SEC-31 | Secrets werden **clientseitig** (Browser oder CLI) mit dem Public Key des Gates verschlüsselt. Die Cloud speichert nur Ciphertext. | M |
| SEC-32 | Beim Enrollment wird der **Fingerprint** des Gate-Public-Keys auf dem Gate angezeigt und vom Admin im Dashboard bestätigt. Eine kompromittierte Cloud kann so keinen eigenen Schlüssel unterschieben. | M |
| SEC-33 | Verschlüsselte Secrets sind an Gate-ID und Secret-Namen gebunden (AEAD mit Kontext). | M |
| SEC-34 | Auf dem Gate liegen Secrets verschlüsselt. Secrets erscheinen nie in Logs, Fehlermeldungen, Responses oder Debug-Ausgaben. | M |
| SEC-35 | Secrets werden nur an **vorab definierte Upstreams** gesendet (Bindung Secret → Upstream-Host). | M |
| SEC-36 | Secret-Rotation ohne Downtime (zwei aktive Versionen übergangsweise). | S |
| SEC-37 | Das Browser-Verschlüsseln schützt nur, wenn der ausgelieferte JS-Code vertrauenswürdig ist. Daher gibt es einen **CLI-Weg mit reproduzierbar gebautem Client**. Das Dashboard weist darauf hin. In **Moat Desktop** läuft Verschlüsselung und Signierung lokal, das Problem entfällt dort. | M |
| SEC-38 | Secrets können alternativ **direkt auf dem Gate** hinterlegt werden (Datei/Env), ohne dass sie je in die Cloud gelangen ("Local-only Secret"). | M |

### 2.5 Gate-Laufzeit und Härtungsstufen

**Shared-Hosting-Realität:** Dort gibt es oft keine Env-Variablen, keine Cron-Jobs und kein Schreibrecht ausserhalb des Webroots. Das Gate prüft beim Setup seine Umgebung (**Hardening-Check**) und weist sich eine Härtungsstufe zu. Das Dashboard zeigt die Stufe an und nennt konkrete Verbesserungsschritte.

| Stufe | Umgebung | Verhalten des Gates |
|---|---|---|
| **H1** (Basis) | Shared Hosting, nur Webroot beschreibbar, keine Env, kein Cron | Config, Policy und Schlüsseldatei liegen in einem Unterordner mit Zugriffsschutz (`.htaccess` / `web.config` / Deny-Regeln), Dateien mit Zufallsnamen und `.php`-Endung (liefern nie Inhalt aus), Hardening-Check testet, ob die Dateien von aussen abrufbar sind. Config-Pull **lazy** bei Requests (kein Cron nötig) mit TTL und Lock-Datei. |
| **H2** (Erweitert) | Schreibbarer Ordner oder Env-Variablen ausserhalb des Webroots | Schlüssel und Policy ausserhalb des Webroots bzw. in Env. Policy für den Webserver-Prozess read-only. |
| **H3** (Voll) | VPS, Container, K8s | Non-root, read-only Dateisystem, Secrets aus Env/Vault, NetworkPolicies, optional separater Prozess für Entschlüsselung. |

| ID | Anforderung | Prio |
|---|---|---|
| SEC-40 | **Kein Admin-Interface auf dem Gate.** Keine eingehenden Management-Endpunkte, nur Outbound-Pull zur Cloud. | M |
| SEC-41 | **SSRF-Schutz:** feste Upstream-Allowlist, IP-Prüfung vor dem Connect, Blockade privater, Loopback- und Link-Local-Bereiche, Redirects nicht automatisch folgen, DNS-Rebinding-Schutz. | M |
| SEC-42 | Pfad-Normalisierung (kein `../`, keine doppelte Kodierung, kein Null-Byte). Matching ist **exakt**, Wildcards nur explizit. | M |
| SEC-43 | **Header-Filter:** Eingehende `Authorization`, `Cookie`, `X-Forwarded-*`, `Host` und Hop-by-Hop-Header gehen nicht an den Upstream. Interne Upstream-Header (Server, X-Powered-By, Set-Cookie) gehen nicht an den Client. | M |
| SEC-44 | Schutz vor Request Smuggling und CRLF-Injection, strikte HTTP-Validierung, Grössenlimits, Timeouts. | M |
| SEC-45 | Rate Limits, Quoten und Budget-Limits werden **lokal im Gate** durchgesetzt. | M |
| SEC-46 | Fail-Closed bei Parsing-Fehlern, ungültiger Config oder fehlendem Secret. | M |
| SEC-47 | Gate-Logs enthalten keine Bodies, Tokens oder personenbezogenen Daten (konfigurierbare Redaction). | M |
| SEC-48 | Gate-zu-Cloud: TLS mit Pinning oder mTLS als Zusatzschutz. | M |
| SEC-49 | **Hardening-Check** (Installer/CLI/Dashboard): prüft Erreichbarkeit der Config- und Schlüsseldateien von aussen, Schreibrechte, PHP-Einstellungen, Env-Verfügbarkeit, und gibt Härtungsstufe plus Empfehlungen aus. | M |

### 2.6 Moat Cloud (Schadensbegrenzung)

| ID | Anforderung | Prio |
|---|---|---|
| SEC-50 | Mandantentrennung auf Datenebene (Row-Level-Security oder getrennte Schemas), automatisierte Cross-Tenant-Tests. | M |
| SEC-51 | MFA (TOTP/WebAuthn), Passkeys, SSO (OIDC/SAML) für Business-Pläne. | M |
| SEC-52 | RBAC mit Least Privilege (Owner, Admin, Editor, Viewer, Billing). **Signieren/Freigeben** ist eine separate Berechtigung. | M |
| SEC-53 | Manipulationssicheres Audit-Log (append-only, Hash-Kette, Export). | M |
| SEC-54 | API-Tokens sind scoped, kurzlebig und widerrufbar. | M |
| SEC-55 | Gate-Anmeldung mit **gate-eigenem Schlüssel**, kein gemeinsames Shared-Secret. Ein gestohlenes Gate-Credential betrifft nur dieses Gate. | M |
| SEC-56 | Betriebszugriffe (Just-in-time, MFA, Protokollierung), Infrastruktur-Secrets in einem Vault. | S |
| SEC-57 | Self-Hosted: gleiche Sicherheitsarchitektur, keine Abhängigkeit von Betreiber-Schlüsseln, Hardening-Guide (non-root, read-only FS, NetworkPolicies). | M |

### 2.7 Lieferkette und Prozess

| ID | Anforderung | Prio |
|---|---|---|
| SEC-60 | Gate-Releases sind signiert (z. B. Sigstore/minisign), Checksummen publiziert, Builds reproduzierbar. | M |
| SEC-61 | SBOM, Dependency-Scanning, minimale Abhängigkeiten im Gate. | M |
| SEC-62 | Formales **Threat Model** (STRIDE) vor der Implementierung, Review bei grösseren Features. | M |
| SEC-63 | Fuzzing der Parser, SSRF-/Smuggling-Testsuite, Conformance-Tests für alle Gate-Targets. | M |
| SEC-64 | Externer Penetrationstest vor Launch, Responsible-Disclosure (`security.txt`), später Bug Bounty. | S |

### 2.8 Abnahmekriterien (Compromise-Test)

**Vertrauensmodus 1 bis 3:** Ein Red Team erhält Vollzugriff auf Moat Cloud (DB, Code, Admin). Es darf **nicht** gelingen:
- Code auf einem Gate auszuführen
- ein Secret im Klartext zu lesen
- einen neuen Upstream zu erzwingen
- einen Request mit fremdem Secret abzusetzen
- alte Configs wieder einzuspielen
- eine Config ohne gültige Kunden-Signatur zu aktivieren

Möglich bleibt: Updates zurückhalten.

**Vertrauensmodus 0:** Gleicher Test, aber eine manipulierte Config ist erlaubt, **solange sie innerhalb der lokalen Policy bleibt**. Alle übrigen Punkte (Code, Klartext-Secrets, fremde Upstreams, Secret-Missbrauch an fremde Hosts, Rollback) müssen weiterhin scheitern.

---

## 3. Funktionale Anforderungen

### 3.1 Projekte und Gates

| ID | Anforderung | Prio |
|---|---|---|
| FR-01 | Organisationen, Projekte, Umgebungen (dev/staging/prod). Gates gehören zu einem Projekt und einer Umgebung. | M |
| FR-02 | **Enrollment:** Gate-Paket herunterladen, installieren, Fingerprint bestätigen, Vertrauensmodus wählen, Verbindung zur Cloud herstellen. Ziel: wenige Minuten bis zum ersten Request. | M |
| FR-03 | **Standalone-Betrieb** ohne Cloud mit lokal abgelegter Config (im gewählten Vertrauensmodus). | M |
| FR-04 | Gate-Status: letzte Verbindung, aktive Config-Version, Gate-Version, Vertrauensmodus, Härtungsstufe, Fehler. | M |
| FR-05 | Gate-Targets: PHP (Shared-Hosting-tauglich) zuerst, danach Node/Nest und .NET. Verhalten über Conformance-Suite identisch. | M/S |
| FR-06 | Deployment: Download mit Anleitung (M), später SFTP/Git-Deploy aus dem Dashboard (S). Das Gate prüft Authentizität immer selbst. | M/S |
| FR-07 | **Update-Einstellungen** pro Gate: Gate-Updates (aus/benachrichtigen/auto) und Config-Pull (an/aus) getrennt einstellbar (SEC-22, SEC-25). | M |

### 3.2 Routen und Endpunkt-Gating

| ID | Anforderung | Prio |
|---|---|---|
| FR-10 | Routen: Methode, Pfad (exakt oder benannte Parameter), Upstream, Zielpfad. | M |
| FR-11 | **Fachliche Endpunkte:** eigene API-Form (z. B. `POST /newsletter`) mit Mapping auf einen oder mehrere Upstream-Calls. | M |
| FR-12 | Allowlist-Prinzip: nicht definierte Routen sind gesperrt. | M |
| FR-13 | Request-Validierung per Schema, unbekannte Felder werden entfernt. | M |
| FR-14 | Response-Filterung: nur definierte Felder an den Client. | S |
| FR-15 | Gating pro Route: Origin/CORS, Methoden, Zeitfenster, Feature-Flags, aktiv/inaktiv. | M |
| FR-16 | Client-Zugriffsschutz: öffentlich, Origin-gebunden, API-Key, JWT/OIDC, Captcha/Turnstile, Honeypot. | M/S |
| FR-17 | Caching pro Route (TTL, Vary). | S |

### 3.3 Secrets und Upstreams

| ID | Anforderung | Prio |
|---|---|---|
| FR-20 | Upstreams: Host, Auth-Art (Bearer, Header, Query, Basic, OAuth2 Client Credentials), zugeordnetes Secret. | M |
| FR-21 | Secret-Verwaltung nach SEC-30 bis SEC-38, mit Ablaufdatum und Notiz. | M |
| FR-22 | Secret-Injection nur zur Laufzeit im Gate (Header/Query/Body-Feld). | M |
| FR-23 | OAuth2-Token-Refresh im Gate (Refresh-Tokens bleiben im Gate). | S |

### 3.4 Limits und Budgets

| ID | Anforderung | Prio |
|---|---|---|
| FR-30 | Rate Limiting pro Route, Client/IP und Key (Fixed/Sliding Window). | M |
| FR-31 | Quoten pro Tag/Monat und **Budget-Limits** (Requests, bei KI-APIs Token/Kosten). | M |
| FR-32 | Verhalten bei Überschreitung konfigurierbar (429, Queue, Fallback-Antwort). | S |
| FR-33 | **Kill-Switch** pro Gate/Route, lokal sofort wirksam. In Modus 1 bis 3 signiert. | M |

### 3.5 Konfiguration und Lifecycle

| ID | Anforderung | Prio |
|---|---|---|
| FR-40 | Versionierte `moat.yaml` mit JSON Schema, im Dashboard und per CLI/Git bearbeitbar (GitOps). | M |
| FR-41 | Entwurf → Review → (Signieren, je nach Modus) → Veröffentlichen. Diff-Ansicht, Rollback als neue höhere Version. | M |
| FR-42 | Validierung und **Dry-Run/Test-Konsole** vor dem Veröffentlichen. | M |
| FR-43 | Recipes: HubSpot-Newsletter, OpenAI-Chat mit Tageslimit, Mailchimp, Airtable. | M |
| FR-44 | OpenAPI-Import als Grundlage für Upstreams und Routen. | S |
| FR-45 | **Manueller Export/Import** von Bundles (Datei), damit auch ohne Cloud-Verbindung konfiguriert werden kann. | M |

### 3.6 Monitoring und Audit

| ID | Anforderung | Prio |
|---|---|---|
| FR-50 | Request-Log pro Route (Zeit, Status, Dauer, Client-Kennung, ohne Bodies), lokal gepuffert, an die Cloud gemeldet (wenn aktiv). | M |
| FR-51 | Dashboards: Requests, Fehlerraten, Latenz, Limit-Treffer, Kosten/Budget. | S |
| FR-52 | Alerts (E-Mail, Webhook, Slack): Fehler, Limit-Treffer, Missbrauch, ablaufende Secrets/Bundles. | S |
| FR-53 | Export von Audit- und Request-Logs (JSON/CSV, SIEM). | S |

### 3.7 Plattform und Betrieb

| ID | Anforderung | Prio |
|---|---|---|
| FR-60 | Moat Cloud als SaaS **und** self-hosted (Docker Compose, Helm), gleicher Funktionsumfang und gleiche Sicherheitsarchitektur. | M |
| FR-61 | Management-API und CLI für alle Dashboard-Funktionen. | M |
| FR-62 | Teams, Rollen, Einladungen, Agentur-Modus mit mehreren Kundenprojekten. | S |
| FR-63 | Billing, Pläne und Limits (nur SaaS). | S |
| FR-64 | Datenhaltung in CH/EU wählbar, DSG/DSGVO-Unterstützung (AVV, Löschkonzept, Export). | M |
| FR-65 | Backups ohne Klartext-Secrets (vgl. SEC-31). | M |

---

### 3.8 Moat Desktop (Betrieb ohne Cloud)

Moat Desktop ist die Control Plane ohne Server. Sie arbeitet immer in Vertrauensmodus 1 oder 2 (Key-Datei/Keychain bzw. Passkey/Hardware-Key). Der Schlüssel liegt im OS-Keychain (Windows Credential Manager, macOS Keychain, libsecret) oder in einer passphrase-geschützten Datei.

| ID | Anforderung | Prio |
|---|---|---|
| DT-01 | Moat Desktop erzeugt, konfiguriert, signiert und deployt Gates komplett ohne Cloud. | M |
| DT-02 | Gemeinsamer **Moat Core** für Desktop, Cloud und CLI. Identisches Verhalten durch Conformance-Tests. | M |
| DT-03 | **Speicher-Backend pro Projekt wählbar** (Tabelle unten). Secrets liegen in externen Backends ausschliesslich als Ciphertext. Neue Backends über ein Storage-Adapter-Interface im Core. | M/S |
| DT-04 | Schlüsselverwaltung im OS-Keychain oder in einer Key-Datei mit Passphrase, Passkey/Hardware-Key als Option. | M |
| DT-05 | Deploy-Ziele: ZIP-Export, SFTP/FTPS, Git, lokaler Ordner. Zugangsdaten nur im Keychain. | M |
| DT-06 | Import/Export zwischen Desktop und Cloud in beide Richtungen. Der Wechsel der Config-Quelle eines Gates braucht lokale Bestätigung am Gate (SEC-06). | S |
| DT-07 | Hardening-Check (SEC-49) aus der Desktop-App gegen ein deployetes Gate. | S |
| DT-08 | **App-Härtung:** `contextIsolation`, keine Node-Integration im Renderer, Sandbox, strenge CSP, kein Laden von Remote-Inhalten, IPC mit Schema-Validierung. | M |
| DT-09 | App-Updates signiert, Update-Kanal abschaltbar, Builds reproduzierbar (SEC-60). Die App lädt nie Code nach. | M |
| DT-10 | Vollständig offline nutzbar. Netzwerk nur für aktiv gewählte Funktionen (Deploy, Update-Check, externe DB). Keine Telemetrie ohne Opt-in. | M |
| DT-11 | **Gate-Pull von eigenem Ort:** Das Gate kann signierte Bundles von einer statischen URL (S3, eigener Webspace) holen. Der Speicherort muss nicht vertrauenswürdig sein, das Gate prüft die Signatur. | M |
| DT-12 | **Logs ohne Cloud:** Das Gate schreibt lokal, Desktop holt Logs bei Bedarf ab. Live-Dashboards und Alerts gibt es nur mit Cloud und sind im Produkt entsprechend gekennzeichnet. | S |
| DT-13 | Geteilte Backends (externe DB, Dateispeicher) nutzen **optimistische Sperren** über die monotone Versionsnummer (SEC-04) und erkennen Konflikte. | S |
| DT-14 | **Teamarbeit ohne Cloud** im MVP über Git (Projektordner). Geteilte DB mit Rollen erst später. | M/K |

**Speicher-Backends:**

| Backend | Zweck | Hinweis |
|---|---|---|
| **Projektordner** (Default) | `moat.yaml`, verschlüsselte Secrets-Datei, signierte Bundles | Git-tauglich, keine DB nötig, einfachstes Backup |
| **Lokale SQLite** | Verlauf, Audit-Log, Diffs, Gate-Status | Verschlüsselbar, eine Datei |
| **Externe DB** (Postgres, MySQL/MariaDB) | Teamarbeit, zentrale Sicherung | Nur Ciphertext und signierte Bundles |
| **Dateispeicher** (S3-kompatibel, WebDAV, SFTP) | Backup oder Sync | Gleiche Regel: nur Ciphertext |

---

## 4. Empfehlung: Umgang mit Shared Hosting (Begründung zu 2.5)

1. **Stufen statt Alles-oder-nichts.** Das Gate läuft überall, zeigt aber ehrlich, wie gut es dort geschützt ist. Das ist glaubwürdiger als ein pauschales Sicherheitsversprechen.
2. **Policy und Schlüssel gehören zum Installationspaket**, nicht zur Cloud-Config. Sie werden beim Installieren lokal erzeugt bzw. gesetzt. Dadurch gilt die Grenze "Cloud-Config ≤ lokale Policy" auch ohne Env-Variablen.
3. **Lazy Pull statt Cron:** Das Gate prüft bei Requests, ob die TTL abgelaufen ist, holt dann die Config (mit Lock-Datei gegen Parallelität) und arbeitet bis dahin mit dem Cache weiter.
4. **Selbsttest statt Annahmen:** Der Hardening-Check ruft die eigenen Dateien von aussen ab und warnt, wenn sie erreichbar sind.
5. **Upgrade-Pfad:** Wer H2 oder H3 erreichen kann, bekommt im Dashboard eine konkrete Anleitung (Schlüssel verschieben, Env setzen, Container nutzen).

## 5. Offene Punkte (nächster Schritt)

1. **Threat Model (STRIDE)** pro Vertrauensmodus (0 bis 3), pro Härtungsstufe (H1 bis H3) und für Moat Desktop (lokale Angriffe, bösartige Projektdateien, Supply Chain).
2. **Tech-Stack** für Cloud, Gate (PHP zuerst, dependency-arm), CLI, Core-Bibliothek und Desktop-App. Dabei **Electron vs. Tauri**: Electron hat die grössere Angriffsfläche (Chromium plus Node) bei bekanntem Ökosystem, Tauri ist schlanker und sicherheitsorientierter, verlangt aber Rust-Anteil. Die Anforderungen DT-01 bis DT-14 gelten für beide. Der Core muss in der gewählten Sprache für Desktop, Cloud und CLI wiederverwendbar sein.
3. **Kryptografie-Details:** Algorithmen, Key-Datei-Format (Passphrase-KDF), Bundle-Format, Enrollment-Protokoll.
4. **Default-Modus:** Modus 0 ist am einfachsten. Frage, ob beim Setup aktiv zu Modus 1 geraten wird (z. B. bei Secrets mit Schreibrechten wie KI-APIs mit Budget).
5. **Produktwording** für Vertrauensmodi und Härtungsstufen, damit Nicht-Techniker sie verstehen.
6. **Teamarbeit ohne Cloud:** Reicht Git im MVP (DT-14), oder braucht es früh eine geteilte DB mit Rollen?
