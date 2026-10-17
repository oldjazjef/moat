# Moat Cloud selbst betreiben (Docker Compose)

Das Compose-Projekt startet **Moat Cloud** (API und Dashboard von einem Ursprung) und
**PostgreSQL**. Es ist der Anfang des Self-Hostings (FR-60, SEC-57), noch nicht der ganze Cloud-Umfang.

> **Ehrliche Grenzen (Stand: Cloud-Slice 3).** Es gibt noch **keine E-Mails** (keine Bestätigung der
> Adresse, kein Passwort-Reset, keine Einladungen), **keine Gates in der Cloud** (Konten,
> Organisationen und leere Projekte, sonst nichts), **keine Oberfläche für den Audit-Log** (es gibt ihn nur als API: `GET /api/orgs/:orgId/audit`), keine Passkeys/OIDC für
> Konten und **kein TLS im Compose**: davor gehört ein Reverse Proxy. Das Image wurde in dieser
> Umgebung geschrieben und gegen die gebauten Dateien geprüft, aber **nicht mit Docker gebaut**
> (kein Docker-Daemon); die Basis-Images sind per Tag, nicht per Digest festgelegt.

## Voraussetzungen

- Docker mit Compose v2, `openssl`, `sh`.
- Einen Reverse Proxy (Caddy, nginx, Traefik …) mit gültigem TLS-Zertifikat für Ihre Adresse. Er
  gibt `https://moat.example.ch` an `127.0.0.1:3000` weiter und setzt `X-Forwarded-For`.

## Einrichten

```bash
cd deploy/compose
./init-secrets.sh
```

`init-secrets.sh` legt `secrets/` an (Ordner 0700, wird nie committet) mit:

| Datei                                        | Inhalt                                                        |
| -------------------------------------------- | ------------------------------------------------------------- |
| `moat_account_key`                           | 32 Zufallsbytes (base64url): versiegelt die TOTP-Geheimnisse  |
| `db_password`, `moat_database_url`           | Passwort der Datenbank und die URL, die Moat daraus bildet    |
| `db_ca.crt`, `db_server.crt`, `.key`-Dateien | eine kleine eigene CA und das Serverzertifikat für `postgres` |

Bestehende Dateien werden nicht überschrieben. `db_ca.key` wird nur zum Ausstellen eines neuen
Serverzertifikats gebraucht: bewahren Sie sie nicht auf dem Server auf.

Dann die Einstellungen in `.env` (diese Datei wird nicht committet, `.env*` ist ignoriert):

```bash
cat > .env <<'EOF'
MOAT_PUBLIC_ORIGIN=https://moat.example.ch
MOAT_COOKIE_SECURE=true
MOAT_TRUST_PROXY=1
MOAT_BIND=127.0.0.1
MOAT_PORT=3000
EOF
```

- `MOAT_PUBLIC_ORIGIN`: die **eine** Adresse des Dashboards, `https`, ohne Pfad. Anfragen mit
  einem anderen `Origin` werden abgewiesen (CSRF, T-78). Pflicht.
- `MOAT_COOKIE_SECURE`: `true` (der Server verweigert `false` in Produktion).
- `MOAT_TRUST_PROXY`: Anzahl der Reverse Proxys davor (0 bis 8). Mit `0` sähe der Server jede
  Anfrage als vom Proxy kommend, und die Ratenbegrenzung pro Adresse träfe alle auf einmal.
- `MOAT_BIND`: `127.0.0.1` lassen; `0.0.0.0` böte HTTP im Netz an.

Geheimnisse stehen **nicht** in `.env`, sondern nur als Docker-Secrets in `secrets/`.

