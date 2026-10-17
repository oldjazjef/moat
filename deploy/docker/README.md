# Moat Cloud als Docker-Image

Ein Image, alles über Umgebungsvariablen: **SQLite** für eine Instanz (ein Container, ein Volume)
oder **PostgreSQL** für mehrere Replikate. Dasselbe Image läuft in Docker, Docker Compose und
Kubernetes ([Helm-Chart](../helm/moat-cloud/README.md)).

> **Ehrliche Grenzen (Stand Cloud-Slice 5).** Das Image enthält Konten, Organisationen, Projekte
> und den Audit-Log (nur API). **Keine E-Mails, keine Gates in der Cloud**, kein TLS im Image (davor
> gehört ein Reverse Proxy), die Cloud ist noch nicht der volle Funktionsumfang. Das Image wurde in
> der Entwicklungsumgebung gebaut und gestartet (amd64); arm64 und der Veröffentlichungs-Job
> (`release.yml`) sind **nicht** gelaufen. Veröffentlichte Images stehen unter
> `ghcr.io/<owner>/moat-cloud:<version>` (nach dem ersten Push einmal in GitHub unter «Packages»
> auf **public** stellen, sonst braucht jeder Download eine Anmeldung).

## Schnellstart (eine Instanz, SQLite)

```bash
KEY="$(head -c 32 /dev/urandom | basenc --base64url | tr -d '=')"   # einmal erzeugen und aufbewahren
docker run -d --name moat-cloud --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e MOAT_PUBLIC_ORIGIN=https://moat.example.ch \
  -e MOAT_ACCOUNT_KEY="$KEY" \
  -e MOAT_TRUST_PROXY=1 \
  -v moat-data:/data \
  ghcr.io/<owner>/moat-cloud:<version>
```

Dann einen Reverse Proxy (Caddy, nginx, Traefik …) mit gültigem TLS-Zertifikat für
`https://moat.example.ch` auf `127.0.0.1:3000` zeigen lassen; er muss `X-Forwarded-For` setzen.
Ohne HTTPS funktioniert die Anmeldung nicht (Cookie `Secure`, HSTS). `/healthz` (lebt) und
`/readyz` (bereit) gehören dem Orchestrator, nicht dem Proxy.

**Den Schlüssel `MOAT_ACCOUNT_KEY` nicht verlieren und nicht zusammen mit der Datenbank sichern:**
er versiegelt die TOTP-Geheimnisse. Ohne ihn sind eingerichtete Zwei-Faktor-Konten unbrauchbar.

## Konfiguration

