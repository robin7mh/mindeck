# Mindeck: Files und Browser für gekoppelte Geräte (2026-10)

**Stand:** 2026-10-16 · **Branch:** `feature/mobile-remote` (Basis `develop`, `e5cadb9`)
**Gegenstück:** `mindeck-mobile`, Branch `feature/mobile-parity` (Files- und Browser-Modul der App)

> **Update 2026-10-25:** Der Browser-Teil ist wieder entfernt (Robins Entscheidung). Die Mobile-App
> hat jetzt einen eigenen Browser auf dem Handy; kein gekoppeltes Gerät sieht oder bedient mehr den
> Browser des Desktops, alle `browser:*`-Kanäle sind wieder *desktop only*, `browser:capture`,
> `browser:input` und `server:setDeviceBrowser` gibt es nicht mehr. Was unten zum Browser steht, ist
> Geschichte; **Files für Geräte mit Remote-Shells bleiben** wie beschrieben.

Bis hierher waren Files (`finder:*`) und Browser (`browser:*`) reine Desktop-Kanäle. Die Mobile-App
soll aber alles können, was der Desktop kann. Diese Änderung öffnet beides für gekoppelte Geräte —
**Files nur mit Remote-Shells, den Browser nur pro Admin-Gerät und nur, wenn der Desktop ihn diesem
Gerät freigibt**, jeweils mit eigenen Grenzen. Das weitet die Angriffsfläche, deshalb hier
ausdrücklich zur Entscheidung.

---

## 0. Was ein Gerät damit neu kann — im Klartext

**Ein Gerät mit Remote-Shells** (Member oder Admin, Schalter „Remote-Shells erlauben“) kann jetzt
zusätzlich über die Files-Oberfläche:

- normale Dateien im Home-Ordner und auf Laufwerken ansehen, suchen, herunterladen und hochladen,
- Ordner anlegen, umbenennen, verschieben, kopieren, packen und entpacken, in den Papierkorb legen
  und von dort zurückholen.

Das konnte es über die Shell schon vorher. Die Files-Oberfläche ist strenger als die Shell (§3.1)
und jede Änderung steht im Aktivitätslog des Desktops.

**Ein Admin-Gerät, dem der Desktop den Browser freigegeben hat** (Globus neben dem Gerät, Standard:
aus), kann jetzt:

- die offenen Tabs des Desktops sehen, als Liste und als Bild,
- in ihnen tippen, scrollen, schreiben und Tasten drücken — **mit den Logins des Nutzers**: Es
  handelt in Mail, GitHub, Admin-Oberflächen und so weiter so, wie der Nutzer am Desktop,
- Webseiten öffnen und Tabs schließen, vor und zurück gehen, zoomen, Verlauf und Lesezeichen lesen
  und Lesezeichen anlegen.

Nicht möglich bleibt: private Tabs, Passwörter, Einmalcodes oder Kartennummern eintippen, Dateien,
Mindeck-Seiten oder fremde Apps per URL öffnen, Downloads, Berechtigungen, Logins, Extensions,
DevTools, der Import und das Löschen des Verlaufs, Tabs auf dem Desktop-Bildschirm umschalten und die
Freigabe selbst einschalten.

## 1. Was sich ändert

