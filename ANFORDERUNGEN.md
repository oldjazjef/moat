# Moat: Anforderungen (v0.5)

**Produkt:** API-Management für Websites auf normalem Hosting: Secrets verwalten, Proxy, Endpunkt-Gating.
**Komponenten:**

- **Moat Core:** gemeinsame Bibliothek für Schema, Bundle-Bau, Signierung, Verschlüsselung und Gate-Generator. Wird von Cloud, Desktop und CLI genutzt.
- **Moat Desktop:** Desktop-App, die Gates **ohne Cloud** erzeugt, konfiguriert, signiert und deployt.
- **Moat Cloud:** SaaS oder self-hosted (Docker/K8s), Verwaltung, Teams, Monitoring.
- **Moat Gate:** läuft auf dem Hosting des Kunden.
  **Priorität:** **M** = MVP, **S** = bald danach, **K** = später.

## Änderungen gegenüber v0.4

| Thema                   | Entscheidung                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Produktwording          | Feste Bezeichnungen für Vertrauensmodi und Härtungsstufen, jeweils mit einem Satz, was eine gehackte Cloud könnte (Abschnitt 2.9).       |
| Teamarbeit ohne Cloud   | MVP über Git im Projektordner; geteilte DB mit Rollen erst später (DT-14, DT-18).                                                        |
| Sicherheitstests        | OWASP Top 10, OWASP API Top 10, Berechtigungsmatrix für jeden Endpunkt, DAST, SAST, Pentests (Abschnitt 2.10, docs/SECURITY-TESTING.md). |
| Hilfe und Einrichtung   | Hilfe-Seite, kontextuelle „?“ und Einrichtungsassistent von Anfang an, analog lazy-koins (Abschnitt 3.9).                                |
| Default-Vertrauensmodus | **Bequem** mit aktiver Empfehlung zu „Signiert“ (FR-46 bis FR-48, Abschnitt 2.9).                                                        |

## Änderungen gegenüber v0.3

Quelle: [Threat Model v0.1](docs/THREAT-MODEL.md), Abschnitt 8. Die `T-…`-Nummern verweisen dorthin.

| Thema                           | Entscheidung                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Secret Laundering in Modus 0    | Lokale Policy kann Pfade, Methoden und Limit-Obergrenzen festlegen (SEC-14).           |
| Kill-Switch ohne Cloud          | Lokaler Kill-Switch per Datei (SEC-15).                                                |
| Client-IP, Rate-Limit-Speicher  | SEC-26, SEC-27.                                                                        |
| Enrollment ohne Admin-Interface | Einmaliger, tokengeschützter Setup-Modus (SEC-28).                                     |
| Secret-Echo, Content-Type       | SEC-39, FR-18.                                                                         |
| Shared Hosting                  | Hardening-Check erkennt gemeinsamen Ausführungsbenutzer (SEC-49a).                     |
| Ehrlichkeit Browser             | Browser-Signieren und Secret-Eingabe im Browser als schwächer gekennzeichnet (SEC-58). |
| Audit, Lieferkette              | SEC-59, SEC-65, SEC-66; Default-Update-Modus des Gates ist „benachrichtigen“.          |
| Moat Desktop                    | DT-15 bis DT-17.                                                                       |

## Änderungen gegenüber v0.2

| Thema              | Entscheidung                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| Betrieb ohne Cloud | Neue Komponente **Moat Desktop** (Abschnitt 3.8). Die Cloud ist optional.      |
| Gemeinsamer Kern   | **Moat Core** wird von Desktop, Cloud und CLI geteilt (DT-02).                 |
| Speicherung        | Pro Projekt wählbar: Projektordner, SQLite, externe DB, Dateispeicher (DT-03). |
| Vertrauensmodus 0  | In Moat Desktop nicht verfügbar (kein Server, dem das Gate vertrauen könnte).  |
| Browser-JS-Problem | Entfällt in der Desktop-App (SEC-37).                                          |

## Änderungen gegenüber v0.1

| Thema                   | Entscheidung                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signierung              | Nicht mehr zwingend. Benutzer wählen pro Gate einen **Vertrauensmodus** (0 bis 3, siehe 2.1). Einfachster Weg zuerst.                                               |
| Shared-Hosting-Realität | Gate erkennt seine Umgebung und arbeitet mit **Härtungsstufen** (H1 bis H3) inkl. Fallbacks (siehe 2.5).                                                            |
| Manuelle Updates        | Gate-Updates und Config-Updates sind getrennt und je einzeln auf **auto / benachrichtigen / aus** stellbar. Manuelles Ablegen von Dateien ist ein vollwertiger Weg. |
| Bundle-Ablauf           | **Deaktivierbar, Default: kein Ablauf** (immer gültig).                                                                                                             |
| Compromise-Test         | Gilt für Vertrauensmodus 1 bis 3. Modus 0 ist bewusst ein Komfort-Modus mit geringerer Garantie.                                                                    |

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

