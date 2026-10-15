# Moat: Krypto-Spezifikation (v0.1)

Grundlage: [ANFORDERUNGEN.md](../ANFORDERUNGEN.md) v0.4 und [THREAT-MODEL.md](THREAT-MODEL.md).
Diese Spezifikation ersetzt die „Crypto defaults“ im CLAUDE.md. Jede Änderung hier braucht neue
Testvektoren in `conformance/vectors/crypto/` und Änderungen in **allen** Implementierungen
(`libs/core`, jedes Gate) im selben PR.

Schlüsselwörter: **MUSS**, **DARF NICHT**, **SOLL** im Sinne von RFC 2119.

---

## 1. Grundsätze

1. **Nur libsodium-Primitive.** TypeScript: `libsodium-wrappers-sumo`. PHP: `ext-sodium` und
   `hash`. Einzige Ausnahme: ECDSA P-256 für Passkeys (Abschnitt 7) über `ext-openssl` bzw.
   Web Crypto, und nur wenn Modus 2 genutzt wird.
2. **Keine Aushandlung.** Jedes Objekt trägt `v` und `alg`. Unbekannte Werte führen zur Ablehnung,
   nie zu einem Fallback.
3. **Domänentrennung.** Jede Signatur und jede Ableitung beginnt mit einem festen Kontext-String
   (`moat:<zweck>:v1`), damit eine Signatur nie in einem anderen Zusammenhang gültig ist.
4. **Erst Bytes prüfen, dann parsen** (SEC-01, SEC-03). Signiert werden die exakten Payload-Bytes.
   Eine Implementierung DARF NICHT neu serialisieren, um zu prüfen.
5. **Konstante Zeit** für jeden Vergleich geheimer Werte (`hash_equals`, `sodium_memcmp`),
   Zufall nur aus dem CSPRNG der Bibliothek, `memzero` nach Gebrauch, wo die Sprache es erlaubt.

## 2. Kodierungen

| Was                    | Kodierung                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binärdaten in JSON     | **base64url ohne Padding** (RFC 4648 §5). Decoder lehnen Padding, `+`, `/` und Leerzeichen ab.                                                                                                                                                                                                                                                                                                    |
| Signierte JSON-Objekte | **RFC 8785 (JCS)**. Zahlen nur als Ganzzahlen im Bereich 0 bis 2⁵³−1; Fliesskommazahlen sind in signierten Objekten verboten.                                                                                                                                                                                                                                                                     |
| Zeitpunkte             | Ganzzahl, Sekunden seit Unix-Epoche (UTC).                                                                                                                                                                                                                                                                                                                                                        |
| Texte                  | UTF-8. Namen (Routen, Upstreams, Secrets) nach `^[a-z][a-z0-9-]{0,62}$`, daher ohne Normalisierungsfragen.                                                                                                                                                                                                                                                                                        |
| Grössenlimits          | Envelope ≤ 1 MiB, JSON-Tiefe ≤ 32. Überschreitung: Ablehnung vor jedem Parsen bzw. beim Parsen.                                                                                                                                                                                                                                                                                                   |
| JSON-Parser            | Alle Implementierungen akzeptieren genau dieselben Dokumente: UTF-8 ohne BOM, Zahlen nur `0` … `2⁵³−1` ohne Bruch und Exponent (`-0` gilt als `0`, weil PHP es nicht unterscheiden kann), keine einzelnen UTF-16-Surrogates, kein Objekt-Schlüssel, der mit NUL beginnt. Doppelte Schlüssel: der letzte gilt (wie `JSON.parse` und `json_decode`). Fälle: `conformance/vectors/crypto/json.json`. |

## 3. Schlüssel und Kennungen

| Schlüssel                | Algorithmus                               | Besitzer                         | Zweck                            |
| ------------------------ | ----------------------------------------- | -------------------------------- | -------------------------------- |
| Gate-Box-Schlüssel       | X25519                                    | Gate (erzeugt beim Installieren) | Secrets entschlüsseln (SEC-30)   |
| Gate-Auth-Schlüssel      | Ed25519                                   | Gate                             | Anmeldung bei der Cloud (SEC-55) |
| Kunden-Signaturschlüssel | Ed25519 (Modus 1, 3) oder ES256 (Modus 2) | Kunde                            | Bundles freigeben                |
| Cloud-Signaturschlüssel  | Ed25519                                   | Moat Cloud                       | Bundles in Modus 0               |
| Release-Schlüssel        | Ed25519, mehrere                          | Moat-Projekt                     | Gate-Releases (SEC-60, SEC-66)   |

