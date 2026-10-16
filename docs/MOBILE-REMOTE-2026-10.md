# Mindeck: Files und Browser für gekoppelte Geräte (2026-10)

**Stand:** 2026-10-16 · **Branch:** `feature/mobile-remote` (Basis `develop`, `e5cadb9`)
**Gegenstück:** `mindeck-mobile`, Branch `feature/mobile-parity` (Files- und Browser-Modul der App)

Bis hierher waren Files (`finder:*`) und Browser (`browser:*`) reine Desktop-Kanäle. Die Mobile-App
soll aber alles können, was der Desktop kann. Diese Änderung öffnet beides für gekoppelte Geräte —
**jeweils hinter einem Schalter, den nur der Desktop setzen kann**, und mit eigenen Grenzen. Das
weitet die Angriffsfläche, deshalb hier ausdrücklich zur Entscheidung.

---

## 1. Was sich ändert

| Bereich | Vorher | Jetzt |
|---|---|---|
| Files: Ordner, Vorschau, Suche, Info, Größe, neuer Ordner, Umbenennen, Papierkorb (+ Rückgängig), Kopieren/Verschieben (mit Konflikten, Fortschritt, Abbruch), ZIP | `desktop` | `terminal`: nur mit **Remote-Shells** |
| `finder:read` / `finder:write` (neu): eine Datei in Stücken ≤ 4 MB holen bzw. ablegen | — | `terminal` |
| Files: Öffnen mit Host-App, Im Finder zeigen, System-Zwischenablage, Datenschutz-Einstellungen | `desktop` | unverändert `desktop` |
| Browser: Tabs sehen, öffnen, schließen, wechseln, navigieren, zurück/vor, Zoom, Vorschläge, Verlauf, Lesezeichen lesen und anlegen | `desktop` | `browser` (neu): nur wenn der Desktop **„Browser mit gekoppelten Geräten teilen“** einschaltet (Standard: aus) |
| `browser:capture` (neu): Bild eines Tabs (JPEG) + Seitengröße · `browser:input` (neu): Tippen, Scrollen, Text, Tasten per DevTools-Protokoll | — | `browser` |
| Alle anderen Browser-Kanäle (Extensions, Downloads, Berechtigungen, Logins, Import, Verlauf löschen, Gruppen, Split, eigene UI) | `desktop` | unverändert `desktop` |
| Push: `finder:progress` | nie an Geräte | nur mit Remote-Shells |
| Push: `browser:state`, `browser:bookmarks` | nie an Geräte | nur mit geteiltem Browser, private Tabs entfernt |

Neue Zugriffsstufe im Vertrag: `ChannelAccess = … | 'browser'`. Der Router prüft sie wie `terminal`
(`remote-browser-disabled`). Der Schalter ist `ServerConfig.remoteBrowser` und nur über
`server:configure` setzbar — ein `desktop`-Kanal. Ein Gerät kann ihn also nie selbst einschalten.

## 2. Begründung

**Files mit Remote-Shells.** Ein Gerät mit Remote-Shells kann ohnehin jede Datei lesen und schreiben,
die der Nutzer lesen und schreiben darf (`cat`, `cp`, …). `finder:*` ist für dieses Gerät keine neue
Fähigkeit, sondern eine bedienbare. Trotzdem gelten strengere Regeln als in der Shell (§3.1), damit
ein gestohlenes Token über die API nicht bequemer an Schlüssel kommt als über eine Shell, die man im
Prozessbaum sieht.

**Browser nur als Opt-in.** Die Tabs tragen die Logins des Nutzers (Bank, Mail, GitHub). Ein Gerät mit
Bild und Eingabe kann in diesen Sitzungen handeln. Das ist der eigentliche Mehrwert („vom Handy die
Dev-Seite auf dem Rechner prüfen, eine Freigabe im Admin-UI klicken“), aber nicht als Standard. Daher:
eigener Schalter, nur am Desktop, aus per Standard, deutlicher Hinweistext.

## 3. Grenzen

### 3.1 Files (`RemoteAccess.finder` / `reachable`)

Jeder Pfad einer Files-Anfrage (`path`, `paths`, `parent`, `dest`, `items[].path`, `moves[].from/to`)
muss — **so wie geschrieben und so wie er wirklich ist** (Links aufgelöst; für neue Namen der Ordner) —