| Modus | Name                                                                                | So funktioniert es                                                                                                                                                                                                                                               | Garantie bei gehackter Cloud                                                                                                             |
| ----- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | **Managed** (Default in der Cloud, am einfachsten; in Moat Desktop nicht verfügbar) | Gate vertraut der Cloud nach Enrollment (Fingerprint-Bestätigung + gepinnter Cloud-Schlüssel). Keine Signatur durch den Kunden.                                                                                                                                  | Config kann manipuliert werden, aber nur innerhalb der lokalen Policy. Kein Code, keine Klartext-Secrets.                                |
| **1** | **Key-Datei + Passphrase** (einfaches Signieren)                                    | Beim Setup wird ein Signaturschlüssel erzeugt und als passphrase-geschützte Datei **heruntergeladen**. Die Cloud speichert ihn nie. Signiert wird lokal im Browser, per CLI oder in Moat Desktop. Der Public Key wird am Gate gepinnt (Fingerprint-Bestätigung). | Volle Garantie, sofern der ausgelieferte Browser-Code vertrauenswürdig ist. Für maximale Garantie CLI oder Moat Desktop nutzen (SEC-37). |
| **2** | **Passkey / Hardware-Key** (WebAuthn)                                               | Signieren mit Passkey oder Hardware-Key. Schlüssel verlässt das Gerät nie.                                                                                                                                                                                       | Wie Modus 1, zusätzlich Schutz vor Schlüsseldiebstahl.                                                                                   |
| **3** | **Eigener Signer-Dienst** (S)                                                       | Kunde betreibt einen Dienst (oder CI-Job), der Bundles signiert.                                                                                                                                                                                                 | Volle Garantie, geeignet für GitOps und Teams.                                                                                           |

Regeln:

| ID     | Anforderung                                                                                                                                                                                                                            | Prio |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| SEC-01 | Das Gate führt Bundles nur aus, wenn sie zum **gewählten Modus** passen: Modus 0 prüft die Authentizität gegen den beim Enrollment gepinnten Cloud-Schlüssel, Modus 1 bis 3 gegen den gepinnten **Kunden-Public-Key** (Ed25519 o. ä.). | M    |
| SEC-02 | In den Modi 1 bis 3 liegt der private Signaturschlüssel **nie** in der Cloud. Die Cloud kann Bundles nur ablegen und ausliefern.                                                                                                       | M    |
| SEC-03 | Signatur- oder Authentizitätsfehler führen zum Verwerfen des Bundles. Das Gate läuft mit der letzten gültigen Config weiter.                                                                                                           | M    |
| SEC-04 | **Rollback-Schutz:** Bundles tragen eine monoton steigende Versionsnummer. Das Gate akzeptiert nur höhere Versionen. Ein Rollback im Dashboard erzeugt eine neue, höhere Version mit altem Inhalt.                                     | M    |
| SEC-05 | **Ablauf ist optional.** Default: Bundles laufen nie ab. Wer es aktiviert, wählt Gültigkeitsdauer und Verhalten bei Ablauf (weiterlaufen / eingeschränkt / deny). Das Dashboard warnt vor Ablauf.                                      | M    |
| SEC-06 | **Wechsel des Vertrauensmodus oder des gepinnten Schlüssels** ist nur möglich mit lokaler Bestätigung am Gate (Fingerprint-Eingabe oder Datei-Austausch). Die Cloud allein kann den Modus nie abschwächen.                             | M    |
| SEC-07 | Bundles sind an eine **Gate-ID** gebunden (kein Replay zwischen Gates).                                                                                                                                                                | M    |
| SEC-08 | Schlüsselrotation in Modus 1 bis 3 über eine Schlüsselkette (Root-Key offline, Betriebs-Key rotierbar). Verlust des Keys: dokumentierter Recovery-Weg über manuelles Re-Pinning am Gate.                                               | S    |
| SEC-09 | Optional: Vier-Augen-Prinzip (M-of-N-Signaturen) für kritische Änderungen (neuer Upstream, neues Secret).                                                                                                                              | K    |

### 2.2 Lokale Policy (Obergrenze auf dem Gate)

| ID     | Anforderung                                                                                                                                                                                                                                                                  | Prio |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| SEC-10 | Das Gate hat eine **lokale Policy** ausserhalb der Cloud-Kontrolle: erlaubte Upstream-Hosts, nur HTTPS, maximale Methoden, maximale Body-Grösse. Sie gilt in allen Vertrauensmodi.                                                                                           | M    |
| SEC-11 | Die Cloud-Config kann die Policy nur **einschränken**, nie erweitern. Ein Upstream ausserhalb der lokalen Allowlist wird abgelehnt, auch bei gültiger Signatur.                                                                                                              | M    |
| SEC-12 | Die Policy ist wenn möglich ausserhalb des Webroots und für den Webserver-Prozess nicht beschreibbar (siehe Härtungsstufen 2.5).                                                                                                                                             | S    |
| SEC-13 | Policy-Änderungen erfolgen **nur lokal** (Datei, Env oder Installer), nie über die Cloud.                                                                                                                                                                                    | M    |
| SEC-14 | Die lokale Policy kann pro Upstream **erlaubte Pfad-Präfixe und Methoden** festlegen sowie **Obergrenzen** für Rate Limits, Quoten und Budgets. Die Cloud-Config bleibt immer darunter. Recipes liefern passende Policy-Vorschläge mit (gegen Secret Laundering, T-20/T-21). | M    |
| SEC-15 | **Lokaler Kill-Switch** per Datei, pro Gate und pro Route, sofort wirksam und unabhängig von der Cloud. Das Gate meldet, wenn die aktive Config älter als ein einstellbarer Wert ist (T-23).                                                                                 | M    |

### 2.3 Keine Code-Injektion