**Key-ID (`kid`):** `base64url( BLAKE2b-128( "moat:kid:v1|" ‖ alg ‖ "|" ‖ publicKeyBytes ) )`
mit `crypto_generichash`, Ausgabelänge 16 Bytes. Bei ES256 ist `alg` der String
**`webauthn-es256`** (überall gleich: Schlüssel-ID, Trust-Datei, Envelope, Vektoren) und
`publicKeyBytes` der unkomprimierte Punkt `0x04 ‖ X ‖ Y` (65 Bytes, je 32 Bytes Big-Endian).
Der Fingerprint eines Passkeys ist der Fingerprint dieser `kid`-Bytes.

**Fingerprint für Menschen** (SEC-32): dieselben 16 Bytes in Base32 (RFC 4648, ohne Padding,
Grossbuchstaben), in Vierergruppen: `MOAT-ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23`. Beim Bestätigen
MÜSSEN alle Gruppen verglichen werden; die UI lässt kein Abkürzen zu.

**Gate-ID:** 16 Zufallsbytes, base64url (22 Zeichen), beim Installieren erzeugt. Sie ändert sich
bei Schlüsselrotation nicht.

## 4. Bundle

### 4.1 Payload

Ein JSON-Objekt in JCS-Form:

```json
{
  "type": "moat.bundle",
  "v": 1,
  "gateId": "q3V8x1Yp0mZb2cWfK9d7aA",
  "version": 42,
  "issuedAt": 1791792000,
  "expiresAt": null,
  "config": { "…": "die kompilierte moat.yaml" },
  "secrets": { "hubspot-token": { "…": "versiegeltes Secret, Abschnitt 5" } }
}
```

- `version`: Ganzzahl ≥ 1, streng monoton pro Gate (SEC-04). Rollback = neue höhere Version.
- `expiresAt`: `null` (Default, SEC-05) oder Zeitpunkt.
- `config`: Struktur nach `schema/moat.schema.json`, Objekte strikt.

### 4.2 Envelope

```json
{
  "moat": "bundle",
  "v": 1,
  "payload": "<base64url der JCS-Payload-Bytes>",
  "sigs": [{ "kid": "…", "alg": "ed25519", "sig": "<base64url, 64 Bytes>" }]
}
```

- Signierte Nachricht: `M = "moat:bundle:v1\n" ‖ payloadBytes`.
- Ed25519: `sig = crypto_sign_detached(M, sk)`.
- Mehrere Einträge in `sigs` erlauben M-of-N (SEC-09). Das Gate kennt pro Vertrauensmodus eine
  Schwelle (Default 1).
- Ein Eintrag mit `alg: "ed25519"` hat **genau** die Schlüssel `kid`, `alg`, `sig`; ein Eintrag
  mit `alg: "webauthn-es256"` (Modus 2, Abschnitt 7) hat **genau** `kid`, `alg`, `sig`,
  `authenticatorData`, `clientDataJSON`. Jede andere Schlüsselmenge ist `envelope_invalid`.

### 4.3 Prüfreihenfolge im Gate

Die Reihenfolge ist verbindlich. Jeder Fehler verwirft das Bundle, das Gate läuft mit dem letzten
gültigen weiter (SEC-03).

1. Grösse ≤ 1 MiB.
2. Envelope parsen: genau die Schlüssel `moat`, `v`, `payload`, `sigs`; `moat == "bundle"`,
   `v == 1`.
3. `payload` base64url-dekodieren (strikt) → `payloadBytes`. **Noch nicht als JSON parsen.**
4. Signaturen prüfen: Pro Eintrag `kid` unter den gepinnten Schlüsseln des aktiven Modus suchen,
   `alg` muss zum gepinnten Schlüssel passen, Signatur über `M` prüfen (Ed25519 direkt, ES256
   nach Abschnitt 7.3). Unbekannte `kid` werden übergangen, eine bekannte `kid` mit falschem
   `alg` oder falscher Signatur verwirft das Bundle (`signature_invalid`). Doppelte `kid` zählen
   einmal. Zu wenige gültige Signaturen → `threshold_not_met`.
