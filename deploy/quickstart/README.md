# Moat Cloud in einem Befehl (Docker, mit TLS)

Server (SQLite) und **Caddy**, der das TLS-Zertifikat holt und erneuert. Für **eine** Instanz. Für
mehrere Instanzen oder einen Datenbank-Server: [`../compose/`](../compose/README.md) (PostgreSQL)
oder [Kubernetes](../helm/moat-cloud/README.md). Alle Einstellungen des Images:
[`../docker/README.md`](../docker/README.md).

## Voraussetzungen

- Docker mit Compose v2.
- Eine Domain (`moat.example.ch`), deren DNS auf diesen Rechner zeigt, und die Ports 80 und 443
  frei (Let's Encrypt prüft über Port 80 oder 443).

## Starten

```bash
cd deploy/quickstart
./init.sh moat.example.ch      # einmal: secrets/ und .env
docker compose up -d
```

Dann `https://moat.example.ch` öffnen und ein Konto anlegen. Der Server ist nur über Caddy
erreichbar (internes Netz); Caddy ist der einzige Dienst mit veröffentlichten Ports.

- **Version festlegen** (empfohlen für Produktion): `MOAT_IMAGE=ghcr.io/<owner>/moat-cloud:1.2.3`
  in `.env`. Ohne Angabe läuft `latest`.
- **Test auf dem eigenen Rechner:** `./init.sh localhost`, dann öffnet Caddy mit einer eigenen CA
  (der Browser warnt einmal). Andere Ports: `MOAT_HTTP_PORT` / `MOAT_HTTPS_PORT` in `.env`.
- **`secrets/moat_account_key` sichern**, nicht zusammen mit den Daten: er versiegelt die
  TOTP-Geheimnisse.

## Aktualisieren und sichern

```bash
docker compose pull && docker compose up -d       # neue Version; Migrationen laufen beim Start
```

Die Daten liegen im Volume `moat-data` (`/data/cloud.db`). Sicherung der SQLite-Datei am besten bei
gestopptem Container oder mit `sqlite3 … ".backup"`; ein `cp` der laufenden Datenbank kann
inkonsistent sein.

## Was dieses Setup nicht ist

Kein Hochverfügbarkeits-Setup (eine Instanz, eine Datei), keine E-Mails, und die Cloud kann ein Gate
nie ändern (siehe die Regel in CLAUDE.md). Der Caddy-Image-Tag ist festgelegt, der Digest erst beim
Release.