- im Home-Ordner oder auf einem Laufwerk liegen (`/Volumes`; Linux `/media/<user>`, `/run/media/<user>`, `/mnt`),
- außerhalb von Systemordnern liegen (auch `~/Library`, `~/AppData`),
- außerhalb von Mindecks Datenordner liegen,
- keinen versteckten Ordner enthalten (relativ zur Wurzel: `~/.ssh`, `~/.config`, …),
- keinen Namen der Deny-Liste enthalten (Schlüssel, Credentials, Browser-Profile; wie bisher).

Zusätzlich:

- `finder:list` mit `hidden: true` wird abgelehnt; Listen und Suchergebnisse an Geräte lassen versteckte
  Einträge und Deny-Namen weg (`RemoteScope.result`).
- `finder:untrash` holt nur aus dem Papierkorb (`~/.Trash`, `~/.local/share/Trash`; Windows: keiner).
  Sonst könnte ein Gerät `~/.ssh/id_rsa` als „Papierkorb-Eintrag“ nach `~/Desktop` „zurücklegen“ und
  danach lesen.
- Schreiben bleibt wie am Desktop auf Home und Laufwerke beschränkt (`FinderService.assertWritable`),
  Löschen geht immer in den Papierkorb, `finder:write` überschreibt nur mit `replace: true` (die alte
  Datei in den Papierkorb) und hängt Folgestücke nur exakt am Dateiende an (`bad-offset` sonst).

### 3.2 Browser (`RemoteScope`, `BrowserService.remoteTarget`)

- Private Tabs verlassen den Desktop nie: Sie fehlen in jeder Antwort und jedem Push (samt ihrer
  Gruppen, Splits, Downloads, Berechtigungs- und Login-Fragen); jede Anfrage mit der ID eines privaten
  Tabs und `browser:open { private: true }` antworten `remote-forbidden`; `capture`/`input` prüfen es
  im Dienst noch einmal.
- Kein Zugriff auf DevTools, Extensions, gespeicherte Logins, Downloads-Ordner, Verlauf löschen oder
  Import.
- `capture` liefert nur den sichtbaren Ausschnitt (JPEG, ≤ 1920 px breit), `input` nur Maus, Rad,
  Text und eine feste Tastenliste — keine Tastenkürzel mit Modifikatoren.

## 4. Rest-Risiken

| # | Risiko | Einschätzung |
|---|---|---|
| R1 | Ein gestohlenes Geräte-Token mit Remote-Shells liest über Files alle normalen Dateien im Home-Ordner. | Wie bisher über die Shell; ohne Remote-Shells unverändert gesperrt. Gegenmittel: Geräte in Settings entziehen, Remote-Shells nur bei Bedarf. |
| R2 | Mit geteiltem Browser handelt ein Gerät in eingeloggten Sitzungen. | Gewollt und opt-in. Empfehlung für später: pro Gerät freischalten statt global, und Admin-Rolle verlangen. |
| R3 | `browser:capture` zeigt sensible Seiten (Mail, Bank) des Desktops. | Nur mit Opt-in; private Tabs bleiben unsichtbar. Hinweistext im Schalter sagt es. |
| R4 | `finder:read` holt große Dateien in 4-MB-Stücken (Last auf dem Core). | Bodies ≤ 8 MB wie alle Anfragen; der Core liest pro Stück nur den Ausschnitt. |

## 5. Prüfungen

- Neue Tests: `remote-files.test.ts` (Wurzeln, Links, Systemordner, Datenordner, versteckt, Deny-Liste,
  Papierkorb, Plattformen), `browser-remote.test.ts` (Bild, Seitengröße, Laden nicht geladener Tabs,
  Maus/Rad/Text/Tasten, private Tabs, kein Host), Ergänzungen in `remote-scope.test.ts` (private Tabs in
  Antworten und Pushes, Vorschläge, Dateilisten), `server.test.ts` (Push nur mit geteiltem Browser,
  Schalter wirkt sofort), `browser-ipc.test.ts` (Zugriffsstufen, Schemas), `finder-ops.test.ts`
  (`read`/`write`), `browser-host.test.ts` (`preview`), `createCore.test.ts`, `settings.test.tsx` (Schalter).
- Lokal unter macOS bleiben die bekannten `/var` ↔ `/private/var`-Fehlschläge in `remote-access.test.ts`
  und `createCore.test.ts` (vorbestehend, auf `develop` identisch); CI unter Linux ist maßgeblich.
