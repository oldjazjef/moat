# Moat: Sicherheitstests

Grundlage: [ANFORDERUNGEN.md](../ANFORDERUNGEN.md) §2.10 (SEC-70 bis SEC-77) und
[THREAT-MODEL.md](THREAT-MODEL.md). Dieses Dokument sagt, **was** wann getestet wird und **womit**.
Jede Zeile wird konkret, sobald der Code dazu existiert. Dann steht in der Spalte „Test“ die Datei.

## 1. Überblick: Wann läuft was

| Ebene                   | Was                                                                    | Wann                                                             | Bricht den Build |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------- |
| Unit / Handler          | Angreifer-Tests pro SEC-Anforderung, Planted-Secret-Prüfung            | jeder PR (`pnpm check`)                                          | ja               |
| **Berechtigungsmatrix** | jeder Endpunkt × jede Rolle/Identität (Abschnitt 3)                    | jeder PR (`pnpm check`)                                          | ja               |
| Integration             | Mandantentrennung über die echte DB, Auth-Flows                        | jeder PR (`pnpm test:integration`)                               | ja               |
| Conformance             | Gate-Angriffe (SSRF, Smuggling, CRLF, Limits, Bundles)                 | jeder PR (`pnpm conformance`)                                    | ja               |
| SAST                    | CodeQL (TS), Semgrep (OWASP-Regeln, TS + PHP), PHPStan-Verbote         | jeder PR                                                         | ja, ab „mittel“  |
| Abhängigkeiten          | `osv-scanner` (pnpm + Composer), Lizenzprüfung (MIT-kompatibel)        | jeder PR + täglich                                               | ja, ab „hoch“    |
| Secrets im Repo         | `gitleaks`                                                             | jeder PR                                                         | ja               |
| Container / Helm        | Trivy (Images), `kubeconform` + Trivy-Config-Scan (Chart)              | jeder PR, der sie ändert                                         | ja, ab „hoch“    |
| Electron                | Electronegativity auf `apps/desktop`                                   | jeder PR, der sie ändert                                         | ja, ab „mittel“  |
| **DAST Cloud**          | OWASP ZAP API-Scan gegen die laufende API (OpenAPI) mit Login je Rolle | Baseline jeder PR, Vollscan nächtlich                            | ja, ab „mittel“  |
| **DAST Gate**           | ZAP gegen ein Gate mit Beispiel-Config hinter `php -S`                 | nächtlich                                                        | ja, ab „mittel“  |
| Fuzzing                 | `fast-check` (Parser), Korpus für PHP                                  | jeder PR (kurz), nächtlich (lang)                                | ja               |
| **Pentest intern**      | Checkliste nach OWASP WSTG + Compromise-Test §2.8                      | vor jedem Minor-Release                                          | Release-Blocker  |
| **Pentest extern**      | unabhängige Firma                                                      | vor Launch, dann jährlich und nach grossen Sicherheitsänderungen | Launch-Blocker   |

## 2. OWASP Top 10 (2025) → Moat

Pro Kategorie: wo das Risiko bei Moat liegt und welche Tests es abdecken. Die API-spezifische
Liste (OWASP API Security Top 10, 2023) steht in Abschnitt 4.

| Kategorie                                     | Wo bei Moat                                                                 | Abgedeckt durch                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **A01 Broken Access Control**                 | Cloud-Endpunkte, Mandanten, Rollen, Freigabe-Recht; Gate-Routen             | Berechtigungsmatrix (§3), Cross-Tenant-Integrationstests, ZAP mit mehreren Rollen, Pentest                                               |
| **A02 Security Misconfiguration**             | Helm/Compose-Defaults, CORS, Header, Electron, PHP-Laufzeit, Shared Hosting | Trivy-Config-Scan, Electronegativity, Header-Tests (CSP, HSTS, `nosniff`), Gate-Start setzt eigene ini-Werte, Hardening-Check (SEC-49)   |
| **A03 Software Supply Chain Failures**        | npm, Composer-Dev, CI, Release-Schlüssel                                    | osv-scanner, Lockfiles, `allowBuilds`, gitleaks, signierte Releases 2-von-3 (SEC-66), SBOM                                               |
| **A04 Cryptographic Failures**                | Bundles, Secrets, Key-Dateien, Passkeys                                     | Testvektoren `conformance/vectors/crypto/`, nur libsodium, Prüfreihenfolge (docs/CRYPTO.md §4.3)                                         |
| **A05 Injection**                             | YAML/JSON-Parser, SQL (Prisma), Header (CRLF), Logs, XSS im Dashboard       | Zod strict, keine Raw-Queries ohne Parameter, CRLF-Conformance, Angular-Escaping + CSP + Trusted Types, Semgrep                          |
| **A06 Insecure Design**                       | Vertrauensmodell Cloud → Gate                                               | Threat Model, Compromise-Test §2.8 als automatisierte Suite (gehackte Cloud simuliert), SEC-14                                           |
| **A07 Authentication Failures**               | Login, MFA, Passkeys, Sessions, API-Tokens, Gate-Auth                       | Auth-Flow-Tests (Brute-Force-Sperre, Session-Rotation, Logout, abgelaufene/widerrufene Tokens), Gate-Auth-Vektoren (Replay, Zeitfenster) |
| **A08 Software or Data Integrity Failures**   | Bundles, Auto-Update, Imports                                               | Bundle-Vektoren (Signatur, Version, Gate-ID), Release-Manifest-Vektoren, Import-Härtung (DT-17)                                          |
| **A09 Logging & Alerting Failures**           | Audit-Log, Freigaben, Gate-Logs                                             | Tests: jede Freigabe/Rollenänderung erzeugt Audit-Eintrag; Planted Secrets nie im Log; Hash-Kette + Checkpoints (SEC-59)                 |
| **A10 Mishandling of Exceptional Conditions** | Fail-Closed im Gate, Fehler in der API                                      | Tests: jede Ausnahme im Gate → generischer Fehler und kein Weiterleiten (SEC-46); API gibt nie Stacktraces aus                           |