| Bereich | Vorher | Jetzt |
|---|---|---|
| Files: Ordner, Vorschau, Suche, Info, Größe, neuer Ordner, Umbenennen, Papierkorb (+ Rückgängig), Kopieren/Verschieben (mit Konflikten, Fortschritt, Abbruch), ZIP | `desktop` | `terminal`: nur mit **Remote-Shells** |
| `finder:read` / `finder:write` (neu): eine Datei in Stücken ≤ 4 MB holen bzw. ablegen | — | `terminal` |
| Files: Öffnen mit Host-App, Im Finder zeigen, System-Zwischenablage, Datenschutz-Einstellungen | `desktop` | unverändert `desktop` |
| Browser: Tabs sehen, öffnen, schließen, navigieren, zurück/vor, Zoom, Vorschläge, Verlauf, Lesezeichen lesen und anlegen | `desktop` | `browser` (neu): nur **Admin-Geräte mit Freigabe** (`Device.browser`) |
| `browser:capture` (neu): Bild eines Tabs (JPEG) + Seitengröße · `browser:input` (neu): Tippen, Scrollen, Text, Tasten per DevTools-Protokoll | — | `browser` |
| `server:setDeviceBrowser { id, browser }` (neu): Freigabe pro Gerät | — | `desktop` |
| `browser:activate` und alle anderen Browser-Kanäle (Extensions, Downloads, Berechtigungen, Logins, Import, Verlauf löschen, Gruppen, Split, eigene UI) | `desktop` | unverändert `desktop` |
| Push: `finder:progress` | nie an Geräte | nur mit Remote-Shells |
| Push: `browser:state`, `browser:bookmarks` | nie an Geräte | nur an Admin-Geräte mit Freigabe, bei jedem Push neu geprüft; private Tabs und die Desktop-Teile (§3.2) entfernt |
| Aktivitätslog: `device.browser`, `device.files` (neu, `audit`) | — | was ein Gerät getan hat; nur am Desktop sichtbar |

Neue Zugriffsstufe im Vertrag: `ChannelAccess = … | 'browser'`. Der Router lässt einen `browser`-Kanal
nur durch, wenn das Gerät `role: 'admin'` hat **und** `browser: true` (`remote-browser-disabled`
sonst). Beides steht am Gerät in `devices.json`; `HttpServer` liest es bei jeder Anfrage und jedem
Browser-Push neu. Die Freigabe setzt nur `server:setDeviceBrowser`, ein `desktop`-Kanal. Ein Gerät
kann sie also nie selbst setzen. `AuthService.setBrowser` lehnt Member ab (`admin-only`), und
`setRole(…, 'member')` löscht die Freigabe. Ausschalten wirkt sofort: Die nächste Anfrage und der
nächste Push des Geräts scheitern.

Ein Snapshot-Test (`tests/unit/main/channel-access.test.ts`) hält fest, welche Kanäle Geräte erreichen,
nach Stufe. Jede künftige Erweiterung zeigt sich als Diff im Review.

## 2. Begründung

**Files mit Remote-Shells.** Ein Gerät mit Remote-Shells kann ohnehin jede Datei lesen und schreiben,
die der Nutzer lesen und schreiben darf (`cat`, `cp`, …). `finder:*` ist für dieses Gerät keine neue
Fähigkeit, sondern eine bedienbare. Trotzdem gelten strengere Regeln als in der Shell (§3.1), damit
ein gestohlenes Token über die API nicht bequemer an Schlüssel kommt als über eine Shell, die man im
Prozessbaum sieht.

**Browser nur pro Admin-Gerät.** Die Tabs tragen die Logins des Nutzers (Bank, Mail, GitHub). Ein
Gerät mit Bild und Eingabe kann in diesen Sitzungen handeln. Das ist der eigentliche Mehrwert („vom
Handy die Dev-Seite auf dem Rechner prüfen, eine Freigabe im Admin-UI klicken“), aber nicht als
Standard und nicht für alle Geräte zugleich. Daher: Freigabe pro Gerät, nur für Admins, nur am
Desktop, aus per Standard. Der Desktop zeigt sichtbar an, wer den Browser gerade nutzt, mit einem
Knopf zum Beenden.

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

### 3.2 Browser (`Router`, `RemoteScope`, `BrowserService`)

- **Wer:** nur Admin-Geräte mit `browser: true` (Router für Anfragen, `HttpServer.pushBrowser` für
  Pushes; beides fragt bei jedem Mal `devices.json`).
- **Private Tabs verlassen den Desktop nie:** Sie fehlen in jeder Antwort und jedem Push (samt ihrer
  Gruppen und Splits); jede Anfrage mit der ID eines privaten Tabs und `browser:open { private: true }`
  antworten `remote-forbidden`; `capture` und `input` prüfen es im Dienst noch einmal.