5. Jetzt `payloadBytes` als JSON parsen (Tiefe ≤ 32), `type`, `v` prüfen.
6. `gateId` muss exakt der eigenen Gate-ID entsprechen (SEC-07).
7. `version` > zuletzt akzeptierte Version (SEC-04).
8. `expiresAt`: wenn gesetzt und Ablauf aktiviert, gegen die Uhr prüfen (SEC-05).
9. `config` gegen das Schema prüfen (unbekannte Felder → Ablehnung), dann mit der lokalen Policy
   schneiden (SEC-11, SEC-14).
10. Atomar speichern: Envelope-Bytes und neue Version, dann aktivieren.

## 5. Versiegelte Secrets

Ziel: Nur das Gate kann entschlüsseln, und ein Ciphertext ist an Gate, Secret-Name und
Secret-Version gebunden (SEC-31, SEC-33).

**Versiegeln** (Client: Desktop, CLI, Browser):

1. Ephemeres X25519-Paar `(esk, epk) = crypto_box_keypair()`.
2. `ss = crypto_scalarmult(esk, gatePk)`; Ergebnis aus nur Nullbytes → Abbruch.
3. `key = crypto_generichash(32, "moat:secret:v1" ‖ epk ‖ gatePk, key = ss)` (BLAKE2b mit Schlüssel).
4. `nonce` = 24 Zufallsbytes.
5. `ad = "moat:secret:v1|" ‖ gateId ‖ "|" ‖ secretName ‖ "|" ‖ secretVersion`.
6. `ct = crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, nonce, key)`.
7. `esk`, `ss`, `key` und den Klartext mit `memzero` löschen.

```json
{
  "v": 1,
  "alg": "x25519-blake2b-xchacha20poly1305",
  "secretVersion": 3,
  "epk": "…",
  "nonce": "…",
  "ct": "…"
}
```

**Öffnen** (nur im Gate): dieselben Schritte mit `crypto_scalarmult(gateSk, epk)`; AD aus der
**eigenen** Gate-ID und dem Namen, unter dem das Secret im Bundle steht. Entschlüsselt wird erst
im Request, der das Secret braucht; der Klartext wird nie gespeichert und nach dem Upstream-Call
gelöscht. `secretVersion` erlaubt zwei aktive Versionen bei der Rotation (SEC-36).

**Local-only Secrets** (SEC-38): dasselbe Format, aber auf dem Server mit der CLI oder dem
Installer versiegelt und nur in eine lokale Datei geschrieben, nie in ein Bundle.

## 6. Key-Datei (Vertrauensmodus 1)

Datei mit Endung `.moatkey`:

```json
{
  "moat": "keyfile",
  "v": 1,
  "alg": "ed25519",
  "kid": "…",
  "pk": "…",
  "kdf": { "alg": "argon2id13", "ops": 3, "mem": 268435456, "salt": "…" },
  "nonce": "…",
  "ct": "…"
}
```

- `kek = crypto_pwhash(32, passphrase, salt, ops, mem, ALG_ARGON2ID13)`.
- `ct` = XChaCha20-Poly1305 des 32-Byte-Seeds mit `ad = "moat:keyfile:v1|" ‖ kid`.
- Untergrenzen beim Erzeugen: `ops ≥ 3`, `mem ≥ 256 MiB` (Desktop, CLI). Im Browser darf
  `mem` auf **64 MiB** sinken (WebAssembly-Speicher); die Datei speichert die Werte, beim
  nächsten Speichern in Desktop/CLI wird hochgestuft.
- Beim Öffnen werden Werte unter `ops 2` / `mem 64 MiB` abgelehnt (Schutz gegen eine
  manipulierte Datei mit trivialen Parametern).
- Nach dem Entschlüsseln wird geprüft, dass der Seed den Schlüssel `pk` ergibt und `kid` stimmt.
- Desktop speichert die Key-Datei wahlweise im OS-Keychain (`safeStorage`) statt mit Passphrase.

## 7. Passkeys (Vertrauensmodus 2)

Passkeys signieren nicht das Bundle direkt, sondern das WebAuthn-Format, und fast immer mit
**ES256 (ECDSA P-256)**. **Entschieden (12.10.2026): Variante A.** Variante B bleibt als verworfene Alternative dokumentiert.

**Variante A: Gate prüft die WebAuthn-Signatur (gewählt).**
Der Schlüssel verlässt den Authenticator nie, wie in den Anforderungen versprochen.

#### 7.1 Gepinnter Signer (`trust.json`, Modus 2)

