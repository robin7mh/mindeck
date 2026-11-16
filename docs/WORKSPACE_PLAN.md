# Plan: Mindeck als einziger Arbeitsplatz · Runde 1

**Stand:** 2026-10-15 · Branch `feature/web-browser` · **umgesetzt** (Schritte 0–9, siehe „Ergebnis“ am Ende)
**Bezug:** [`BROWSER_PLAN.md`](BROWSER_PLAN.md) (Gesamtbild Browser), `Mindeck_ARCHITECTURE.md` (bindende Muster)

## Ziel

Wer Mindeck öffnet, soll für das Entwickeln und Erstellen keine andere App mehr brauchen.

| Heute im Alltag | In Mindeck | Stand |
|---|---|---|
| VS Code / Cursor | Editor | vorhanden |
| Terminal / iTerm | Terminal | vorhanden |
| Claude Code, Codex, Gemini | Agents | vorhanden |
| Notizen / Obsidian | Memory | vorhanden |
| **Chrome / Arc / Safari** | **Browser** | **Runde 1** |
| **Finder / Explorer** | **Dateien** | **Runde 1** |
| Bilder, Videos, PDFs ansehen | Vorschau in Dateien | **Runde 1** |

Messlatte für diese Runde: Mindeck neu starten und denken: „Okay, 79 € sind in Ordnung.“

## Reicht Electron dafür?

Ja. Electron ist die Grundlage von VS Code, Cursor, Slack, Discord, Notion, Linear und Figma (Desktop). Für einen Browser ist es sogar die beste Wahl: In jedem Tab läuft das echte Chromium, also dieselbe Engine wie in Chrome, mit DevTools und Automatisierung (CDP) für die Agents. Tauri nutzt die System-WebView (unter macOS WebKit) und könnte weder Chrome-Kompatibilität noch Agent-Steuerung so bieten.

**Langlebig wird es nur unter einer Bedingung: Electron bleibt aktuell.** Mindeck läuft auf Electron 37, das seit Monaten keine Sicherheitsupdates mehr bekommt. Für einen Browser, der fremde Webseiten lädt, ist das nicht vertretbar. Deshalb ist das Update auf Electron 44 Schritt 0 dieser Runde.

## Schritte

Jeder Schritt läuft end-to-end (Service → IPC-Contract → UI), hält die 100-%-Coverage und lässt die App startfähig.

### Schritt 0: Electron 37 → 44
- `electron@44` (Chromium 152, Node 24), passende `@types/node`.
- Typecheck, Unit-Tests, Build und E2E auf der neuen Version grün.
- **Fertig:** Die App startet auf Electron 44, alle bestehenden Module funktionieren.

### Schritt 1: Fundament und Sicherheit
- Geteilte Typen `src/shared/types/browser.ts` und `finder.ts`, Kanäle `browser:*` und `finder:*` in `contract.ts` und `schemas.ts`, alle `desktop`-only.
- Browser-Events gehen **nie** an Remote-Clients (`DESKTOP_EVENTS`, URLs und Titel sind privat).
- **Navigationsschutz im Hauptfenster** (ANALYSE §3.2): Das Mindeck-Fenster navigiert nie weg. Links aus dem Agent-Chat oder aus Notizen öffnen im Mindeck-Browser (abschaltbar), andere Schemes gehen nur bei `mailto:` ans System.
- IPC nimmt nur Aufrufe aus dem eigenen App-Frame an (`senderFrame`-Prüfung).
- macOS: Kamera/Mikro-Beschreibungen und Entitlements (für Meet/Zoom im Browser).

### Schritt 2: Dateien (Explorer)
- `FinderService` (Core): Ordner auflisten, Orte (Home, Schreibtisch, Dokumente, Downloads, Bilder, Filme, Musik, Volumes), Suche (macOS: Spotlight `mdfind`, sonst begrenzte Suche), Vorschau, neuer Ordner, umbenennen, verschieben, kopieren, Papierkorb, mit Standard-App öffnen, im Finder zeigen. Schreiben nur unter Home und `/Volumes`.
- Protokoll `mindeck-file://` nur für das Mindeck-Fenster: Bilder, Videos (mit Spulen über Range-Requests), Audio und Systemvorschaubilder (Quick Look) für jede Datei.
- Modul **Dateien**: Seitenleiste mit Favoriten, Projekten und Vault; Pfadleiste; Liste mit Sortierung oder Raster mit Vorschaubildern; Vorschau rechts (Bild, Video, Audio, Text/Code, Markdown, PDF); Mehrfachauswahl, Tastatur (Pfeile, Enter, Leertaste, ⌘⌫, ⌘↑, ⌘[ / ⌘]), Drag & Drop (verschieben, ⌥ = kopieren), Kontextmenü.
- Verknüpft: im Editor öffnen (Dateien eines Projekts), im Browser öffnen (HTML, PDF), Terminal hier öffnen, mit Agent bearbeiten, Pfad kopieren.