**E-Mail (optional):** Bestätigung der Adresse, Passwort-Reset und Einladungen brauchen einen
Mailserver. Im `docker-compose.yml` stehen die Zeilen `MOAT_SMTP_*` und `MOAT_MAIL_FROM` auskommentiert;
einkommentieren, die Werte in `.env` setzen und ein Passwort (falls der Server eines will) als Docker-Secret
`moat_smtp_password` anlegen. Was Moat Cloud verschickt und was es dabei prüft, steht in
[../docker/README.md](../docker/README.md#e-mail).

## Starten

```bash
docker compose up -d --build
docker compose ps          # moat-cloud und postgres: healthy
curl -s http://127.0.0.1:3000/readyz   # {"status":"ready"}
```

`/healthz` (Prozess läuft) und `/readyz` (Datenbank antwortet, Prozess fährt nicht herunter)
sind absichtlich ohne Anmeldung und liefern nur einen festen Text, keine Daten.

## Das erste Konto

Es gibt keinen vorgegebenen Administrator. Öffnen Sie `https://moat.example.ch`, wählen Sie
«Registrieren» und legen Sie Ihr Konto an, danach «Anmelden» und eine Organisation anlegen: Sie
sind deren Inhaber. Wichtig: **Die Registrierung ist offen**, jede Person, die die Adresse
erreicht, kann ein Konto anlegen (es gibt noch keine Einladungen und keine Bestätigung per
E-Mail). Betreiben Sie die Instanz bis dahin nur hinter einem Zugriffsschutz des Reverse Proxys
(Basic-Auth, VPN, IP-Liste), wenn sie nicht öffentlich sein soll.

Per Kommandozeile (derselbe Weg wie das Dashboard, mit dem `Origin` Ihrer Adresse):

```bash
curl -s -X POST http://127.0.0.1:3000/api/auth/register \
  -H 'Origin: https://moat.example.ch' -H 'Content-Type: application/json' \
  -d '{"email":"sie@example.ch","password":"mindestens zwölf Zeichen"}'
```

Die Antwort ist immer `{"status":"accepted"}`, ob die Adresse neu war oder nicht (sie verrät
keine bestehenden Konten, T-79).

## Was läuft wie

- **Container:** nicht als root (uid 1000), `read_only: true` (nur `/tmp` als tmpfs und `/data`
  beschreibbar), `cap_drop: ALL`, `no-new-privileges`, Speicher- und Prozessgrenzen.
- **Datenbank:** nur im Netz `backend` (`internal: true`, kein Weg nach aussen, kein Port
  veröffentlicht). Moat verbindet sich mit TLS und **geprüftem Zertifikat** (`sslmode=verify-full`,
  die CA kommt über `NODE_EXTRA_CA_CERTS`); die Cloud verweigert eine andere Verbindung zu einem
  fremden Host. PostgreSQL selbst erzwingt TLS im internen Netz nicht (`pg_hba.conf` des Images);
  das Netz ist abgeschottet.
- **Migrationen** laufen beim Start im Prozess (mit Sperre); eine fremde oder neuere Datenbank
  wird verweigert, nicht verändert.
- **Header:** CSP ohne Inline-Skript (`script-src 'self'`), `frame-ancestors 'none'`, `nosniff`,
  `Referrer-Policy: no-referrer`, HSTS bei `MOAT_COOKIE_SECURE=true`.
- **Beenden:** `docker compose stop` sendet `SIGTERM`: `/readyz` wird 503, laufende Anfragen
  haben bis zu 10 Sekunden, dann schliesst die Datenbank.

## Sicherung und Erneuerung

- Sichern Sie das Volume `postgres-data` (zum Beispiel `pg_dump`) **und** `secrets/moat_account_key`
  **getrennt voneinander**. Ohne den Schlüssel sind die TOTP-Geheimnisse in einer Sicherung
  unbrauchbar, mit beiden zusammen lesbar.
- `moat_account_key` zu ändern macht bestehende TOTP-Einrichtungen unbrauchbar (die Betroffenen
  müssen neu einrichten, bis es ein Verfahren für den Schlüsselwechsel gibt).
- Das Datenbankpasswort zu ändern: neues `secrets/db_password` **und** `secrets/moat_database_url`,
  dazu `ALTER USER moat PASSWORD '…'` in der Datenbank. Das Serverzertifikat gilt 825 Tage:
  `secrets/db_server.*` löschen, `./init-secrets.sh` erneut ausführen (braucht `db_ca.key`) und
  `docker compose up -d`.

## Was die Cloud nie tut

Sie kann keine Geheimnisse der Kunden lesen (SEC-31) und ein Gate nicht übernehmen: ein
vollständig kompromittierter Server ändert weder die lokale Policy noch die gepinnten Schlüssel
eines Gates (ANFORDERUNGEN.md §1).