| ID     | Anforderung                                                                                                                                                                                                                                                                                                                                                                                        | Prio |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| SEC-20 | Konfiguration ist **rein deklarativ** (JSON Schema, `additionalProperties: false`). Keine Skripte, Expressions, `eval`, dynamische Includes oder Template-Engines mit Codeausführung.                                                                                                                                                                                                              | M    |
| SEC-21 | Das Gate ist ein **fest ausgeliefertes, signiertes Artefakt**. Die Cloud kann es nicht überschreiben, nachladen oder erweitern.                                                                                                                                                                                                                                                                    | M    |
| SEC-22 | **Gate-Updates sind vom Config-Kanal getrennt.** Update-Modus pro Gate: **aus** (nur manuell durch den Kunden), **benachrichtigen** (Gate meldet eine neue Version, Kunde installiert), **auto** (Pull aus Release-Kanal mit Signaturprüfung gegen einen im Gate fest eingebauten Release-Key). **Default: benachrichtigen** (SEC-66). Updates kommen nie über den Config-Kanal der Cloud.         | M    |
| SEC-23 | Eigene Logik nur über vordefinierte, getestete Bausteine (Feld umbenennen, Wert aus Secret einsetzen, Feld entfernen), nicht über frei programmierbare Regeln.                                                                                                                                                                                                                                     | M    |
| SEC-24 | Parser-Härtung: Grössen- und Tiefenlimits, keine externen Referenzen (`$ref` auf URLs, XML-Entities).                                                                                                                                                                                                                                                                                              | M    |
| SEC-26 | Die Client-IP stammt aus `REMOTE_ADDR`. `X-Forwarded-For` und ähnliche Header gelten nur, wenn die lokale Policy vertrauenswürdige Proxies nennt (T-02).                                                                                                                                                                                                                                           | M    |
| SEC-27 | Der Speicher für Rate Limits und Budgets ist in der Grösse begrenzt und hat eine Eviction. Bei Überlauf gilt Fail-Closed (T-09).                                                                                                                                                                                                                                                                   | M    |
| SEC-28 | **Enrollment-Setup-Modus:** Für die Fingerprint-Anzeige (SEC-32) gibt es einen einmaligen Setup-Modus, geschützt durch ein Setup-Token aus der lokalen Installationsdatei. Er schaltet sich nach der Bestätigung oder nach kurzer Zeit dauerhaft ab und kann nur lokal wieder aktiviert werden. Alternativ: Fingerprint über CLI/SSH oder eine Datei. Ausser diesem Modus gilt SEC-40 unverändert. | M    |
| SEC-25 | **Manueller Betrieb ist erstklassig:** Das Gate funktioniert vollständig mit manuell abgelegten Dateien (Gate-Artefakt und Config-Bundle). Der Pull von Updates und Configs lässt sich jeweils komplett abschalten.                                                                                                                                                                                | M    |

### 2.4 Secrets

| ID     | Anforderung                                                                                                                                                                                                                                                                                | Prio |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| SEC-30 | Jedes Gate erzeugt sein **Schlüsselpaar selbst**. Der private Schlüssel verlässt das Gate nie.                                                                                                                                                                                             | M    |
| SEC-31 | Secrets werden **clientseitig** (Browser oder CLI) mit dem Public Key des Gates verschlüsselt. Die Cloud speichert nur Ciphertext.                                                                                                                                                         | M    |
| SEC-32 | Beim Enrollment wird der **Fingerprint** des Gate-Public-Keys auf dem Gate angezeigt und vom Admin im Dashboard bestätigt. Eine kompromittierte Cloud kann so keinen eigenen Schlüssel unterschieben.                                                                                      | M    |
| SEC-33 | Verschlüsselte Secrets sind an Gate-ID und Secret-Namen gebunden (AEAD mit Kontext).                                                                                                                                                                                                       | M    |
| SEC-34 | Auf dem Gate liegen Secrets verschlüsselt. Secrets erscheinen nie in Logs, Fehlermeldungen, Responses oder Debug-Ausgaben.                                                                                                                                                                 | M    |
| SEC-35 | Secrets werden nur an **vorab definierte Upstreams** gesendet (Bindung Secret → Upstream-Host).                                                                                                                                                                                            | M    |
| SEC-36 | Secret-Rotation ohne Downtime (zwei aktive Versionen übergangsweise).                                                                                                                                                                                                                      | S    |
| SEC-37 | Das Browser-Verschlüsseln schützt nur, wenn der ausgelieferte JS-Code vertrauenswürdig ist. Daher gibt es einen **CLI-Weg mit reproduzierbar gebautem Client**. Das Dashboard weist darauf hin. In **Moat Desktop** läuft Verschlüsselung und Signierung lokal, das Problem entfällt dort. | M    |
| SEC-39 | Das Gate entfernt Secret-Werte aus allen Upstream-Antworten, Fehlermeldungen und Logs, auch wenn ein Upstream sie zurückspiegelt (T-05).                                                                                                                                                   | M    |
| SEC-38 | Secrets können alternativ **direkt auf dem Gate** hinterlegt werden (Datei/Env), ohne dass sie je in die Cloud gelangen ("Local-only Secret").                                                                                                                                             | M    |

### 2.5 Gate-Laufzeit und Härtungsstufen

**Shared-Hosting-Realität:** Dort gibt es oft keine Env-Variablen, keine Cron-Jobs und kein Schreibrecht ausserhalb des Webroots. Das Gate prüft beim Setup seine Umgebung (**Hardening-Check**) und weist sich eine Härtungsstufe zu. Das Dashboard zeigt die Stufe an und nennt konkrete Verbesserungsschritte.

| Stufe              | Umgebung                                                       | Verhalten des Gates                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1** (Basis)     | Shared Hosting, nur Webroot beschreibbar, keine Env, kein Cron | Config, Policy und Schlüsseldatei liegen in einem Unterordner mit Zugriffsschutz (`.htaccess` / `web.config` / Deny-Regeln), Dateien mit Zufallsnamen und `.php`-Endung (liefern nie Inhalt aus), Hardening-Check testet, ob die Dateien von aussen abrufbar sind. Config-Pull **lazy** bei Requests (kein Cron nötig) mit TTL und Lock-Datei. |
| **H2** (Erweitert) | Schreibbarer Ordner oder Env-Variablen ausserhalb des Webroots | Schlüssel und Policy ausserhalb des Webroots bzw. in Env. Policy für den Webserver-Prozess read-only.                                                                                                                                                                                                                                          |
| **H3** (Voll)      | VPS, Container, K8s                                            | Non-root, read-only Dateisystem, Secrets aus Env/Vault, NetworkPolicies, optional separater Prozess für Entschlüsselung.                                                                                                                                                                                                                       |