SSRF (früher eigene Kategorie) ist im Gate das Kernrisiko und über die Conformance-Suite
(SEC-41) und den DAST-Gate-Scan abgedeckt.

## 3. Berechtigungsmatrix (Endpunkt × Identität)

Die Matrix ist **Code**, nicht Doku: `apps/api/src/security/authz-matrix.ts`. Ein Test
(`authz-matrix.spec.ts`, läuft in `pnpm check`) bootet die echte App, liest alle registrierten
Routen und schlägt fehl, wenn

- eine Route **keinen Eintrag** in der Matrix hat (neuer Endpunkt ohne Berechtigungsentscheid),
- ein Eintrag auf eine Route zeigt, die es nicht mehr gibt,
- eine Identität eine andere Antwort bekommt als erwartet.

Identitäten, die für **jeden** Endpunkt geprüft werden:

| Identität                                                       | Erwartung (Default)                   |
| --------------------------------------------------------------- | ------------------------------------- |
| ohne Token                                                      | 401 (ausser `@Public`)                |
| Token kaputt / falsche Signatur / abgelaufen / widerrufen       | 401                                   |
| gültiger Login ohne MFA, wo MFA Pflicht ist                     | 401 mit `mfaRequired`                 |
| Viewer, Editor, Admin, Owner, Billing des **eigenen** Mandanten | laut Matrix 2xx oder 403              |
| Rolle mit / ohne Freigabe-Recht (SEC-52)                        | Freigabe nur mit Recht                |
| **fremder Mandant** mit jeder Rolle                             | **404** (wie „gibt es nicht“, SEC-50) |
| API-Token mit falschem Scope                                    | 403                                   |
| Gate-Anmeldung (SEC-55) an Benutzer-Endpunkten                  | 401                                   |
| Benutzer-Login an Gate-Endpunkten                               | 401                                   |
| Desktop: Request ohne Zugriffstoken / falscher `Host`           | 403 (DT-16)                           |

Zusätzlich je Endpunkt: IDs anderer Mandanten im Body und in der URL (IDOR), Massenzuweisung
(unbekannte Felder werden abgelehnt), CSRF bei Cookie-Sessions, Rate Limits auf Login und
Token-Endpunkten.

## 4. OWASP API Security Top 10 (2023)

| Kategorie                                            | Abgedeckt durch                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| API1 Broken Object Level Authorization               | Matrix + IDOR-Fälle (§3)                                                                                            |
| API2 Broken Authentication                           | Auth-Flow-Tests, Token-Fälle der Matrix                                                                             |
| API3 Broken Object Property Level Authorization      | DTOs strikt (`whitelist` + `forbidNonWhitelisted`), Antwort-DTOs ohne interne Felder, Tests auf überflüssige Felder |
| API4 Unrestricted Resource Consumption               | Rate Limits, Body-/Upload-Grenzen, Paginierung mit Maximum; Gate: SEC-27, Budgets                                   |
| API5 Broken Function Level Authorization             | Matrix (Rollen × Admin-Funktionen)                                                                                  |
| API6 Unrestricted Access to Sensitive Business Flows | Freigabe/Signieren, Einladungen, Kill-Switch: Rechte + Audit + Bestätigung                                          |
| API7 Server Side Request Forgery                     | Cloud ruft keine kundengesteuerten URLs ohne SSRF-Schutz auf (Webhooks, Bundle-URLs); Gate: SEC-41                  |
| API8 Security Misconfiguration                       | wie A02                                                                                                             |
| API9 Improper Inventory Management                   | Matrix = Inventar aller Endpunkte; OpenAPI-Dokument aus dem Code; keine versteckten Debug-Routen in Produktion      |
| API10 Unsafe Consumption of APIs                     | Gate behandelt Upstream-Antworten als nicht vertrauenswürdig (FR-14, FR-18, SEC-39)                                 |

## 5. Pentest

**Intern, vor jedem Minor-Release:** Checkliste nach OWASP WSTG in
`docs/pentest/<version>.md` (Datum, Version, wer, was geprüft, Befunde mit Schweregrad, Status).
Pflichtteile: Berechtigungen manuell über die UI, Session-Handling, Enrollment und Setup-Modus
(SEC-28), Gate auf Shared Hosting (H1) inklusive Abruf der Datendateien von aussen, Desktop-IPC,
und der **Compromise-Test** aus §2.8 (Cloud-DB und ausgeliefertes JS manipulieren, prüfen, was
ein Gate in jedem Modus annimmt).

**Extern:** vor dem Launch, danach jährlich und nach grossen Änderungen an Krypto, Auth oder Gate.
Bericht bleibt privat; Befunde werden als Security Advisories erfasst.

## 6. Umgang mit Befunden

| Schweregrad | Frist bis Fix im Release | Zusätzlich                              |
| ----------- | ------------------------ | --------------------------------------- |
| Kritisch    | 7 Tage                   | Advisory, betroffene Kunden informieren |
| Hoch        | 30 Tage                  | Advisory                                |
| Mittel      | nächstes Minor-Release   | —                                       |
| Niedrig     | nach Ermessen            | —                                       |

Jeder Befund bekommt einen **Regressionstest** (oder einen Conformance-Fall), bevor er als behoben
gilt. Eine Ausnahme von einem Scanner-Befund braucht eine Begründung im Code neben der Ausnahme
und eine Prüfung beim nächsten Pentest.