```json
{
  "kid": "…",
  "alg": "webauthn-es256",
  "pk": "<base64url des 65-Byte-Punkts 0x04 ‖ X ‖ Y, 87 Zeichen>",
  "rpId": "moat.example.org",
  "origins": ["app://moat", "https://moat.example.org"]
}
```

- **Genau** diese fünf Schlüssel. `kid` ist die Schlüssel-ID nach Abschnitt 3 mit
  `alg = "webauthn-es256"` und dem 65-Byte-Punkt; ein abweichender Wert macht die Trust-Datei
  ungültig. `pk` muss 65 Bytes mit erstem Byte `0x04` sein (komprimierte Punkte sind verboten).
  Dass der Punkt auf der Kurve liegt, prüft die Signaturprüfung (ein Punkt abseits der Kurve
  verifiziert nie); `trust --passkey` prüft es zusätzlich beim Pinnen.
- `rpId`: ein DNS-Name in Kleinbuchstaben, 1 bis 253 Zeichen, Labels `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`
  getrennt durch `.`, kein Punkt am Ende, keine IP-Adresse (nur Ziffern und Punkte) und kein
  Nicht-ASCII (Punycode statt Unicode).
- `origins`: 1 bis 8 Einträge, jeder ein **exakter** Origin-String, der Byte für Byte mit dem
  `origin` des `clientDataJSON` verglichen wird (kein Normalisieren, kein Gross/Klein, kein
  Schrägstrich am Ende). Erlaubt sind nur zwei Formen, höchstens 300 Bytes:
  - `https://<dns-name>` oder `https://<dns-name>:<port>` mit dem DNS-Namen wie bei `rpId`,
    Port `1`–`65535` ohne führende Null und **nicht** `443` (der Standardport wird nie
    geschrieben);
  - `app://<name>` mit `<name>` nach `^[a-z][a-z0-9-]{0,62}$` (so nennt sich der Origin der
    Desktop-App, z. B. `app://moat`).
    Doppelte Origins sind ungültig.
  - **Moat Desktop** (gemessen mit Electron 42): Chromium lässt WebAuthn auf `app://…` nicht zu
    (`SecurityError`, nur HTTPS-Origins oder `localhost`). Der Desktop führt die Zeremonie
    deshalb in einem eigenen Fenster auf `https://passkey.moat.invalid` aus, das der Hauptprozess
    selbst beantwortet (T-77). Dazu gehört `--rp-id=passkey.moat.invalid
--origin=https://passkey.moat.invalid`. `app://moat` bleibt gültige Grammatik für andere
    Clients, der Desktop benutzt ihn nicht.
- Modus 2 kennt **nur** `webauthn-es256`-Signer, Modus 0 und 1 **nur** `ed25519`-Signer: Der
  Modus sagt, welcher Algorithmus gilt, gemischt wird nie. Ein Signer mit dem falschen `alg`
  oder mit den Schlüsseln der anderen Form macht die ganze Trust-Datei ungültig
  (`trust_invalid`, das Gate bleibt unkonfiguriert und liefert nichts aus). Ein Moduswechsel ist
  eine neue Trust-Datei auf dem Server (SEC-06, Abschnitt 8).
- Höchstens 16 Signer, `threshold` 1 bis Anzahl Signer, keine doppelte `kid`.

#### 7.2 Signatur-Eintrag im Envelope

Beim Signieren: `M` aus 4.2, `challenge = SHA-256(M)` (32 Bytes), `rpId` des gepinnten Signers,
`userVerification: "required"`. Der Eintrag:

```json
{
  "kid": "…",
  "alg": "webauthn-es256",
  "sig": "<base64url der DER-ECDSA-Signatur>",
  "authenticatorData": "<base64url>",
  "clientDataJSON": "<base64url>"
}
```

Genau diese fünf Schlüssel, alle Werte base64url ohne Padding (Abschnitt 2). Grössen nach dem
Dekodieren: `authenticatorData` 37 bis 1024 Bytes, `clientDataJSON` 1 bis 2048 Bytes, `sig`
höchstens 80 Bytes. Eine Verletzung ist `signature_invalid` (der Eintrag gehört zu einer
gepinnten `kid`).

#### 7.3 Prüfreihenfolge eines solchen Eintrags (Schritt 4 aus 4.3)

Jeder Fehler verwirft das ganze Bundle mit `signature_invalid`; die Reihenfolge ist verbindlich:

1. `kid` ist unter den gepinnten Schlüsseln, und `alg` des Eintrags ist gleich `alg` des gepinnten
   Signers (ein Ed25519-Eintrag gegen einen Passkey-Signer und umgekehrt wird hier verworfen).
2. `sig`, `authenticatorData` und `clientDataJSON` strikt base64url-dekodieren, Grössen nach 7.2.
3. `clientDataJSON` ist als strenges JSON (Abschnitt 2) ein Objekt. Es hat meist mehr Schlüssel,
   als das Gate liest (`crossOrigin`, `topOrigin`, vom Browser angehängte Felder): **nur hier**
   sind zusätzliche Schlüssel erlaubt, sie werden ignoriert. Es gilt:
   - `type` ist genau der String `"webauthn.get"`;
   - `challenge` ist genau `base64url(SHA-256(M))` ohne Padding (43 Zeichen), mit `M` aus den
     tatsächlich empfangenen Payload-Bytes (nie neu serialisiert);
   - `origin` ist Byte für Byte gleich einem der gepinnten `origins`;
   - `crossOrigin` fehlt oder ist genau `false`.
4. `authenticatorData`: die ersten 32 Bytes (`rpIdHash`) sind gleich `SHA-256(rpId)` des gepinnten
   Signers (konstante Zeit), Byte 32 (Flags) hat UP (`0x01`) **und** UV (`0x04`) gesetzt. Die
   übrigen Flags (BE, BS, AT, ED) und alles nach Byte 37 (Zähler, Erweiterungen) wird nicht
   ausgewertet; die Signatur deckt es ab.
5. `sig` ist eine **strenge DER**-Kodierung `SEQUENCE { INTEGER r, INTEGER s }`: Tag `0x30` mit
   Längenbyte in Kurzform (< 128) und genau der Restlänge, zwei `INTEGER` (`0x02`) mit Länge
   1 bis 33 in Kurzform, positiv (oberstes Bit des ersten Bytes frei), minimal (kein führendes
   `0x00`, ausser das nächste Byte hat das oberste Bit gesetzt), keine Bytes danach, und
   `1 ≤ r, s ≤ n − 1` mit der Gruppenordnung `n` von P-256. Fehlerhaftes DER wird abgelehnt,
   **bevor** eine Bibliothek die Signatur sieht (alle Implementierungen akzeptieren dieselben
   Kodierungen). **Low-S wird nicht verlangt**: Authenticators liefern beide Formen.
6. ECDSA P-256 mit SHA-256 über `authenticatorData ‖ SHA-256(clientDataJSON)` mit dem
   gepinnten Punkt (PHP: `openssl_verify(…, OPENSSL_ALGO_SHA256)`, TypeScript: Web Crypto
   `ECDSA`/`P-256`/`SHA-256` mit der Signatur als `r ‖ s`, je 32 Bytes). Kein weiterer Gebrauch
   von OpenSSL bzw. Web Crypto. Web Crypto ist Teil der Plattform, keine Bibliothek.

Der Signatur-Zähler (`signCount`) wird **nicht** ausgewertet: Das Gate führt keinen Zustand pro
Authenticator (synchronisierte Passkeys liefern ohnehin 0), und Wiedereinspielen verhindern die
streng steigenden Bundle-Versionen (SEC-04) und die Bindung an die Gate-ID (SEC-07), nicht der
Zähler. Ein abgefangener Eintrag taugt nur für genau diese Payload-Bytes, also nur für dasselbe
Bundle.

#### 7.4 `ext-openssl`

Das Gate braucht `ext-openssl`, **nur** wenn Modus 2 gepinnt ist. Es prüft das beim Start (nach
dem Lesen der Trust-Datei) und verweigert sonst den Dienst mit dem Fehler `gate_not_configured`
und dem Logcode `extension_missing`; `php moat-gate.php status` und `check` melden die fehlende
Erweiterung deutlich, und `trust --passkey` pinnt nichts ohne sie. Fehlt sie trotzdem
(Prüfung umgangen), schlägt die Prüfung nach 7.3 Schritt 6 fehl (`signature_invalid`), nie
„durchgewunken“. Auf Shared Hosting ist `ext-openssl` praktisch überall vorhanden. Die
Modi 0 und 1 brauchen sie nicht.