- **Nur Webseiten:** `browser:open`, `browser:navigate` und `browser:bookmarkAdd` nehmen nur, was zu
  `http(s)` führt. Die Eingabe wird dazu aufgelöst wie in der Adresszeile (`BrowserService.webUrl`):
  Suchbegriffe ergeben die Suchmaschine. `file:`, Pfade, `mindeck://…`, `javascript:`, `mailto:`,
  `vscode:` und andere App-Links werden abgelehnt, damit ein Gerät weder lokale Dateien rendern noch
  Apps auf dem Desktop starten kann.
- **Keine Geheimnisse tippen:** Vor jedem `type`/`key` fragt `BrowserService.input` per
  `Runtime.evaluate`, worauf der Fokus liegt (auch in Shadow-DOM und Frames derselben Seite). Bei
  `type=password`, `autocomplete` mit `one-time-code`, `current-/new-password`, `cc-number` oder
  `cc-csc` und bei Frames fremder Seiten, in die man nicht hineinsieht, lautet die Antwort
  `secret-field`. Kann die Seite nicht antworten, gilt das ebenfalls als Geheimnis. Klicken und
  Scrollen bleiben möglich: Das Feld bekommt den Fokus, getippt wird am Desktop.
- **Ausgedünnter Zustand:** Geräte sehen keine Downloads, Berechtigungs- und Login-Fragen,
  Extensions und keine Liste anderer Geräte, die den Browser nutzen (`publicBrowserState`).
- **Desktop-Bildschirm bleibt Desktop:** `browser:activate` ist `desktop`; ein Gerät schaut Tabs per
  `capture` an, ohne den Desktop umzuschalten.
- `capture` liefert nur den sichtbaren Ausschnitt (JPEG, ≤ 1920 px breit), `input` nur Maus, Rad,
  Text und eine feste Tastenliste — keine Tastenkürzel mit Modifikatoren.
- Weiterhin kein Zugriff auf DevTools, Extensions, gespeicherte Logins, den Downloads-Ordner, das
  Löschen des Verlaufs und den Import.

### 3.3 Sichtbarkeit am Desktop (`RemoteActivity`)

- **Anzeige:** Solange ein Gerät den Browser nutzt (bis 45 s nach seinem letzten Browser-Aufruf),
  zeigt der Desktop-Browser oben eine Leiste: „iPhone nutzt diesen Browser — sieht deine Tabs und
  handelt mit deinen Logins“. Daneben steht **Beenden**, das ruft `server:setDeviceBrowser false` und
  wirkt sofort.
- **Aktivitätslog** (`EVENT_CATALOG`: `audit`, nur anhängend): `device.browser` für Ansehen,
  Eingabe, Öffnen, Navigieren, Schließen und Lesezeichen. Es wird nur die Seite (Host) protokolliert,
  **nie der getippte Text oder die Suchworte**. Bilder und Eingaben derselben Seite stehen höchstens
  einmal pro Minute im Log. `device.files` deckt Herunterladen, Hochladen, Anlegen, Umbenennen,
  Papierkorb, Zurücklegen, Verschieben, Kopieren, Rückgängig sowie Packen und Entpacken ab, mit
  Pfaden (bis 20 pro Stapel, dazu die Anzahl). Akteur ist `{ kind: 'device', id }`.
- Diese Einträge gehen **nicht** an Geräte (`events:recent` und `events:event` filtern `device.*`),
  sonst sähe ein Member, welche Seiten ein Admin-Gerät besucht hat.

## 4. Rest-Risiken