| ID      | Anforderung                                                                                                                                                                                                               | Prio |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| SEC-40  | **Kein Admin-Interface auf dem Gate.** Keine eingehenden Management-Endpunkte, nur Outbound-Pull zur Cloud.                                                                                                               | M    |
| SEC-41  | **SSRF-Schutz:** feste Upstream-Allowlist, IP-Prüfung vor dem Connect, Blockade privater, Loopback- und Link-Local-Bereiche, Redirects nicht automatisch folgen, DNS-Rebinding-Schutz.                                    | M    |
| SEC-42  | Pfad-Normalisierung (kein `../`, keine doppelte Kodierung, kein Null-Byte). Matching ist **exakt**, Wildcards nur explizit.                                                                                               | M    |
| SEC-43  | **Header-Filter:** Eingehende `Authorization`, `Cookie`, `X-Forwarded-*`, `Host` und Hop-by-Hop-Header gehen nicht an den Upstream. Interne Upstream-Header (Server, X-Powered-By, Set-Cookie) gehen nicht an den Client. | M    |
| SEC-44  | Schutz vor Request Smuggling und CRLF-Injection, strikte HTTP-Validierung, Grössenlimits, Timeouts.                                                                                                                       | M    |
| SEC-45  | Rate Limits, Quoten und Budget-Limits werden **lokal im Gate** durchgesetzt.                                                                                                                                              | M    |
| SEC-46  | Fail-Closed bei Parsing-Fehlern, ungültiger Config oder fehlendem Secret.                                                                                                                                                 | M    |
| SEC-47  | Gate-Logs enthalten keine Bodies, Tokens oder personenbezogenen Daten (konfigurierbare Redaction).                                                                                                                        | M    |
| SEC-48  | Gate-zu-Cloud: TLS mit Pinning oder mTLS als Zusatzschutz.                                                                                                                                                                | M    |
| SEC-49a | Der Hardening-Check erkennt einen gemeinsamen Ausführungsbenutzer mehrerer Websites und fehlendes `open_basedir` und stuft das Gate dann als „H1, ungeeignet für Secrets“ ein (T-41).                                     | M    |
| SEC-49  | **Hardening-Check** (Installer/CLI/Dashboard): prüft Erreichbarkeit der Config- und Schlüsseldateien von aussen, Schreibrechte, PHP-Einstellungen, Env-Verfügbarkeit, und gibt Härtungsstufe plus Empfehlungen aus.       | M    |

### 2.6 Moat Cloud (Schadensbegrenzung)

| ID     | Anforderung                                                                                                                                                                                                                                                                       | Prio |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| SEC-50 | Mandantentrennung auf Datenebene (Row-Level-Security oder getrennte Schemas), automatisierte Cross-Tenant-Tests.                                                                                                                                                                  | M    |
| SEC-51 | MFA (TOTP/WebAuthn), Passkeys, SSO (OIDC/SAML) für Business-Pläne.                                                                                                                                                                                                                | M    |
| SEC-52 | RBAC mit Least Privilege (Owner, Admin, Editor, Viewer, Billing). **Signieren/Freigeben** ist eine separate Berechtigung.                                                                                                                                                         | M    |
| SEC-53 | Manipulationssicheres Audit-Log (append-only, Hash-Kette, Export).                                                                                                                                                                                                                | M    |
| SEC-54 | API-Tokens sind scoped, kurzlebig und widerrufbar.                                                                                                                                                                                                                                | M    |
| SEC-55 | Gate-Anmeldung mit **gate-eigenem Schlüssel**, kein gemeinsames Shared-Secret. Ein gestohlenes Gate-Credential betrifft nur dieses Gate.                                                                                                                                          | M    |
| SEC-56 | Betriebszugriffe (Just-in-time, MFA, Protokollierung), Infrastruktur-Secrets in einem Vault.                                                                                                                                                                                      | S    |
| SEC-58 | **Ehrliche Kennzeichnung:** Das Produkt zeigt, dass Signieren und Secret-Eingabe im Browser nicht gegen eine aktiv kompromittierte Cloud schützen (T-25, T-30) und dass Origin-Bindung nur gegen Browser wirkt (T-01). Empfohlener Weg für volle Garantie: Moat Desktop oder CLI. | M    |
| SEC-59 | Signierte **Audit-Checkpoints** werden regelmässig an den Kunden exportiert oder per Webhook zugestellt, damit eine kompromittierte Cloud das Audit-Log nicht unbemerkt neu schreiben kann (T-34).                                                                                | S    |
| SEC-57 | Self-Hosted: gleiche Sicherheitsarchitektur, keine Abhängigkeit von Betreiber-Schlüsseln, Hardening-Guide (non-root, read-only FS, NetworkPolicies).                                                                                                                              | M    |

### 2.7 Lieferkette und Prozess

| ID     | Anforderung                                                                                                                                                                        | Prio |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| SEC-60 | Gate-Releases sind signiert (z. B. Sigstore/minisign), Checksummen publiziert, Builds reproduzierbar.                                                                              | M    |
| SEC-61 | SBOM, Dependency-Scanning, minimale Abhängigkeiten im Gate.                                                                                                                        | M    |
| SEC-62 | Formales **Threat Model** (STRIDE) vor der Implementierung, Review bei grösseren Features.                                                                                         | M    |
| SEC-63 | Fuzzing der Parser, SSRF-/Smuggling-Testsuite, Conformance-Tests für alle Gate-Targets.                                                                                            | M    |
| SEC-65 | Gate-Artefakt und Release-Fingerprints sind gegen eine von der Cloud **unabhängige Quelle** prüfbar (z. B. GitHub-Release). Der Installer prüft die Release-Signatur (T-22, T-63). | M    |
| SEC-66 | Release-Schlüssel offline bzw. im HSM mit **M-of-N-Signatur**, Einträge in einem Transparenz-Log, gestaffelter Rollout von Gate-Updates (T-60).                                    | M    |
| SEC-64 | Externer Penetrationstest vor Launch, Responsible-Disclosure (`security.txt`), später Bug Bounty.                                                                                  | S    |