**Variante B (verworfen): Passkey entsperrt eine Ed25519-Key-Datei (PRF-Erweiterung).**
Der Passkey liefert über die WebAuthn-PRF-Erweiterung ein Geheimnis, das die Key-Datei aus
Abschnitt 6 statt einer Passphrase entschlüsselt. Das Gate bleibt bei reinem Ed25519.

- Vorteil: kein `ext-openssl`, ein Signaturformat weniger.
- Nachteil: Der Ed25519-Schlüssel liegt beim Signieren kurz im Speicher des Clients. Das ist
  Schutz vor Diebstahl der Datei, aber nicht „Schlüssel verlässt das Gerät nie“. Nicht jeder
  Passkey-Anbieter unterstützt PRF.

In beiden Varianten gilt T-25: Im Browser signiert der Passkey, was das ausgelieferte JS ihm gibt.

## 8. Vertrauensanker und Enrollment

**Gepinnte Daten im Gate** (lokale Datei `trust.json`, nie über die Cloud änderbar, SEC-06,
SEC-13):

```json
{
  "v": 1,
  "gateId": "…",
  "mode": 1,
  "threshold": 1,
  "signers": [{ "kid": "…", "alg": "ed25519", "pk": "…" }],
  "cloud": { "url": "https://…", "kid": "…", "pk": "…" }
}
```

In Modus 0 und 1 sind alle `signers` Ed25519-Einträge `{ "kid", "alg": "ed25519", "pk" }`. In
**Modus 2** (Passkeys) sind alle `signers` Einträge der Form aus 7.1; der Rest der Datei ist
gleich:

```json
{
  "v": 1,
  "gateId": "…",
  "mode": 2,
  "threshold": 1,
  "signers": [
    {
      "kid": "…",
      "alg": "webauthn-es256",
      "pk": "…",
      "rpId": "moat.example.org",
      "origins": ["app://moat"]
    }
  ],
  "cloud": null
}
```

Modus und Algorithmus gehören zusammen (7.1); eine Datei, die sie mischt, ist ungültig. Ein
Wechsel zwischen Modus 1 und 2 ersetzt die Datei lokal (`trust`), und weil kein Signer des alten
Modus im neuen gilt, liefert das Gate bis zum ersten Bundle des neuen Modus nichts aus: Das
Gate-CLI verlangt dafür `--force`.

**Ablauf** (SEC-28, SEC-32):

1. Der Installer erzeugt Gate-ID, Box- und Auth-Schlüssel und ein **Setup-Token** (32 Zufallsbytes),
   schreibt alles lokal und zeigt das Token einmal an (bzw. legt es in die lokale Installationsdatei).
2. Der Setup-Modus antwortet nur auf `?moat-setup` mit korrektem Token (Vergleich in konstanter
   Zeit) und zeigt: Gate-ID, Fingerprint des Box-Schlüssels, Fingerprint des Auth-Schlüssels und
   die Fingerprints der gepinnten Signer aus `trust.json`.
3. Der Admin vergleicht in Cloud/Desktop **alle** Fingerprints. Erst dann pinnt die Gegenseite den
   Box-Schlüssel des Gates (sonst kann eine kompromittierte Cloud einen eigenen Schlüssel
   unterschieben).
4. Der Setup-Modus schaltet sich dauerhaft ab, sobald das erste Bundle akzeptiert ist, spätestens
   nach 30 Minuten, und lässt sich nur lokal wieder aktivieren (Datei).
5. Wechsel von Modus oder Signern: nur durch Austausch von `trust.json` auf dem Server.

Für Downloads aus der Cloud gilt T-22: Wer `trust.json` aus der Cloud bezieht, vergleicht die
Signer-Fingerprints im Setup-Modus mit der eigenen Key-Datei bzw. dem eigenen Passkey.

## 9. Gate-Anmeldung bei der Cloud (SEC-55)

Jeder Request des Gates an die Cloud trägt:

```
Moat-Gate: kid=<auth-kid>, ts=<unix>, sig=<base64url>
```

- `sig = crypto_sign_detached("moat:gate-req:v1\n" ‖ method ‖ "\n" ‖ path ‖ "\n" ‖ ts ‖ "\n" ‖
base64url(SHA-256(body)), authSk)`.
- Die Cloud akzeptiert `ts` nur ±300 Sekunden und jede Kombination aus `kid` und `sig` nur einmal
  innerhalb dieses Fensters.