### Schritt 3: Browser-Kern
- `BrowserService` (Core, ohne Electron): Tabs, Reihenfolge, aktiver Tab, geschlossene Tabs (⌘⇧T), Eingabe → URL oder Suche (Google, DuckDuckGo, Bing, Ecosia, Brave, Kagi), Verlauf als Datei (`~/Mindeck/data/browser/`), Vorschläge (Verlauf nach Häufigkeit und Aktualität, offene Tabs), Sitzung über Neustarts.
- `ElectronBrowserHost`: ein `WebContentsView` pro Tab in eigener Partition (`persist:mindeck-browser`, Sandbox, kein Preload, kein Node), User-Agent wie Chrome (ohne `Electron/`), Tabs bleiben gemountet.

### Schritt 4: Browser wie Chrome
- Shortcuts auch bei fokussierter Webseite (`before-input-event`): ⌘T/W/L/R/⇧R/[/]/F/±/0, ⌘1–9, ⌃Tab, ⌘⇧T, ⌘⌥I.
- Natives Kontextmenü (Link in neuem Tab, kopieren, Bild speichern, Rechtschreibung, Untersuchen …), Suchen in der Seite, Zoom pro Tab, Drucken, DevTools.
- Downloads nach `~/Downloads` mit Fortschritt, „Im Finder zeigen“, Quarantäne-Flag unter macOS.
- Berechtigungen (Kamera, Mikro, Mitteilungen, Standort, Bildschirm teilen, externe Apps) als Leiste im Browser, merkbar pro Seite.
- Popups mit `opener` (Login mit Google/GitHub/Apple) als echtes Fenster, alle anderen als Tab. Zertifikatsfehler zeigen eine Fehlerseite, nur für localhost wird vertraut.
- Webseiten folgen dem Mindeck-Theme (hell/dunkel).

### Schritt 5: Browser-Oberfläche
- Tab-Leiste (Favicon, Titel, Laden, Ton, angeheftet, Agent-Markierung), Toolbar mit Zurück/Vor/Neu laden, Adressleiste mit Vorschlägen und Inline-Ergänzung.
- Neuer-Tab-Seite im Mindeck-Look: Suche, laufende Dev-Server, häufig besuchte Seiten, Repos der Projekte.
- Fehlerseite, Absturzseite, Suchleiste, Downloads-Seitenleiste, Berechtigungsleiste.
- **Overlays:** Die Webansicht liegt über der Oberfläche. Dropdowns, Dialoge und Vorschläge frieren sie als Bild ein, solange sie offen sind. **Freigaben frieren nie ein:** Im Browser erscheinen sie in einer Leiste über der Seite.

### Schritt 6: Agents im Browser
- Tools in der ToolRegistry, über den MCP-Server automatisch für Claude Code, Codex und Gemini (und den Coding-Assistenten):
  `browser_tabs`, `browser_open`, `browser_navigate`, `browser_snapshot` (Accessibility-Baum mit Refs), `browser_read` (Seitentext), `browser_screenshot` (als Bild), `browser_console`, `browser_click`, `browser_type`, `browser_press`.
- **Freigabe-Modell:** Agents sehen nur geteilte Tabs, also localhost-Seiten, Tabs, die ein Agent selbst geöffnet hat, und Tabs, die du per Auge-Symbol teilst. Lesen läuft ohne Nachfrage, Handeln (öffnen, klicken, tippen) fragt über die bestehenden Freigaben (mit „Immer erlauben“). In Passwortfelder tippt kein Agent, Werte daraus erscheinen nie.
- Sichtbar: Agent-Tabs sind markiert, der Tab zeigt, welcher Agent zuletzt was getan hat. „An Agent senden“ teilt den Tab und öffnet einen neuen Agent-Chat dazu.