### 2.10 Sicherheitstests (Details: [docs/SECURITY-TESTING.md](docs/SECURITY-TESTING.md))

| ID     | Anforderung                                                                                                                                                                                                                                                                                                                                                         | Prio |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| SEC-70 | Die Anwendung wird laufend gegen die **OWASP Top 10** (aktuelle Ausgabe, 2025) und die **OWASP API Security Top 10** getestet. Jede Kategorie ist auf konkrete automatisierte Tests abgebildet; die Abbildung wird gepflegt.                                                                                                                                        | M    |
| SEC-71 | **Berechtigungsmatrix:** Jeder Endpunkt der Cloud-API wird mit jeder Identität getestet (ohne Token, ungültige/abgelaufene/widerrufene Tokens, jede Rolle, mit und ohne Freigabe-Recht, fremder Mandant, falscher Token-Scope, Gate-Anmeldung). Ein Endpunkt ohne Eintrag in der Matrix lässt den Build fehlschlagen. Dazu IDOR-, Massenzuweisungs- und CSRF-Fälle. | M    |
| SEC-72 | **Authentifizierung** wird als Ablauf getestet: Login, MFA, Passkeys, OIDC, Brute-Force-Sperre, Session-Rotation und -Ablauf, Logout, Token-Widerruf, Passwort-Reset.                                                                                                                                                                                               | M    |
| SEC-73 | **DAST:** OWASP ZAP gegen die laufende Cloud-API (mit Login je Rolle) und gegen ein laufendes Gate; Baseline in jedem PR, Vollscan nächtlich. Befunde ab „mittel“ blockieren.                                                                                                                                                                                       | M    |
| SEC-74 | **SAST und Lieferkette** in jedem PR: CodeQL, Semgrep (OWASP-Regeln), Abhängigkeits-Scan (npm + Composer), Secret-Scan, Container- und Helm-Scan, Electron-Konfigurations-Scan.                                                                                                                                                                                     | M    |
| SEC-75 | **Interner Pentest** nach OWASP WSTG vor jedem Minor-Release, inklusive Compromise-Test (2.8), dokumentiert pro Version. **Externer Pentest** vor Launch, danach jährlich und nach grossen Änderungen an Krypto, Auth oder Gate (ersetzt SEC-64 teilweise).                                                                                                         | M    |
| SEC-76 | Befunde haben Fristen nach Schweregrad (kritisch 7 Tage, hoch 30 Tage) und gelten erst mit Regressionstest als behoben.                                                                                                                                                                                                                                             | M    |
| SEC-77 | Der Compromise-Test aus 2.8 existiert zusätzlich als **automatisierte Suite** (gehackte Cloud simuliert: manipulierte DB, manipulierte Bundles, ausgetauschte Schlüssel) pro Vertrauensmodus.                                                                                                                                                                       | M    |

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

### 2.9 Produktbezeichnungen und Default-Modus

Die UI benutzt **nur** diese Bezeichnungen (de-CH / en). Jede Stufe zeigt den Satz „Wenn Moat Cloud
gehackt wird …“ an, damit die Garantie ehrlich bleibt (§1.5, SEC-58).

| Intern                   | Bezeichnung (de / en)                            | Kurzbeschreibung in der UI                                             | „Wenn Moat Cloud gehackt wird …“                                                                                                      |
| ------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Modus 0                  | **Bequem** / _Convenient_                        | Moat Cloud gibt Änderungen frei.                                       | … kann ein Angreifer deine Routen innerhalb der lokalen Grenzen deines Gates ändern. Secrets lesen oder Code ausführen kann er nicht. |
| Modus 1                  | **Signiert** / _Signed_                          | Du gibst jede Änderung mit deiner Schlüsseldatei frei.                 | … kann ein Angreifer nichts ändern. Im Browser gilt das nur eingeschränkt, volle Garantie mit Moat Desktop oder CLI.                  |
| Modus 2                  | **Signiert mit Passkey** / _Signed with passkey_ | Du gibst jede Änderung mit Passkey oder Sicherheitsschlüssel frei.     | wie „Signiert“, zusätzlich kann dein Schlüssel nicht gestohlen werden.                                                                |
| Modus 3                  | **Eigene Freigabe** / _Own signer_               | Dein eigener Dienst oder deine CI gibt frei.                           | … kann ein Angreifer nichts ändern.                                                                                                   |
| H1                       | **Basis** / _Basic_                              | Läuft im Webspace, geschützt durch Zugriffsregeln.                     | — (betrifft das Hosting)                                                                                                              |
| H1, gemeinsamer Benutzer | **Unsicher für Secrets** / _Unsafe for secrets_  | Andere Websites auf diesem Server könnten die Dateien lesen (SEC-49a). | —                                                                                                                                     |
| H2                       | **Gut** / _Good_                                 | Schlüssel und Policy liegen ausserhalb des Webspace.                   | —                                                                                                                                     |
| H3                       | **Stark** / _Strong_                             | Eigener Container oder Server, nur lesbares Dateisystem.               | —                                                                                                                                     |

**Default-Vertrauensmodus (entschieden 12.10.2026):**