- TLS bleibt Pflicht (SEC-48), die Sicherheit hängt aber nicht daran.

## 10. Releases (SEC-60, SEC-65, SEC-66)

- Jede Gate-Version hat ein Manifest (JCS): `{ "type": "moat.release", "v": 1, "version":
"1.4.2", "files": { "moat-gate.php": "<sha256 hex>" }, "minUpgradeFrom": "1.0.0" }`.
- Signiert mit `"moat:release:v1\n" ‖ manifestBytes`, Schwelle **2 von 3** Release-Schlüsseln,
  deren öffentliche Schlüssel fest im Gate eingebaut sind.
- Auto-Update (nur wenn eingeschaltet) prüft Manifest und Hash, lehnt niedrigere Versionen ab und
  ersetzt die Datei atomar.
- Manifest und Signaturen werden zusätzlich als GitHub-Release-Assets veröffentlicht (unabhängige
  Quelle, SEC-65).

## 11. Testvektoren

`conformance/vectors/crypto/` enthält feste Schlüssel (mit „TEST ONLY“ gekennzeichnet) und erwartete
Ausgaben für:

- base64url (gültig und alle Ablehnungsfälle), JCS-Beispiele inklusive Unicode und Ganzzahlgrenzen
- `kid` und Fingerprint
- Bundle: gültig; manipulierte Payload; falsche Domäne; falsche `kid`; zu wenige Signaturen bei
  M-of-N; doppelte `kid`; fremde Gate-ID; gleiche und niedrigere Version; abgelaufen; Envelope mit
  zusätzlichem Feld; Payload mit Fliesskommazahl
- Secrets: Öffnen erfolgreich; falsche Gate-ID, falscher Name, falsche Secret-Version in der AD;
  manipulierter Ciphertext; Null-`epk`
- Key-Datei: korrekte Passphrase; falsche Passphrase; zu schwache KDF-Parameter; `kid` passt
  nicht zum Seed
- WebAuthn (`webauthn.json`, Prüfreihenfolge 7.3, alle Schlüssel TEST ONLY, Signaturen
  deterministisch nach RFC 6979): gültig (ein Signer; 2 von 2 Passkeys; High-S; Erweiterungs-Bytes
  und BE/BS-Flags; mehrere Origins); falsche Challenge (auch ohne Domänen-Präfix, Padding, anderes
  Bundle); falscher `type`; Origin nicht gepinnt (auch mit Schrägstrich); `crossOrigin` `true`
  oder String; falscher `rpIdHash`; UP oder UV fehlt; fehlerhaftes DER (Rest-Bytes, Langform,
  nicht minimal, negativ, `r = 0`, abgeschnitten); Signatur über andere Daten oder von anderem
  Schlüssel; `kid` nicht gepinnt; `alg` passt nicht (Ed25519-Eintrag gegen Passkey-Signer und
  umgekehrt); fehlende oder zusätzliche Schlüssel im Eintrag; Grössen an und über den Grenzen
  (`authenticatorData`, `clientDataJSON`, `sig`)
- Trust-Datei (`trust.json`): gültig in Modus 0, 1, 2; Modus 2 mit Ed25519-Signer; Modus 1 mit
  Passkey-Signer; gemischte Algorithmen; ungültige `rpId` und `origins` (Grossbuchstaben, Pfad,
  `http`, Port 443, zu lang, zu viele, doppelt); `pk` mit falscher Länge oder Präfix; falsche
  `kid`; doppelte `kid`; falsche Schwelle
- Gate-Auth: gültig; `ts` ausserhalb des Fensters; Wiederholung
- Release-Manifest: 2 von 3 gültig; 1 von 3; falscher Hash; Downgrade

Nicht-deterministische Schritte (Nonces, ephemere Schlüssel) sind in den Vektoren fixiert;
die Implementierungen bieten dafür eine nur in Tests erreichbare Injektion.

## 12. Entscheide

1. **Passkeys:** Variante A, das Gate prüft WebAuthn/ES256 und braucht `ext-openssl`, wenn Modus 2 gepinnt ist (12.10.2026).
2. **Passkey-Format** (Modus 2, vom Projektinhaber freigegeben): `trust.json`-Signer und
   Envelope-Eintrag wie in 7.1 und 7.2, Prüfreihenfolge 7.3, `alg` überall `webauthn-es256`,
   Signatur-Zähler nicht ausgewertet, Low-S nicht verlangt.