| # | Risiko | Einschätzung |
|---|---|---|
| R1 | Ein gestohlenes Geräte-Token mit Remote-Shells liest über Files alle normalen Dateien im Home-Ordner. | Wie bisher über die Shell; ohne Remote-Shells unverändert gesperrt. Jede Aktion steht im Aktivitätslog. Gegenmittel: Geräte in Settings entziehen, Remote-Shells nur bei Bedarf. |
| R2 | Ein freigegebenes Admin-Gerät (oder sein gestohlenes Token) handelt in eingeloggten Sitzungen. | Gewollt; pro Gerät, nur Admin, nur am Desktop, aus per Standard. Sichtbar durch die Leiste am Desktop und das Log, mit einem Klick beendet. Passwörter, Einmalcodes und Kartennummern lassen sich vom Gerät aus nicht eintippen. |
| R3 | `browser:capture` zeigt sensible Seiten (Mail, Bank) des Desktops. | Nur mit Freigabe; private Tabs bleiben unsichtbar. Empfehlung an Nutzer: Sensibles im privaten Tab. |
| R4 | Eine Webseite selbst leitet auf einen App-Link um oder öffnet ein Pop-up. | Wie beim Surfen am Desktop; die Prüfung auf Webseiten gilt der Eingabe des Geräts, nicht dem, was die Seite danach tut. |
| R5 | Die Prüfung auf Geheimfelder kennt nur die üblichen Merkmale (`type=password`, `autocomplete`). Eigene PIN-Felder ohne diese Merkmale sind nicht geschützt. | Bewusst schlicht; deckt Logins, 2FA-Codes und Kartenformulare nach Standard ab. |
| R6 | `finder:read` holt große Dateien in 4-MB-Stücken (Last auf dem Core). | Bodies ≤ 8 MB wie alle Anfragen; der Core liest pro Stück nur den Ausschnitt. |

## 5. Prüfungen

- **Neue Tests:**
  - `remote-files.test.ts`: Wurzeln, Links, Systemordner, Datenordner, versteckte Dateien, Deny-Liste, Papierkorb, Plattformen.
  - `browser-remote.test.ts`: Bild, Seitengröße, Laden nicht geladener Tabs, Maus, Rad, Text und Tasten, Geheimfelder, `webUrl`, Anzeige, private Tabs, kein Host.
  - `secret-focus.test.ts`: das Seiten-Skript in jsdom mit Passwort, OTP, Karte, Shadow-DOM, Frames derselben und fremder Seiten.
  - `remote-activity.test.ts`: Log-Einträge ohne getippten Text, Drosselung, Anzeige mit 45 s und Beenden, Files-Aktionen.
  - `channel-access.test.ts`: Snapshot der Remote-Oberfläche.
- **Ergänzte Tests:**
  - `remote-scope.test.ts`: private Tabs, ausgedünnter Zustand, nur Webseiten, `device.*` ausgefiltert, Dateilisten.
  - `server.test.ts`: Freigabe nur für Admins, Herabstufen löscht sie, Pushes nur an freigegebene Geräte, Abschalten wirkt sofort.
  - `browser-ipc.test.ts`: Rolle und Freigabe im Router, `browser:activate` nur am Desktop.
  - `infra.test.ts`: Router-Beobachter.
  - `createCore.test.ts`: durchgehend, mit Anzeige und Log am Desktop, nicht am Gerät.
  - `settings.test.tsx`: Globus pro Admin-Gerät.
  - `browser-library.test.tsx`: Leiste mit Beenden.
  - `agents-cockpit.test.tsx`: Log-Texte.
  - `finder-ops.test.ts`: `read` und `write`.
  - `browser-host.test.ts`: `preview`.
- **E2E** `tests/e2e/app-remote.spec.ts`: Ein Admin-Handy bekommt die Freigabe am Desktop, sieht und bedient einen Tab, scheitert an einem Passwortfeld und an `file://`. Der Desktop zeigt die Leiste, Beenden sperrt das Handy sofort. Private Tabs bleiben unsichtbar, Files sind nur mit Remote-Shells erreichbar.
- Lokal unter macOS bleiben die bekannten `/var` ↔ `/private/var`-Fehlschläge (vorbestehend, auf
  `develop` identisch); CI unter Linux ist maßgeblich.