| ID    | Anforderung                                                                                                                                                                                                                      | Prio |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| FR-46 | In Moat Cloud ist **Bequem** (Modus 0) der Default beim Anlegen eines Gates. Moat Desktop ist immer mindestens **Signiert**.                                                                                                     | M    |
| FR-47 | Der Setup-Assistent empfiehlt aktiv **Signiert**, sobald eine Route ein Secret mit Schreibrechten oder ein KI-Budget nutzt, und bietet den Wechsel mit einem Klick an (Wechsel braucht trotzdem die lokale Bestätigung, SEC-06). | M    |
| FR-48 | In **Bequem** verlangt Moat beim Anlegen eines Upstreams eine lokale Pfad-Policy (SEC-14). Recipes liefern sie mit; ohne sie wird kein Secret an diesen Upstream gebunden.                                                       | M    |

## 3. Funktionale Anforderungen

### 3.1 Projekte und Gates

| ID    | Anforderung                                                                                                                                                                           | Prio |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| FR-01 | Organisationen, Projekte, Umgebungen (dev/staging/prod). Gates gehören zu einem Projekt und einer Umgebung.                                                                           | M    |
| FR-02 | **Enrollment:** Gate-Paket herunterladen, installieren, Fingerprint bestätigen, Vertrauensmodus wählen, Verbindung zur Cloud herstellen. Ziel: wenige Minuten bis zum ersten Request. | M    |
| FR-03 | **Standalone-Betrieb** ohne Cloud mit lokal abgelegter Config (im gewählten Vertrauensmodus).                                                                                         | M    |
| FR-04 | Gate-Status: letzte Verbindung, aktive Config-Version, Gate-Version, Vertrauensmodus, Härtungsstufe, Fehler.                                                                          | M    |
| FR-05 | Gate-Targets: PHP (Shared-Hosting-tauglich) zuerst, danach Node/Nest und .NET. Verhalten über Conformance-Suite identisch.                                                            | M/S  |
| FR-06 | Deployment: Download mit Anleitung (M), später SFTP/Git-Deploy aus dem Dashboard (S). Das Gate prüft Authentizität immer selbst.                                                      | M/S  |
| FR-07 | **Update-Einstellungen** pro Gate: Gate-Updates (aus/benachrichtigen/auto) und Config-Pull (an/aus) getrennt einstellbar (SEC-22, SEC-25).                                            | M    |

### 3.2 Routen und Endpunkt-Gating

| ID    | Anforderung                                                                                                            | Prio |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| FR-10 | Routen: Methode, Pfad (exakt oder benannte Parameter), Upstream, Zielpfad.                                             | M    |
| FR-11 | **Fachliche Endpunkte:** eigene API-Form (z. B. `POST /newsletter`) mit Mapping auf einen oder mehrere Upstream-Calls. | M    |
| FR-12 | Allowlist-Prinzip: nicht definierte Routen sind gesperrt.                                                              | M    |
| FR-13 | Request-Validierung per Schema, unbekannte Felder werden entfernt.                                                     | M    |
| FR-14 | Response-Filterung: nur definierte Felder an den Client.                                                               | S    |
| FR-15 | Gating pro Route: Origin/CORS, Methoden, Zeitfenster, Feature-Flags, aktiv/inaktiv.                                    | M    |
| FR-16 | Client-Zugriffsschutz: öffentlich, Origin-gebunden, API-Key, JWT/OIDC, Captcha/Turnstile, Honeypot.                    | M/S  |
| FR-18 | Content-Type-Allowlist pro Route (Default: JSON) und `X-Content-Type-Options: nosniff` an den Client (T-13).           | M    |
| FR-17 | Caching pro Route (TTL, Vary).                                                                                         | S    |

### 3.3 Secrets und Upstreams

| ID    | Anforderung                                                                                               | Prio |
| ----- | --------------------------------------------------------------------------------------------------------- | ---- |
| FR-20 | Upstreams: Host, Auth-Art (Bearer, Header, Query, Basic, OAuth2 Client Credentials), zugeordnetes Secret. | M    |
| FR-21 | Secret-Verwaltung nach SEC-30 bis SEC-38, mit Ablaufdatum und Notiz.                                      | M    |
| FR-22 | Secret-Injection nur zur Laufzeit im Gate (Header/Query/Body-Feld).                                       | M    |
| FR-23 | OAuth2-Token-Refresh im Gate (Refresh-Tokens bleiben im Gate).                                            | S    |

### 3.4 Limits und Budgets

| ID    | Anforderung                                                                      | Prio |
| ----- | -------------------------------------------------------------------------------- | ---- |
| FR-30 | Rate Limiting pro Route, Client/IP und Key (Fixed/Sliding Window).               | M    |
| FR-31 | Quoten pro Tag/Monat und **Budget-Limits** (Requests, bei KI-APIs Token/Kosten). | M    |
| FR-32 | Verhalten bei Überschreitung konfigurierbar (429, Queue, Fallback-Antwort).      | S    |
| FR-33 | **Kill-Switch** pro Gate/Route, lokal sofort wirksam. In Modus 1 bis 3 signiert. | M    |

### 3.5 Konfiguration und Lifecycle

| ID    | Anforderung                                                                                                      | Prio |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ---- |
| FR-40 | Versionierte `moat.yaml` mit JSON Schema, im Dashboard und per CLI/Git bearbeitbar (GitOps).                     | M    |
| FR-41 | Entwurf → Review → (Signieren, je nach Modus) → Veröffentlichen. Diff-Ansicht, Rollback als neue höhere Version. | M    |
| FR-42 | Validierung und **Dry-Run/Test-Konsole** vor dem Veröffentlichen.                                                | M    |
| FR-43 | Recipes: HubSpot-Newsletter, OpenAI-Chat mit Tageslimit, Mailchimp, Airtable.                                    | M    |
| FR-44 | OpenAPI-Import als Grundlage für Upstreams und Routen.                                                           | S    |
| FR-45 | **Manueller Export/Import** von Bundles (Datei), damit auch ohne Cloud-Verbindung konfiguriert werden kann.      | M    |

