## Dateien / Files

| Datei / File               | Wofür / What for                                                                  |
| -------------------------- | --------------------------------------------------------------------------------- |
| `moat-gate.php`            | Das Gate für dein Hosting (PHP ≥ 8.2) / the gate for your hosting (PHP ≥ 8.2)     |
| `moat.cjs`                 | Das Moat CLI (Node 22): `node moat.cjs version` / the Moat CLI (Node 22)          |
| `Moat-Setup-<Version>.exe` | Moat Desktop für Windows / for Windows                                            |
| `Moat-<Version>-arm64.dmg` | Moat Desktop für Mac mit Apple-Chip / for Apple silicon                           |
| `Moat-<Version>-x64.dmg`   | Moat Desktop für Mac mit Intel-Chip / for Intel Macs                              |
| `Moat-<Version>.AppImage`  | Moat Desktop für Linux / for Linux                                                |
| `SHA256SUMS.txt`           | Prüfsummen aller Dateien / checksums of every file: `sha256sum -c SHA256SUMS.txt` |

**Deutsch.** Vergleiche die Prüfsumme von `moat-gate.php` mit `SHA256SUMS.txt`, bevor du die
Datei hochlädst; sie steht auch in der Kopfzeile der Datei. Die Dateien sind noch **nicht
signiert**: Windows und macOS warnen beim ersten Start von Moat Desktop.

- **Windows (SmartScreen):** «Der Computer wurde durch Windows geschützt» → **Weitere
  Informationen** → **Trotzdem ausführen**.
- **macOS (Gatekeeper):** Die App aus dem DMG in «Programme» ziehen, dann mit der rechten
  Maustaste auf die App → **Öffnen** → im Dialog nochmals **Öffnen**.
- **Linux:** `chmod +x Moat-<Version>.AppImage`, dann starten.

**English.** Compare the checksum of `moat-gate.php` with `SHA256SUMS.txt` before you upload it;
it is also in the file's header. The files are **not signed** yet: Windows and macOS warn on the
first start of Moat Desktop.

- **Windows (SmartScreen):** "Windows protected your PC" → **More info** → **Run anyway**.
- **macOS (Gatekeeper):** drag the app from the DMG into Applications, then right-click it →
  **Open** → **Open** again in the dialog.
- **Linux:** `chmod +x Moat-<version>.AppImage`, then run it.