### Schritt 7: Alles greift ineinander
- **Dev-Server-Erkennung** aus der Terminal-Ausgabe (Vite, Next.js, Astro, Rails, Django …): Chip „localhost:5173 öffnen“ im Terminal und auf der Neuer-Tab-Seite.
- Live Server (Editor) öffnet im Mindeck-Browser.
- Neue Module in der Navigation: **Browser** und **Dateien**. Browser und Dateien bleiben gemountet wie Terminal und Editor.

### Schritt 8: Einstellungen und Doku
- Einstellungen → Browser: Suchmaschine, Links aus Mindeck im Mindeck-Browser öffnen, Verlauf löschen.
- `Mindeck_ARCHITECTURE.md` §12.9 (Browser, Dateien), Hinweis in `BROWSER_PLAN.md`.

### Schritt 9: Prüfen
- `npm run typecheck`, `npm run test:coverage` (100 %), `npm run build`.
- E2E (echte Electron-App): Browser öffnet eine lokale Testseite, Tabs, Adressleiste, Dateien listet einen Ordner und zeigt eine Vorschau.
- App starten und durchklicken.

## Bewusst später

Aus `BROWSER_PLAN.md`: Import aus Chrome/Arc (Logins, Lesezeichen), Mindeck als Standardbrowser, Container und Test-Identitäten, Site-Actions (GitHub/Vercel/Sentry), Element-Picker → Datei:Zeile, Flows → Playwright, Adblock, vertikale Tabs/Spaces, Agent-Aufzeichnungen, Handy-Zuschauen. Für Dateien: Vorschau über Quick Look hinaus, Tags, Spalten-Ansicht, Drag & Drop mit anderen Apps.

## Risiken

| Risiko | Umgang |
|---|---|
| Electron-Update bricht etwas | Schritt 0 zuerst, komplette Tests und E2E vor allem anderen |
| Webansicht verdeckt Oberfläche | Freeze für modale Overlays, Freigaben im Browser als Leiste |
| Google-Login blockiert eingebettete Browser | Chrome-User-Agent, echte Popup-Fenster; Rest in `BROWSER_PLAN.md` |
| Agents und private Seiten | Nur geteilte Tabs, Handeln immer mit Freigabe, Passwortfelder tabu |
| Dateioperationen am falschen Ort | Schreiben nur unter Home/Volumes, Löschen nur in den Papierkorb |

## Ergebnis (2026-10-15)

Alle Schritte sind gebaut; die Architektur steht in `Mindeck_ARCHITECTURE.md` §12.9.

| Prüfung | Stand |
|---|---|
| `npm run typecheck` | grün |
| Unit-Tests | 1172 grün, Coverage 100 % (Zeilen, Branches, Funktionen) |
| E2E Electron | 11 grün, neu: Browser (lokale Seite, Zurück, Tabs, Verlauf), Dev-Server im Terminal → Klick → Browser-Tab, Dateien (Ordner, Vorschau, Umbenennen, Neuer Ordner, Suche, Terminal hier) |
| E2E Web-UI | 5 grün |

Abweichungen und Funde beim Umsetzen:

- **Adressleiste:** Die E2E-Tests haben zwei Fehler gefunden, die Unit-Tests nicht sehen konnten. Wer nach ⌘L sehr schnell tippte, hängte den Text an die alte Adresse an; die Auswahl passiert jetzt im selben Render wie das Einsetzen der Adresse. Und ⌘T zeigte kurz die Adresse des vorigen Tabs; solange nichts getippt ist, folgt die Leiste jetzt dem Tab.
- **„Häufig besucht“** zeigt keine `localhost`-Seiten (Ports wechseln). Laufende Dev-Server haben ihren eigenen Bereich.
- **Dateien-Suche:** Findet Spotlight nichts, sucht Mindeck selbst (begrenzt auf 4 s). Viele Entwickler schließen Code-Ordner von Spotlight aus, und externe oder Netzlaufwerke sind oft nicht indiziert.
- **Schreiben** ist auch in Mindecks eigenem Ordner erlaubt (`MINDECK_HOME`), wenn er außerhalb von Home liegt.