### 3.6 Monitoring und Audit

| ID    | Anforderung                                                                                                                    | Prio |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ---- |
| FR-50 | Request-Log pro Route (Zeit, Status, Dauer, Client-Kennung, ohne Bodies), lokal gepuffert, an die Cloud gemeldet (wenn aktiv). | M    |
| FR-51 | Dashboards: Requests, Fehlerraten, Latenz, Limit-Treffer, Kosten/Budget.                                                       | S    |
| FR-52 | Alerts (E-Mail, Webhook, Slack): Fehler, Limit-Treffer, Missbrauch, ablaufende Secrets/Bundles.                                | S    |
| FR-53 | Export von Audit- und Request-Logs (JSON/CSV, SIEM).                                                                           | S    |

### 3.7 Plattform und Betrieb

| ID    | Anforderung                                                                                                                  | Prio |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| FR-60 | Moat Cloud als SaaS **und** self-hosted (Docker Compose, Helm), gleicher Funktionsumfang und gleiche Sicherheitsarchitektur. | M    |
| FR-61 | Management-API und CLI für alle Dashboard-Funktionen.                                                                        | M    |
| FR-62 | Teams, Rollen, Einladungen, Agentur-Modus mit mehreren Kundenprojekten.                                                      | S    |
| FR-63 | Billing, Pläne und Limits (nur SaaS).                                                                                        | S    |
| FR-64 | Datenhaltung in CH/EU wählbar, DSG/DSGVO-Unterstützung (AVV, Löschkonzept, Export).                                          | M    |
| FR-65 | Backups ohne Klartext-Secrets (vgl. SEC-31).                                                                                 | M    |

---

### 3.9 Hilfe und Einrichtung (analog lazy-koins, ab MVP)

| ID    | Anforderung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Prio |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| FR-70 | **Hilfe:** Menüpunkt „Hilfe“ in der Seitenleiste direkt über dem Benutzermenü, in Cloud und Desktop, auch während der Einrichtung erreichbar. Anleitung in einfacher Sprache, Schritt für Schritt in der Reihenfolge der Arbeit: Einrichtung, Projekt und Umgebungen, Gate installieren (je Hosting-Art), Vertrauensmodus wählen, Upstreams und Secrets, Routen und Recipes, Limits und Budgets, Freigeben/Signieren, Kill-Switch, Logs, Härtungsstufe verbessern, Desktop/Cloud und Datenschutz. Je Schritt: wozu, wo in der App, nummerierte Schritte, Tipps und „Öffnen“ zur passenden Seite; dazu häufige Fragen. | M    |
| FR-71 | Hilfe-Seite mit Inhaltsverzeichnis (breit links, schmal aufklappbar), Suche über alle Texte, „Schritt N von M“, Direktlinks `/app/help#<abschnitt>` (springen und markieren), Deutsch und Englisch, hell/dunkel, ab 375 px. Was nur für Cloud oder Desktop gilt, erscheint nur dort und ist markiert.                                                                                                                                                                                                                                                                                                                 | M    |
| FR-72 | **Kontextuelle Hilfe:** Ein „?“ in den Seitenköpfen (Gate, Routen, Secrets, Freigabe, Logs) und an jeder Anzeige von Vertrauensmodus und Härtungsstufe öffnet den passenden Abschnitt. Ergebnisse des Hardening-Checks (SEC-49) verlinken die Anleitung zur nächsthöheren Stufe.                                                                                                                                                                                                                                                                                                                                      | M    |
| FR-73 | **Einrichtungsassistent** beim ersten Start (Desktop) bzw. nach der ersten Anmeldung (Cloud): Stepper mit Zustand je Schritt (offen / erledigt / übersprungen / Fehler), „Zurück“/„Weiter“ fix unten, „Später“ für optionale Schritte, Zwischenstand gespeichert, jederzeit über Einstellungen wieder aufrufbar. Schritte: Profil, Signaturschlüssel bzw. Passkey (je Modus), erstes Projekt, erstes Gate mit Installation und Fingerprint-Bestätigung, erstes Recipe mit Test-Request, Zusammenfassung mit erreichtem Modus und Härtungsstufe. Wo möglich mit **Test-Knopf**.                                        | M    |
| FR-74 | Ändert sich eine Funktion, wird die Hilfe im selben Change angepasst. Die Hilfe beschreibt nur, was existiert.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | M    |

### 3.8 Moat Desktop (Betrieb ohne Cloud)

Moat Desktop ist die Control Plane ohne Server. Sie arbeitet immer in Vertrauensmodus 1 oder 2 (Key-Datei/Keychain bzw. Passkey/Hardware-Key). Der Schlüssel liegt im OS-Keychain (Windows Credential Manager, macOS Keychain, libsecret) oder in einer passphrase-geschützten Datei.