| Variable                                                            | Pflicht  | Standard             | Bedeutung                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOAT_PUBLIC_ORIGIN`                                                | ja       |                      | Die **eine** Adresse des Dashboards: `https://…`, ohne Pfad. Anfragen mit anderem `Origin` werden abgewiesen.                                                                                                 |
| `MOAT_ACCOUNT_KEY`                                                  | ja       |                      | 32 Zufallsbytes, base64url ohne `=` (43 Zeichen). Oder `MOAT_ACCOUNT_KEY_FILE` (Pfad zu einer Datei).                                                                                                         |
| `MOAT_SIGNING_KEY`                                                  | nein     |                      | 32 Zufallsbytes (ein Ed25519-Seed), base64url ohne `=`. Damit signiert Moat Cloud die Bundles von Gates im Modus «Bequem». Ohne ihn gibt es nur Gates, die du selbst signierst. Oder `MOAT_SIGNING_KEY_FILE`. |
| `MOAT_SIGNING_KEY_NEXT_PUBLIC` / `MOAT_SIGNING_KEY_PREVIOUS_PUBLIC` | nein     |                      | Öffentliche Schlüssel (base64url) eines laufenden Schlüsselwechsels, siehe unten. Sie ändern nur, was das Dashboard zeigt und welche früheren Bundles beim Vergleich zählen, nie, womit signiert wird.        |
| `MOAT_SMTP_HOST` / `MOAT_SMTP_PORT` / `MOAT_SMTP_SECURITY`          | nein     | / `587` / `starttls` | Der Mailserver für Konto-Mails (siehe «E-Mail»). Ohne Host: keine Mails. `MOAT_SMTP_SECURITY`: `starttls` (Pflicht, nie freiwillig), `tls` (Port 465) oder `none` (nur ein Server auf derselben Maschine).    |
| `MOAT_MAIL_FROM`                                                    | bei SMTP |                      | Absender aller Mails: eine blosse Adresse, `noreply@moat.example.ch`. Die Links in den Mails beginnen mit `MOAT_PUBLIC_ORIGIN`.                                                                               |
| `MOAT_SMTP_USER` / `MOAT_SMTP_PASSWORD`                             | nein     |                      | Anmeldung am Mailserver, beide oder keines. Das Passwort besser als `MOAT_SMTP_PASSWORD_FILE`.                                                                                                                |
| `MOAT_DB_PROVIDER`                                                  | nein     | `sqlite`             | `sqlite` (Datei in `/data/cloud.db`, **eine** Instanz) oder `postgresql`.                                                                                                                                     |
| `MOAT_DATABASE_URL`                                                 | bei pg   |                      | `postgresql://…`; TLS ist Pflicht, ausser zu `localhost`. Oder `MOAT_DATABASE_URL_FILE`.                                                                                                                      |
| `MOAT_TRUST_PROXY`                                                  | nein     | `0`                  | Zahl der Reverse Proxys davor (0 bis 8). Mit `0` sieht der Server jede Anfrage als vom Proxy kommend.                                                                                                         |
| `MOAT_COOKIE_SECURE`                                                | nein     | `true`               | In Produktion muss es `true` sein.                                                                                                                                                                            |
| `MOAT_DATA_DIR`                                                     | nein     | `/data`              | Wo die SQLite-Datei liegt. Das Volume gehört dem Benutzer 1000.                                                                                                                                               |
| `HOST` / `PORT`                                                     | nein     | `0.0.0.0` / `3000`   | Wo der Server lauscht (im Container nicht ändern; Port nur über `-p` abbilden).                                                                                                                               |
| `NODE_EXTRA_CA_CERTS`                                               | nein     |                      | Pfad zur CA, die das Zertifikat deiner PostgreSQL-Datenbank ausgestellt hat (bei eigener CA).                                                                                                                 |

Jede Variable ausser den zwei Geheimnissen und der Adresse hat einen sicheren Standard. Der Server
**startet nicht** bei einem falschen Wert und nennt dann nur den Namen der Variable, nie den Wert.
`NAME` und `NAME_FILE` zusammen sind ein Fehler. Geheimnisse gehören in Docker-Secrets oder
Kubernetes-Secrets (`…_FILE`), nicht in `docker inspect`-sichtbare Umgebung.

## E-Mail

Mit `MOAT_SMTP_HOST` verschickt Moat Cloud drei Arten von Mails, alle als feste Texte (Deutsch und
Englisch), ohne dass etwas, was eine Person eingetippt hat, darin vorkommt:

- **Bestätigung der Adresse** nach der Registrierung (Link, 24 Stunden, einmal). Bis dahin kann sich
  das Konto nicht anmelden, und eine Einladung an die Adresse wird noch nicht angewendet.
- **Passwort zurücksetzen** (Link, 1 Stunde, einmal). Das Setzen beendet alle Sitzungen des Kontos.
- **Einladung** an eine Adresse ohne bestätigtes Konto (14 Tage). Die Mail nennt weder die
  Organisation noch die einladende Person.

Ohne Mailserver gelten Konten sofort als bestätigt, es gibt keinen Passwort-Reset, und eine
Einladung gilt, sobald sich die Person mit dieser Adresse registriert.

Was der Betreiber wissen muss:

- Der Link trägt den Token hinter `#`, damit er in keinem Server-Log und keinem Referer landet.
  Moat Cloud speichert nur den SHA-256 des Tokens.
- TLS wird immer geprüft (Zertifikat, Host, mindestens TLS 1.2). Ein Zertifikat, das keine
  Zertifizierungsstelle des Systems ausgestellt hat, wird abgelehnt; für eine eigene CA gilt
  `NODE_EXTRA_CA_CERTS`. Das Passwort geht nie ohne TLS an einen anderen Rechner.
- Mails gehen im Hintergrund hinaus. Fällt der Mailserver aus, schlägt keine Anfrage fehl; im Log
  steht nur ein fester Fehlername (`connect`, `timeout`, `rejected`, …), nie eine Adresse.
- Pro Postfach höchstens 3 Bestätigungs-, 3 Reset- und 3 Einladungs-Mails pro Stunde bzw. Tag. Wer
  darüber liegt, bekommt keine weitere Mail und keine Meldung, sonst verriete die Antwort, ob es die
  Adresse gibt.