| ID    | Anforderung                                                                                                                                                                                          | Prio |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| DT-01 | Moat Desktop erzeugt, konfiguriert, signiert und deployt Gates komplett ohne Cloud.                                                                                                                  | M    |
| DT-02 | Gemeinsamer **Moat Core** für Desktop, Cloud und CLI. Identisches Verhalten durch Conformance-Tests.                                                                                                 | M    |
| DT-03 | **Speicher-Backend pro Projekt wählbar** (Tabelle unten). Secrets liegen in externen Backends ausschliesslich als Ciphertext. Neue Backends über ein Storage-Adapter-Interface im Core.              | M/S  |
| DT-04 | Schlüsselverwaltung im OS-Keychain oder in einer Key-Datei mit Passphrase, Passkey/Hardware-Key als Option.                                                                                          | M    |
| DT-05 | Deploy-Ziele: ZIP-Export, SFTP/FTPS, Git, lokaler Ordner. Zugangsdaten nur im Keychain.                                                                                                              | M    |
| DT-06 | Import/Export zwischen Desktop und Cloud in beide Richtungen. Der Wechsel der Config-Quelle eines Gates braucht lokale Bestätigung am Gate (SEC-06).                                                 | S    |
| DT-07 | Hardening-Check (SEC-49) aus der Desktop-App gegen ein deployetes Gate.                                                                                                                              | S    |
| DT-08 | **App-Härtung:** `contextIsolation`, keine Node-Integration im Renderer, Sandbox, strenge CSP, kein Laden von Remote-Inhalten, IPC mit Schema-Validierung.                                           | M    |
| DT-09 | App-Updates signiert, Update-Kanal abschaltbar, Builds reproduzierbar (SEC-60). Die App lädt nie Code nach.                                                                                          | M    |
| DT-10 | Vollständig offline nutzbar. Netzwerk nur für aktiv gewählte Funktionen (Deploy, Update-Check, externe DB). Keine Telemetrie ohne Opt-in.                                                            | M    |
| DT-11 | **Gate-Pull von eigenem Ort:** Das Gate kann signierte Bundles von einer statischen URL (S3, eigener Webspace) holen. Der Speicherort muss nicht vertrauenswürdig sein, das Gate prüft die Signatur. | M    |
| DT-12 | **Logs ohne Cloud:** Das Gate schreibt lokal, Desktop holt Logs bei Bedarf ab. Live-Dashboards und Alerts gibt es nur mit Cloud und sind im Produkt entsprechend gekennzeichnet.                     | S    |
| DT-13 | Geteilte Backends (externe DB, Dateispeicher) nutzen **optimistische Sperren** über die monotone Versionsnummer (SEC-04) und erkennen Konflikte.                                                     | S    |
| DT-15 | Signieren nur nach Bestätigung in einem **vom Main-Prozess gerenderten Dialog** mit Diff der Änderungen, nie direkt aus dem Renderer (T-51, T-53).                                                   | M    |
| DT-16 | Die lokale API prüft den `Host`-Header exakt (Schutz gegen DNS-Rebinding, T-52).                                                                                                                     | M    |
| DT-17 | Import-Härtung: Schlüssel wie `__proto__`/`constructor` werden abgelehnt, Objekte ohne Prototyp, Zip-Slip-Schutz beim Paket-Import (T-50).                                                           | M    |
| DT-14 | **Teamarbeit ohne Cloud** im MVP über Git (Projektordner): `moat.yaml` und signierte Bundles im Repo, Secrets nur versiegelt, Signieren lokal pro Person. Geteilte DB mit Rollen erst später.        | M    |
| DT-18 | Geteilte externe DB mit Rollen und Freigabe-Workflow für Teams ohne Cloud.                                                                                                                           | K    |

**Speicher-Backends:**

| Backend                                         | Zweck                                                        | Hinweis                                          |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| **Projektordner** (Default)                     | `moat.yaml`, verschlüsselte Secrets-Datei, signierte Bundles | Git-tauglich, keine DB nötig, einfachstes Backup |
| **Lokale SQLite**                               | Verlauf, Audit-Log, Diffs, Gate-Status                       | Verschlüsselbar, eine Datei                      |
| **Externe DB** (Postgres, MySQL/MariaDB)        | Teamarbeit, zentrale Sicherung                               | Nur Ciphertext und signierte Bundles             |
| **Dateispeicher** (S3-kompatibel, WebDAV, SFTP) | Backup oder Sync                                             | Gleiche Regel: nur Ciphertext                    |

---

## 4. Empfehlung: Umgang mit Shared Hosting (Begründung zu 2.5)

1. **Stufen statt Alles-oder-nichts.** Das Gate läuft überall, zeigt aber ehrlich, wie gut es dort geschützt ist. Das ist glaubwürdiger als ein pauschales Sicherheitsversprechen.
2. **Policy und Schlüssel gehören zum Installationspaket**, nicht zur Cloud-Config. Sie werden beim Installieren lokal erzeugt bzw. gesetzt. Dadurch gilt die Grenze "Cloud-Config ≤ lokale Policy" auch ohne Env-Variablen.
3. **Lazy Pull statt Cron:** Das Gate prüft bei Requests, ob die TTL abgelaufen ist, holt dann die Config (mit Lock-Datei gegen Parallelität) und arbeitet bis dahin mit dem Cache weiter.
4. **Selbsttest statt Annahmen:** Der Hardening-Check ruft die eigenen Dateien von aussen ab und warnt, wenn sie erreichbar sind.
5. **Upgrade-Pfad:** Wer H2 oder H3 erreichen kann, bekommt im Dashboard eine konkrete Anleitung (Schlüssel verschieben, Env setzen, Container nutzen).

## 5. Offene Punkte (nächster Schritt)

1. ~~Threat Model~~: v0.1 erstellt ([docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)), Vorschläge in v0.4 übernommen.
2. ~~Tech-Stack~~: entschieden, gleicher Stack wie lazy-koins, Desktop mit Electron (siehe CLAUDE.md).
3. ~~Kryptografie-Details~~: Spezifikation v0.1 in [docs/CRYPTO.md](docs/CRYPTO.md); Passkeys werden vom Gate als WebAuthn/ES256 geprüft.
4. ~~Default-Modus~~: Bequem mit Empfehlung (FR-46 bis FR-48).
5. ~~Produktwording~~: Abschnitt 2.9.
6. ~~Teamarbeit ohne Cloud~~: Git im MVP (DT-14), geteilte DB später (DT-18).