- SPF, DKIM und DMARC der Absender-Domain sind Sache deines Mailservers: Ohne sie landen die Mails
  im Spam.

## Laufzeit-Härtung

Das Image läuft als Benutzer 1000, der Code ist root-gehörig und nur lesbar. Empfohlen:

```bash
docker run … --read-only --tmpfs /tmp:size=16m,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 512m …
```

## Mehr als eine Instanz, TLS, Kubernetes

- **Compose** mit PostgreSQL, Docker-Secrets und verifiziertem DB-TLS: [`deploy/compose/`](../compose/README.md).
- **Kubernetes**: [`deploy/helm/moat-cloud/`](../helm/moat-cloud/README.md). Das Chart nimmt dasselbe
  Image, setzt dieselben Variablen und verlangt PostgreSQL.
- **SQLite nur mit einer Instanz** und einem Volume; nie dieselbe Datei in zwei Container.

## Aktualisieren und sichern

Neue Version = neuen Tag ziehen und den Container ersetzen; beim Start werden Migrationen
angewendet (ein Schema, das neuer ist als die Software, wird verweigert). SQLite sichern mit
`sqlite3 /data/cloud.db ".backup /backup/cloud.db"` (nicht mit `cp` einer laufenden Datenbank).
Nach jeder Version, die ein Gate betrifft, gilt weiter: die Cloud kann ein Gate nie ändern (CLAUDE.md,
«The one rule above all others»).

## Selbst bauen

```bash
docker build -f deploy/docker/Dockerfile -t moat-cloud:local \
  --build-arg MOAT_VERSION=1.2.3 --build-arg MOAT_COMMIT=$(git rev-parse HEAD) .
```

## Gates in Moat Cloud

Mit `MOAT_SIGNING_KEY` signiert Moat Cloud die Bundles von Gates im Modus «Bequem» (Modus 0). Das
Gate pinnt den öffentlichen Schlüssel (`php moat-gate.php trust --signer=…`), den das Dashboard unter
«Gates» zeigt. **Verliere den Schlüssel nicht und tausche ihn nicht aus:** ein neuer Schlüssel muss an
jedem Gate neu bestätigt werden. Ohne den Schlüssel gibt es nur Gates, die du selbst signierst
(«Signiert»); Moat Cloud legt dann nur ab und prüft. Secrets versiegelst du bei dir (`moat secret seal`
oder Moat Desktop), Moat Cloud sieht sie nie im Klartext.

Prüfen, dass alles zusammenspielt (Cloud-Ablauf, und das echte PHP-Gate gegen die Cloud):

```bash
pnpm install && pnpm build:gate-php
sh scripts/smoke-flow-image.sh moat-cloud:local
```

### Den Signaturschlüssel wechseln

Ein Gate vertraut dem gepinnten öffentlichen Schlüssel. Der Wechsel geht deshalb in Schritten, damit
kein Gate ein Bundle verliert:

1. Neuen Seed erzeugen (`head -c 32 /dev/urandom | basenc --base64url | tr -d '='`) und **nur seinen
   öffentlichen Schlüssel** als `MOAT_SIGNING_KEY_NEXT_PUBLIC` setzen. Das Dashboard zeigt ihn unter
   «Gates» als angekündigt. (Seed und öffentlichen Schlüssel erzeugt `node scripts/cloud-signing-key.mjs`; mit einem Seed als
   Argument zeigt es nur dessen öffentlichen Schlüssel.)
2. An **jedem Gate** beide eintragen: `php moat-gate.php trust --signer=<alt>,<neu>`.
3. `MOAT_SIGNING_KEY` auf den neuen Seed stellen, `MOAT_SIGNING_KEY_NEXT_PUBLIC` entfernen und den alten
   öffentlichen Schlüssel als `MOAT_SIGNING_KEY_PREVIOUS_PUBLIC` eintragen. Die nächste Freigabe ist mit
   dem neuen Schlüssel signiert; der Vergleich mit dem letzten Bundle funktioniert weiter.
4. Hat ein Gate ein neues Bundle angenommen: dort `trust --signer=<neu>`. Danach den alten Schlüssel aus
   der Umgebung entfernen.

Ein Gate, das den neuen Schlüssel nicht kennt, lehnt dessen Bundles ab und läuft mit dem letzten gültigen
weiter. Moat Cloud kann das Pinnen nie selbst ändern (SEC-06).
