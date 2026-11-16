# Plan: Mindeck Browser (v2)

**Stand:** 2026-10-14 · ersetzt die erste Fassung des Browser-Plans
**Umgesetzt (Runde 1, 2026-10-15):** Browser-Kern, Chrome-Grundfunktionen, Agent-Tools (`browser_*`) mit Tab-Freigabe, Dev-Server-Erkennung, dazu das Modul Dateien; siehe [`WORKSPACE_PLAN.md`](WORKSPACE_PLAN.md) und `Mindeck_ARCHITECTURE.md` §12.9. Alles Weitere in diesem Plan ist noch offen.
**Vor jeder Phase lesen:** `Mindeck_ARCHITECTURE.md` §1.2, §2.1, §8, §9, §12.4, §12.6 und `docs/ANALYSE-2026-10.md` §3.2, §3.3, §3.7.
**Regeln:** Neue Fähigkeiten werden **einmal** in `src/shared/ipc/contract.ts` und `schemas.ts` angelegt. Nach jeder Phase einen Abschnitt `§12.x Browser` im Architektur-Dokument ergänzen.

## Was sich gegenüber v1 geändert hat

1. **Reihenfolge nach Wert.** Zuerst kommt der Dev-Loop („deine Agents sehen deinen localhost“), den kein anderer Browser so hat, danach die Chrome-Parität. In v1 hätte Mindeck monatelang einen Browser nachgebaut, bevor es etwas Eigenes gezeigt hätte.
2. **Neue Kernfunktionen:** „Fix mit Agent“ für jeden Fehler, Element → `Datei:Zeile`, ein Rückkanal nach jedem Agent-Edit, Site-Actions (GitHub, Vercel, Sentry, Linear), Flows → Playwright-Tests, Container mit Test-Identitäten, Übergabe an den Menschen bei 2FA/CAPTCHA, visuelle Freigaben, Best-of-N-Previews.
3. **Agent-Sicherheit als Modell statt als Einzelfragen:** Tab-Zustand (privat, geteilt, Agent), Origin-Klassen (lokal, Projekt, Web, sensibel). Folgenreiche Klicks werden immer einzeln gefragt.
4. **Technische Lücken aus v1 geschlossen:** Shortcuts bei fokussierter Webseite, Toasts frieren den Browser nicht mehr ein, CDP nur bei Bedarf, Electron-Update als harte Vorbedingung, Kamera/Mikro-Entitlements, Bildschirmfreigabe, Safe Browsing, DRM, Download-Quarantäne, Windows-Cookie-Verschlüsselung, Headless-Core.
5. **Positionierung, Demo-Momente und Messgrößen**, damit jede Phase etwas Verkaufbares liefert.

---

## 0. Positionierung

**In einem Satz:** Mindeck ist der Browser, in dem deine Coding-Agents mitarbeiten. Sie sehen deinen localhost, deine Fehler und, wenn du es erlaubst, deine eingeloggten Dashboards, mit dem Claude-, Codex- oder Gemini-Konto, das du schon hast.

**Abgrenzung** (Stand vor der Launch-Kommunikation noch einmal prüfen, keine ungeprüften Behauptungen über Wettbewerber, siehe ANALYSE §8.3):

| Kategorie | Beispiele | Was Mindeck anders macht |
|---|---|---|
| KI-Browser für alle | ChatGPT Atlas, Perplexity Comet, Dia, Chrome mit Gemini | Bindet ein festes Modell samt Cloud ein, hat keinen Projektkontext und keine Coding-Agents. Mindeck nutzt die Agents des Users und kennt Repo, Worktrees und Dev-Server |
| Editor mit Vorschau | Browser in Cursor, VS Code Simple Browser | Kein Alltagsbrowser, keine Logins, kein Import, an einen Anbieter gebunden |
| Browser-Automation für Agents | Playwright MCP, Browser-Erweiterungen | Separates Setup, kennt keine Projekte, keine Freigaben aus einer Hand |
| Arc | seit 2025 nur noch gewartet | Mindeck wird das neue Zuhause für Arc-Nutzer, die programmieren (Spaces werden zu Projekten) |

**Zielgruppen in dieser Reihenfolge:**
1. Webentwickler mit Claude Code, Codex oder Gemini. Sie zahlen schon für Agents und spüren den Dev-Loop sofort.
2. Arc-Nutzer, die programmieren. Sie haben einen Grund umzuziehen, und der Import nimmt ihre Spaces mit.
3. Alle anderen Mindeck-Nutzer, die Mindeck als Alltagsbrowser und Standardbrowser nutzen (Phase 4).

### 0.1 Die fünf Demo-Momente

Jede Phase muss mindestens einen davon live möglich machen. Daraus entstehen die Launch-Videos.

1. **Rot zu Grün in 30 Sekunden.** `npm run dev` im Mindeck-Terminal → Chip „localhost:5173 öffnen“ → die Seite zeigt einen Fehler → Klick auf „Fix mit Claude“ → Claude bekommt Fehler, Stack mit `Datei:Zeile`, Console und Screenshot → ändert den Code → die Seite lädt neu, das Fehler-Badge verschwindet, im Chat steht Vorher/Nachher.
2. **Zeigen statt beschreiben.** Element anklicken, „mach den Button wie den primären auf stripe.com“ tippen → der Agent bekommt `src/components/Hero.tsx:42`, die Komponentenkette, Styles und einen Screenshot → ändert → das Ergebnis ist sofort sichtbar.
3. **Der Agent sieht, was nach seinem Edit passiert.** Nach jedem Edit von Claude Code meldet Mindeck neue Console-Fehler im Preview-Tab automatisch zurück. Der Agent repariert sie, bevor der User sie bemerkt.
4. **Jede Fehlermeldung im Web ist einen Klick vom Fix entfernt.** Ein fehlgeschlagener GitHub-Actions-Run, Vercel-Deploy, ein Sentry-Issue oder Linear-Ticket → Chip „Mit Agent lösen“ → der Agent startet im richtigen Projekt mit dem Log als Kontext.
5. **Im echten Web, aber kontrolliert.** „Prüf in Vercel, warum der Deploy hängt“: Der Agent öffnet vercel.com, fragt einmal für vercel.com (mit Screenshot des Ziels), liest das Build-Log, bittet beim 2FA-Prompt kurz um Übernahme und macht dann weiter.

### 0.2 Was wir bewusst nicht bauen

Kein eigenes Modell im Browser (es arbeiten die Agents des Users und optional der Mindeck-Assistent), kein eigener Sync-Dienst in v1, kein Extension-Store, kein Cookie-Import unter Windows (App-Bound Encryption, siehe 8.1), kein Mobile-Browser.

---

## 1. Produktprinzipien

1. **Schnell.** Tabwechsel ohne Flackern (< 50 ms bis sichtbar), Views bleiben gemountet, die Befehlsleiste antwortet in < 30 ms. Ein Browser wird im Sekundentakt benutzt, jede Verzögerung fällt auf.
2. **Vertraut.** Shortcuts, Kontextmenüs, Downloads, Suchen und Zoom verhalten sich wie in Chrome. Das Muskelgedächtnis bricht nie.
3. **Eingeloggt ab Minute 1.** Logins, Lesezeichen und Verlauf werden übernommen (mit Zustimmung).
4. **Projektbewusst.** Tabs, Logins und Links gehören zu Projekten.
5. **Agent-nativ und kontrolliert.** Jeder Tab ist für Agents bedienbar, aber nur, wenn der User es erlaubt. Agent-Aktionen sind immer sichtbar, stoppbar und übernehmbar. Policy ist Code (§9).
6. **Keine Freigabe-Müdigkeit.** Ein klares Modell (Tab-Zustand + Origin-Klasse) statt 20 Einzelfragen. Gefragt wird, wo es zählt: fremde Seiten, folgenreiche Klicks, sensible Seiten.
7. **So sicher wie ein echter Browser.** Aktuelles Chromium, Schutz vor Phishing und Malware, saubere Zertifikatsfehler, Download-Quarantäne. Ein veralteter Browser ist ein Haftungsrisiko.
8. **Ehrlich bei Grenzen.** Was nicht geht (DRM-Streaming, Passkeys, einzelne Google-Logins), wird erkannt und mit einem Klick an den System-Browser übergeben.

---

## 2. Vorbedingungen (Phase 0, blockiert alles Weitere)

### 2.1 Harte Gates

| Gate | Warum | Quelle |
|---|---|---|
| Electron auf eine unterstützte Major-Version heben (heute 37.10.3, aktuell 44.x) | Ein Browser mit ungepatchtem Chromium ist angreifbar, sobald er fremde Seiten lädt | ANALYSE §3.3 |
| Update-Regel: Electron-Sicherheitsreleases binnen 7 Tagen ausliefern | Chrome patcht etwa wöchentlich. `UpdateService` existiert, dazu Renovate/Dependabot für `electron` und Release über CI | neu |
| Navigationsschutz im Hauptfenster und `senderFrame`-Prüfung im Router | Ab jetzt lädt Mindeck absichtlich fremde Inhalte. Eine Webseite darf `window.mindeck` nie erreichen | ANALYSE §3.2 |
| `PermissionGrant` bekommt einen Scope (`projectId`, `origin`) | Heute ist ein Grant nur `agentId + toolName`. Browser-Grants pro Origin bauen darauf auf, nebenbei ist §3.7/§4.2 behoben | ANALYSE §3.7 |
| Kamera/Mikro: `NSCameraUsageDescription` und `NSMicrophoneUsageDescription` in `extendInfo` (`electron-builder.yml`), Entitlements `com.apple.security.device.camera` und `com.apple.security.device.audio-input` | Ohne sie scheitern Google Meet und Zoom im Web im signierten Build. In `build/entitlements.mac.plist` fehlen beide heute | neu |

### 2.2 Spikes (je 0,5–2 Tage, Ergebnisse in `docs/browser/SPIKES.md`)

| # | Frage | Erfolgskriterium |
|---|---|---|
| S1 | `WebContentsView`: Z-Ordnung, Fokus, Bounds bei HiDPI und Display-Wechsel, `capturePage()` für Freeze, Kosten von 30 versteckten Views, Quarantäne-Attribut auf Downloads | Tabwechsel < 50 ms, Freeze-Bild pixelgenau auf Retina |
| S2 | Logins: UA ohne `Electron/` und `Mindeck/`, Client Hints (`Sec-CH-UA*` über `onBeforeSendHeaders`, `navigator.userAgentData`), OAuth-Popups mit `opener` | Google-, Microsoft-, GitHub- und Apple-ID-Login klappen im gepackten Build |
| S3 | CDP: Kosten von `debugger.attach`, Betrieb parallel zu offenen DevTools, Erkennung durch Bot-Schutz (Cloudflare, Google), Screenshots versteckter Views, `backgroundThrottling: false` für Agent-Tabs | Attach und Detach < 100 ms, kein Login-Bruch durch Attach |
| S4 | Element → Quelle: React 18 (`_debugSource`), React 19 (Owner-Stack, `_debugStack`), Vue (`__vueParentComponent.type.__file`), Svelte (`__svelte_meta.loc`), Fallback über Source-Map und Text-Suche | Treffer `Datei:Zeile` in ≥ 80 % der Klicks auf den Fixture-Apps (Vite+React 18/19, Next.js, Vue, SvelteKit) |
| S5 | `node:sqlite` in Electrons Node (ohne Flag ab Node 22.13) für den Import, sonst `better-sqlite3` (Prebuilds, nur im Main) | Kopien von Chromes `History` und `Cookies` lesbar |
| S6 | Zwei-Finger-Swipe für Zurück/Vor auf macOS (Gesture-Events über `input-event`, `swipe` am BrowserWindow) | Fühlt sich an wie Safari/Chrome, sonst bewusster Verzicht |

---

## 3. Architektur

### 3.1 Wo der Browser lebt

Der Core läuft auch headless als Server (§12.4), der Browser braucht aber Electron. Deshalb:

- Ein Interface `BrowserHost` im Core (`electron/main/services/browser/types.ts`), implementiert nur von der Electron-`Platform`. Headless meldet `unavailable`, die Browser-Tools antworten dann „Der Browser läuft nur in der Desktop-App“.
- Tools und IPC-Handler kennen nur `BrowserService`, nie `electron` (Layering §2.1).

```
electron/main/services/browser/
  BrowserService.ts   Fassade für IPC und Tools: Spaces, Tabs, Navigation, Restore
  ViewHost.ts         WebContentsView: Bounds, Sichtbarkeit, Freeze, Discard (nur Electron)
  Sessions.ts         Partitionen (Hauptprofil, Container), UA/Client Hints, Permissions, Downloads
  Guard.ts            Schemes, externe Protokolle, Zertifikate, sensible Domains, Malware-Listen
  PageWatch.ts        passive Erfassung ohne CDP: Console, Ladefehler, Crashes, Netzwerk (Ringpuffer)
  Automation.ts       CDP bei Bedarf: Snapshot, Aktionen, Screenshots, Emulation, Inspect-Modus
  Inspector.ts        Element-Picker → ElementContext (Quelle, Komponenten, Styles, Ausschnitt)
  SourceMaps.ts       Dev-Server-URL und Stack → Projektdatei:Zeile
  DevServers.ts       Erkennung aus PTY-Output, Agent-Läufen und lsof, Zuordnung zu Projekten
  SiteActions.ts      deklarative Erkennung bekannter Seiten (GitHub, Vercel, Sentry, Linear …)
  Policy.ts           Origin-Klassen, Tab-Zustand, Berechtigungsmatrix → PermissionService
  History.ts          Verlauf (JSONL pro Monat) + Frecency-Index im Speicher
  Bookmarks.ts        Lesezeichen, Projekt-Links
  Recorder.ts         Agent-Aufzeichnungen und Flows
  import/             Chromium-Familie, Arc, Firefox (Phase 4)
  DefaultBrowser.ts   System-Browser, Handoff, Protokoll-Registrierung, Link-Router
electron/main/services/ai/tools/browser.ts    Agent-Tools (rufen nur BrowserService)
```

### 3.2 Views

- **Ein `WebContentsView` pro Tab** als Child-View des Hauptfensters (`win.contentView.addChildView`). Inaktive Tabs werden mit `setVisible(false)` versteckt, nicht zerstört.
- **Discard** nach Inaktivität (Standard 30 min). Ausgenommen sind angeheftete Tabs, Tabs mit Audio, Agent-Tabs und Preview-Tabs. Gemerkt werden URL, Titel, Favicon und Scrollposition, die View wird freigegeben und beim Aktivieren neu geladen. Tabs mit `beforeunload`-Handler (ungespeicherte Formulare) werden nie verworfen.
- **Bounds:** Der Renderer misst den Platzhalter (`ResizeObserver`, in DIP) und sendet `browser:view:setBounds`. Main setzt die Bounds aller sichtbaren Views eines Layouts in einem Schritt (ein Split besteht aus mehreren Rechtecken).
- **Modulwechsel:** View ausblenden, Fokus zurück an den Renderer.
- **Agent-Tabs im Hintergrund** laufen mit `backgroundThrottling: false` (sonst stehen Timer still) und stehlen keinen Fokus. Screenshots versteckter Views nach Ergebnis von S3, notfalls über ein Offscreen-Fenster.

### 3.3 Overlays (Korrektur gegenüber v1)

v1 wollte bei jedem Overlay einfrieren. Das bricht bei Toasts: Wer gerade in Gmail tippt, würde von jeder Freigabe-Toast eingefroren. Deshalb drei Klassen:

| Klasse | Beispiele | Lösung |
|---|---|---|
| Modal (der User verlässt die Seite ohnehin) | Command-Palette, Dialoge (`NewChatDialog`, `LicenseGate`, `FolderPicker`), Vorschläge der Befehlsleiste, `Select` über dem Viewport | **Freeze:** `capturePage()` → `<img>` an derselben Stelle, View ausblenden, beim Schließen zurück |
| Nicht modal | `ApprovalToasts`, Hinweise, Download-Fortschritt | **Nie einfrieren.** Im Browser-Modul erscheinen sie im **Dock**, einer Leiste zwischen Toolbar und Viewport (dieselbe Zone wie die `AgentActivityBar`). Der Viewport schrumpft animiert, statt verdeckt zu werden |
| Menüs | Tab-Kontextmenü, Seiten-Kontextmenü, „…“-Menü | **Native Menüs** (`Menu.popup`). Sie liegen von Haus aus über allen Views |

- Umsetzung: Jede Overlay-Komponente meldet mit `useOcclusion(ref, kind)` ihr Rechteck an einen zentralen `OcclusionManager` im Renderer. Er berechnet den Schnitt mit dem Viewport und sendet `browser:view:freeze` / `unfreeze`. Kein globales DOM-Scannen.
- Wächter im Dev-Modus: Ein `fixed`-Element, das den Viewport schneidet, ohne registriert zu sein, erzeugt eine Warnung in der Konsole. So rutscht kein neues Overlay durch.
- Für v1 verworfen: ein transparenter Overlay-`WebContentsView` für die Mindeck-UI (zwei React-Roots, State-Sync). Bleibt Fallback, falls sich der Freeze schlecht anfühlt.

### 3.4 Tastatur und Fokus (Lücke in v1)

Hat eine Webseite den Fokus, bekommt der Mindeck-Renderer **keine** Tastenereignisse. „Shortcuts nur aktiv, wenn der Browser-Reiter Fokus hat“ funktioniert so nicht.

- **App-Menü mit Accelerators** wie in Chrome (Ablage, Bearbeiten, Darstellung, Verlauf, Lesezeichen, Tab, Fenster): Cmd+T/W/L/R, Cmd+Shift+R, Cmd+[ und ], Cmd+F, Cmd+D, Cmd+Y, Cmd+± und 0, Cmd+Shift+T, Cmd+Alt+I, Ctrl+Tab. Das wirkt unabhängig vom Fokus und sieht in der macOS-Menüleiste nativ aus. Die Einträge sind nur im Browser-Modul aktiv.
- **`before-input-event`** auf jedem Tab-`webContents` für Mindeck-globale Shortcuts (Cmd+K, Modulwechsel, Agent-Stopp): an den Renderer weitergeben, `preventDefault` nur für genau diese.
- **Eine Shortcut-Tabelle** `src/shared/shortcuts.ts` (rein, ohne DOM) speist Menü, Renderer und Hilfe-Overlay. Konfliktregel: Im Browser-Modul gewinnen Chrome-Standards (z. B. Cmd+1…9 = Tabs).
- Cmd+L und Cmd+T geben den Fokus ausdrücklich an den Renderer (`mainWindow.webContents.focus()`), Esc in der Befehlsleiste gibt ihn an die Seite zurück.

### 3.5 Partitionen, Profile, Container

- `persist:mindeck-browser` ist das Profil des Users (Logins, Verlauf), getrennt von der Mindeck-UI.
- **Container** `persist:mindeck-c-<id>`: eigene Cookie-Welten pro Projekt, z. B. „Test-Admin“, „Test-Free“, „Kunde B“. Tabs zeigen ihren Container farbig. Damit lassen sich zwei Rollen nebeneinander testen, und Agents arbeiten mit Testkonten statt mit den echten Logins.
- **Agent-Identität:** Öffnet ein Agent eine nicht lokale Seite, gilt die Projekteinstellung „Agent surft mit: deinen Logins | Container X | frischem Wegwerf-Container“. Standard ist der Wegwerf-Container, die echten Logins nur nach ausdrücklicher Wahl.
- Für jede Partition gelten dieselben Regeln (Guard, UA, Adblock, Permissions). Eine Fabrik in `Sessions.ts` richtet sie ein.
- Privates Fenster: Partition ohne `persist:`, nichts wird gespeichert.

### 3.6 Passive Erfassung ohne CDP

CDP (`webContents.debugger`) wird nur angehängt, wenn ein Agent handelt, der Picker läuft oder Emulation aktiv ist, und nach 30 s Leerlauf wieder getrennt. Gründe: Performance, Bot-Erkennung, Konflikte mit DevTools.

Ohne CDP verfügbar und für Tabs der Origin-Klasse `local` immer an (sonst nur Fehlerzähler):

- `console-message` (Level, Text, Quelle, Zeile) → Ringpuffer mit 500 Einträgen pro Tab
- `did-fail-load`, `render-process-gone`, `unresponsive`
- `session.webRequest.onCompleted` / `onErrorOccurred` → Methode, URL (bei fremden Origins ohne Query-Werte), Status, Dauer, Typ. **Header-Werte werden nie gespeichert.**
- Framework-Overlays: Vite (`vite-error-overlay`), Next.js (`nextjs-portal`), React-Hydration-Warnungen über Console-Muster

### 3.7 IPC (`contract.ts`, `schemas.ts`)

Alle Kanäle `CHANNEL_ACCESS: 'desktop'`.

```
browser:state                     Gesamtzustand für den Renderer (Spaces, Tabs, aktive Tabs)
browser:tabs:create|close|activate|move|pin|duplicate|mute|reopenClosed|setSpace|setContainer|share
browser:navigate|back|forward|reload|stop
browser:view:setBounds|freeze|unfreeze|focus
browser:find|findStop|zoom|print|devtools|emulate
browser:omnibox:suggest           Vorschläge (Verlauf, Lesezeichen, Tabs, Befehle, Site-Search)
browser:history:search|delete|clear
browser:bookmarks:list|add|update|remove|export
browser:downloads:list|cancel|open|reveal
browser:permission:respond        Kamera, Mikro, Standort, Notifications, Clipboard, externe Protokolle
browser:inspect:start|stop        Element-Picker
browser:problems:list|clear       Fehler pro Tab
browser:devservers:list|open
browser:containers:list|create|remove
browser:handoff                   URL im erkannten System-Browser öffnen
browser:import:detect|run         (Phase 4)
browser:settings:get|set
browser:agent:takeover|release|stop
```

Events: `browser:changed` (Patch mit Tab-Feldern: title, url, favicon, loading, progress, canGoBack, audible, problems, agent), `browser:download`, `browser:permissionRequest`, `browser:findResult`, `browser:inspectResult`, `browser:devServer`, `browser:agentActivity`.

Web-UI und Mobile bekommen zunächst nichts. Ab Phase 6 kommen `browser:screencast` und `browser:tabs:list` mit eigenem Opt-in dazu.

### 3.8 Persistenz (Dateien, keine DB, §11.5)

```
~/Mindeck/data/browser/
  session.json            Spaces, Tabs (url, title, favicon-hash, scroll, pinned, container, projectId), aktive Tabs
  history/2026-10.jsonl   Besuche (url, title, ts, transition), eine Datei pro Monat; Frecency-Index der letzten 90 Tage im Speicher
  history/imported.jsonl  importierter Verlauf (siehe 8.1)
  bookmarks.json          Lesezeichen, Ordner, Projekt-Links
  sites.json              pro Origin: Zoom, Permissions, Adblock-Ausnahme, Zertifikatsausnahme (nur lokal), externe Protokolle
  containers.json
  favicons/               PNGs, benannt nach Hash
  recordings/<session>/   Agent-Aufzeichnungen (Phase 3), 14 Tage aufbewahrt
<projekt>/.mindeck/flows/*.json     Flows gehören ins Repo (teilbar, versioniert)
```

Geschrieben wird über `lib/writeAtomic`, `session.json` höchstens alle 2 s und sofort bei `will-quit`. Jede Datei trägt `version`. Beschädigte Dateien werden beim Start beiseitegelegt, statt den Core zu stoppen (ANALYSE §4.1). `tab.projectId` ist View-Zustand, kein Domänen-Objekt, deshalb ein Feld und keine Relation (§4.1 gilt für Domänendaten).

### 3.9 Renderer

```
src/features/browser/
  store.ts               Zustand (Abbild von browser:state + Patches), keine Domänenlogik
  occlusion.ts           OcclusionManager + useOcclusion
  components/
    BrowserModule.tsx    Layout: Tabs, Toolbar, Dock, Viewport(s), Seitenleiste
    TabStrip.tsx         horizontal
    TabSidebar.tsx       vertikal (Arc-Stil), Spaces, Container-Farbe, Agent-Markierung
    CommandBar.tsx       URL, Suche, Tabs, Verlauf, Lesezeichen, Mindeck-Befehle, Agent-Auftrag
    Viewport.tsx         Platzhalter → Bounds, Freeze-Bild, Lade- und Fehlerzustände
    Dock.tsx             Toasts, Downloads, Permission-Prompts, Agent-Aktivität
    ProblemsBadge.tsx    Fehlerzähler + „Fix mit Agent“
    Inspector.tsx        Picker-Ergebnis + Prompt-Blase
    NewTab.tsx           Projekt-Startseite
    AgentActivityBar.tsx
```

Nav-Eintrag `browser` (Icon `Globe`) in `src/data/navigation.ts`, `ModuleId` erweitern. Alle Texte über `src/lib/i18n` (de und en). Web-UI und Mobile zeigen bis Phase 6 „Nur in der Desktop-App“.

---

## 4. Säule A: Alltagsbrowser (Chrome-Parität und Arc-Komfort)

**Tabs und Spaces**
- Neu, schließen, wiederherstellen (Cmd+Shift+T, auch ganze Spaces), anheften, verschieben, duplizieren, stummschalten, in einen anderen Space oder Container verschieben.
- Horizontal (Standard) oder vertikal als Seitenleiste im Arc-Stil. Angeheftete Tabs pro Space als Favicon-Raster.
- **Spaces = Projekte**, dazu ein Space „Allgemein“. Ein Projektwechsel in Mindeck wechselt den Space (abschaltbar).
- Auto-Archiv wie in Arc: nicht angeheftete Tabs wandern nach X Stunden Inaktivität ins durchsuchbare Archiv. Standard aus, im Onboarding für Arc-Umsteiger angeboten.
- Tab-Suche (Cmd+Shift+A), Audio-Indikator, Speicherverbrauch pro Tab im Hover.

**Befehlsleiste (Cmd+L / Cmd+T)**
- Eine Leiste für URL, Suche (Google, DuckDuckGo, Kagi, Brave, Ecosia), offene Tabs („Zu Tab wechseln“), Verlauf, Lesezeichen, Projekt-Links, Mindeck-Befehle (`>`) und Agent-Aufträge (`@claude …`).
- Inline-Autocomplete nach Frecency (Häufigkeit × Aktualität × getippt statt geklickt).
- **Site-Search-Kürzel** wie in Chrome, für Entwickler vorbelegt: `npm`, `gh`, `mdn`, `caniuse`, `so`. Dazu **stack-bewusste Kürzel** aus der Stack-Erkennung des `ContextService`: Nutzt das Projekt Next.js, sucht `next <begriff>` in der Next.js-Doku, ebenso `tw` für Tailwind oder `prisma` für Prisma.
- Getippte Hosts bekommen `https://` (HTTPS-first), außer `localhost` und LAN-Adressen. `javascript:` wird beim Einfügen entfernt.

**Navigation, Darstellung, Inhalte**
- Zurück/Vor (Long-Press zeigt den Verlauf), Neu laden, hart neu laden, Stopp, Ladebalken. Swipe nach Ergebnis von S6.
- Suchen in der Seite (`findInPage`), Zoom pro Origin, Drucken, PDF (eingebaut), Vollbild, Picture-in-Picture.
- Dark Mode: `nativeTheme.themeSource` folgt dem Mindeck-Theme, damit stimmt `prefers-color-scheme`.
- Rechtschreibprüfung (Electron-Spellchecker, Sprachen aus dem System).
- Natives Kontextmenü: Link in neuem Tab / in Container / im System-Browser öffnen, Link kopieren, Bild speichern und kopieren, Kopieren/Einfügen, Rechtschreibvorschläge, Untersuchen, **„An Agent senden“** (Auswahl, Bild, Element), **„Als Notiz speichern“**.

**Downloads**
- `will-download` → `~/Downloads` (einstellbar), Fortschritt im Dock, „Im Finder zeigen“, Abbrechen, Liste.
- **Quarantäne:** Downloads müssen `com.apple.quarantine` tragen, damit Gatekeeper sie prüft. Verhalten von Electron in S1 prüfen, sonst selbst setzen. Warnung bei ausführbaren Typen (`.dmg .pkg .app .command .sh .exe`). Nichts wird automatisch geöffnet.

**Berechtigungen und Geräte**
- `setPermissionRequestHandler` und `setPermissionCheckHandler` → Prompt im Dock, Entscheidung pro Origin in `sites.json`, Standard „fragen“. Kamera und Mikro zusätzlich über macOS-TCC (`systemPreferences.askForMediaAccess`).
- **Bildschirmfreigabe** (Meet, Zoom im Web, Loom): `session.setDisplayMediaRequestHandler` mit Auswahl (macOS-System-Picker über `useSystemPicker`, sonst eigener Picker über `desktopCapturer`). Ohne Handler scheitert `getDisplayMedia`.
- Web-Notifications (Slack, Gmail, Linear) als macOS-Mitteilungen, pro Origin erlaubt.
- Externe Protokolle (`mailto:`, `zoommtg:`, `slack:`, `vscode:`): vorher fragen, Origin und Ziel-App zeigen, pro Origin und Scheme merkbar. `file:` und `smb:` nie.

**Sicherheit im Alltag**
- Zertifikatsfehler: eigene Warnseite, kein „Trotzdem fortfahren“ bei HSTS-Hosts. Ausnahmen pro Origin nur für lokale Origins (mkcert, selbstsignierte Dev-Zertifikate).
- **Schutz vor Phishing und Malware:** Electron hat kein Google Safe Browsing. v1 nutzt Malware- und Phishing-Filterlisten (z. B. URLhaus, Phishing URL Blocklist) über die Adblock-Engine, mit Warnseite. v2 prüft die Google Web Risk API (für kommerzielle Nutzung gedacht, Hash-Präfix-Verfahren) über Mindeck Cloud.
- Adblock und Tracker-Blocker (`@ghostery/adblocker-electron`), standardmäßig an, pro Site abschaltbar, Zähler in der Toolbar.

**Session-Restore:** Spaces, Tabs, Reihenfolge, aktive Tabs, Scrollposition, Zoom und Container überstehen Neustart und Absturz. Tabs laden erst beim Aktivieren, damit der Start auch mit 100 Tabs schnell bleibt.

**Bekannte Lücken mit automatischem Handoff** (Erkennung → Chip „In Arc öffnen“):

| Lücke | Erkennung | Option für v2 |
|---|---|---|
| DRM-Streaming (Netflix, Spotify Web, Prime Video) | `requestMediaKeySystemAccess` schlägt fehl, bekannte Domains | castlabs-Electron (Widevine, VMP-Signierung) prüfen |
| Passkeys / Touch ID | WebAuthn-Anfrage mit Plattform-Authenticator | Apple-Entitlement für Browser-Passkeys prüfen |
| Google-Login-Sperre | „Dieser Browser ist möglicherweise nicht sicher“ auf accounts.google.com | UA und Client Hints nachziehen (S2) |
| Seite verlangt eine Erweiterung | bekannte Muster | Extensions-Experiment (Säule F) |
| Seitenübersetzung | kein eingebauter Übersetzer | „Seite übersetzen“ über den Mindeck-Assistenten |

---

## 5. Säule B: Dev-Loop (das Verkaufsargument)

### 5.1 Dev-Server-Erkennung

Drei Quellen, ein Ergebnis `DevServer { projectId, url, port, source, framework?, status }`:

1. **PTY-Output** aus `TerminalService` und Agent-Sitzungen. Muster für Vite, Next.js, Astro, Nuxt, SvelteKit, Remix, Webpack, Rails, Django, Flask, Laravel, Storybook, Expo Web, `python -m http.server` und ein generisches `listening on …` (Startliste in Anhang C). ANSI-Codes vorher entfernen.
2. **Ports ohne Mindeck-Terminal** (z. B. aus iTerm oder Warp gestartet): `lsof -iTCP -sTCP:LISTEN -nP -F pcn` über den Command-Service (§8.1), dann PID → `cwd` (`lsof -a -p <pid> -d cwd -Fn`) → Abgleich mit Projekt-Roots. Läuft nur auf Anfrage und alle 5 s, solange das Browser-Modul sichtbar ist.
3. **Mindecks eigener `LiveServerService`** öffnet künftig im Mindeck-Browser statt im System-Browser.

Ergebnis: Chip „localhost:5173 öffnen“ im Dock und in der Projektansicht. Automatisches Öffnen pro Projekt einstellbar.

### 5.2 Preview-Tabs

- An Projekt und Port gebunden. Ist der Server neu gestartet oder noch nicht bereit, erscheint statt Chromes Fehlerseite „Warte auf localhost:5173 …“ mit automatischem Retry (Backoff bis 10 s).
- Wechselt der Port (5173 belegt → 5174), folgt der Tab dem Server des Projekts.
- Badge mit Fehlerzähler am Tab. Preview-Tabs werden nie verworfen.

### 5.3 Fehler → „Fix mit Agent“

- Gesammelt werden Console-Errors, unbehandelte Promise-Rejections, Framework-Overlays, fehlgeschlagene Requests (4xx/5xx, CORS, Netzwerkfehler) und Renderer-Crashes. Dedupliziert nach Nachricht und Quelle, mit Zähler und Zeitpunkt.
- Sie fließen zusätzlich in die Problems-Liste des Editors (`useProblems`), ein Klick springt in die Datei.
- **„Fix mit <Agent>“** nimmt die laufende Sitzung des Projekts (sonst Schnellauswahl Claude, Codex, Gemini, Assistent, auf Wunsch als neue Sitzung im Worktree) und schickt einen strukturierten Auftrag:

  ```
  Fehler: TypeError: Cannot read properties of undefined (reading 'map')
  Ort: src/components/PriceList.tsx:27:18 (über Source-Map aufgelöst)
  Route: http://localhost:5173/pricing
  Letzte Console-Ausgaben (8), fehlgeschlagener Request: GET /api/prices → 500 (Auszug der Antwort)
  Screenshot: angehängt
  ```

- **Quellauflösung** (`SourceMaps.ts`): Stack-URLs werden zu Projektdateien (`/src/…` bei Vite, `/@fs/…`, `webpack-internal:///./src/…`, `/_next/static/chunks/…` plus `.map`). Source-Maps werden nur vom Origin des Tabs geholt (`net.fetch` im Main), nur für lokale Origins, und Pfade über `lib/confine.ts` auf das Projekt begrenzt. Abhängigkeit: `source-map-js` (klein, ohne WASM).

### 5.4 Element → Code (Inspector)

- Der Picker nutzt CDP `Overlay.setInspectMode` (Chromiums eigener Hover-Rahmen wie in DevTools) und das Event `Overlay.inspectNodeRequested`. Es wird kein eigenes Picker-Skript in die Seite geladen.
- `ElementContext` enthält: Kandidaten `Datei:Zeile` mit Konfidenz (erst Framework-Hooks laut S4, dann Source-Map, dann Suche nach Text oder `data-testid` im Repo über `FilesService`), die Komponentenkette (`App > Layout > Hero > Button`), Selektor, Rolle und zugänglichen Namen, gekürztes `outerHTML` (Formularwerte entfernt), relevante berechnete Styles und einen Screenshot-Ausschnitt mit Markierung.
- UI: Eine Prompt-Blase direkt am Element („Was soll sich ändern?“) schickt an die aktive oder eine neue Sitzung. Mehrere Elemente lassen sich sammeln („diese drei Karten angleichen“).
- Nach der Änderung lädt HMR nach, Mindeck macht einen Screenshot desselben Elements → **Vorher/Nachher-Schieberegler im Chat**.

### 5.5 Rückkanal nach jedem Agent-Edit (Claude Code)

- Claude Codes `PostToolUse`-HTTP-Hook ist bereits angebunden (`claudeLaunch.ts`). Ändert ein `Edit` oder `Write` eine Datei in einem Projekt mit offenem Preview-Tab, wartet Mindeck, bis HMR fertig ist (Network-Idle 500 ms, höchstens 3 s), und antwortet mit `hookSpecificOutput.additionalContext`: nur **neue** Fehler seit dem Edit, höchstens 1.500 Zeichen, sonst nichts. Feldnamen vor der Umsetzung gegen die aktuelle Hook-Doku von Claude Code prüfen.
- Pro Sitzung abschaltbar („Browser-Feedback an Agent“), standardmäßig an, sobald die Sitzung einen Preview-Tab hat. Höchstens alle 10 s.
- Codex und Gemini (ACP) haben keinen solchen Hook. Sie nutzen `browser_console`, und die Anweisung des MCP-Servers weist darauf hin.

### 5.6 Geräte, Emulation, Vergleich (Phase 5)

- **Gerätemodus:** Viewport-Presets (iPhone, Pixel, iPad, Laptop, 4K) mit Touch-Emulation über CDP `Emulation.setDeviceMetricsOverride`.
- **Multi-Viewport:** dieselbe URL in drei Breiten nebeneinander, Scrollen und Navigation synchron.
- **Emulation pro Tab:** hell/dunkel (`prefers-color-scheme`), reduzierte Bewegung, Netzwerk- und CPU-Drosselung, Sprache, Zeitzone.
- **Vergleich:** localhost neben Staging oder Produktion, synchron gescrollt, Pixel-Diff als Overlay.

### 5.7 Flows: aufnehmen, abspielen, testen (Phase 5)

- **Aufnehmen:** Ein Recorder in einer isolierten Welt (`Page.addScriptToEvaluateOnNewDocument` mit `worldName`) erfasst Klicks, Eingaben und Navigation mit stabilen Locatoren (Rolle + Name, `data-testid`, Text, CSS nur als letzter Ausweg). Passwortfelder werden als `{{secret:NAME}}` gespeichert, nie als Wert.
- **Ablage:** `<projekt>/.mindeck/flows/<name>.json`, also im Repo und teilbar.
- **Abspielen** über `Automation.ts`, sichtbar oder im Hintergrund. Agent-Tool `browser_run_flow` als Smoke-Test nach Änderungen („Login, Checkout, Logout laufen noch“).
- **Export als Playwright-Test** (`tests/e2e/<name>.spec.ts`), deterministisch erzeugt. Ein Agent kann ihn danach verfeinern.
- **Secrets:** `{{secret:…}}` kommt pro Projekt aus dem `SecretStore` und wird erst beim Ausführen eingesetzt. Der Agent sieht den Wert nie.

### 5.8 Best-of-N (Phase 5)

Mindeck kann Aufgaben parallel an Claude, Codex und Gemini in eigenen Worktrees geben (ANALYSE §7). Der Browser macht daraus ein sichtbares Feature: Jeder Worktree startet seinen Dev-Server auf einem eigenen Port, die Previews stehen nebeneinander, der User klickt „Diese übernehmen“. Das geht nur, weil Mindeck die Agents mehrerer Anbieter vereint.

---

## 6. Säule C: Agent-nativ

### 6.1 Tab-Zustände (am Tab sichtbar)

| Zustand | Bedeutung | Markierung |
|---|---|---|
| **Privat** | Agents sehen weder Inhalt noch URL | keine |
| **Geteilt** | Agents dieses Projekts dürfen lesen (Snapshot, Screenshot, Console). Handeln nur nach Matrix | Auge |
| **Agent-Tab** | vom Agent geöffnet oder gesteuert | farbiger Rand, Agent-Icon, Container-Farbe |

Standard: Preview-Tabs (lokal) sind für die Agents ihres Projekts geteilt, alles andere ist privat. Geteilt wird per Klick, per `@tab` im Chat oder über „An Agent senden“. Diese bewusste Handlung gilt als Zustimmung für diesen Tab.

### 6.2 Origin-Klassen (`Policy.ts`, deterministisch)

| Klasse | Definition |
|---|---|
| `local` | `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, erkannte Dev-Server, Mindecks Live-Server |
| `project` | Origins, die der User mit dem Projekt verknüpft hat (Staging, Preview-Domains, Admin), plus automatisch erkannte Deploy-Domains |
| `web` | alles andere |
| `sensitive` | eingebaute Liste (Banking, Zahlungsdienste, E-Mail-Postfächer, Passwortmanager, Gesundheit, Behörden, IAM-Bereiche von Cloud-Konsolen) und eigene Einträge |

### 6.3 Berechtigungsmatrix

Die Stufen folgen §9 (`safe` / `confirm` / `dangerous`). Im Code heißen sie heute `ToolRisk` (`read`/`write`/`execute`) plus `allowAlways` an der `PermissionRequest`. `Policy.ts` liefert pro Aufruf `{ ask, allowAlways, scope }`.

| Werkzeug | local | project | web | sensitive |
|---|---|---|---|---|
| lesen (`snapshot`, `read`, `screenshot`, `console`, `network`) | safe | confirm, „Immer“ pro Origin + Projekt | confirm, „Immer“ pro Origin | dangerous (nur einmalig) |
| öffnen / navigieren | safe | safe | confirm, „Immer“ pro Origin | dangerous |
| handeln (`click`, `type`, `select`, `press`, `scroll`, `hover`, `drag`) | confirm, „Immer“ pro Projekt | confirm, „Immer“ pro Origin + Projekt | confirm, „Immer“ pro Origin | dangerous |
| `eval` | confirm, „Immer“ pro Projekt | dangerous | dangerous | gesperrt |
| `upload` (Datei aus dem Projekt) | confirm | confirm | dangerous | gesperrt |

Zusatzregeln:

- **Folgenreiche Klicks** werden außerhalb von `local` immer einzeln gefragt, auch wenn ein Grant besteht. Gemeint sind Buttons, Links und Formular-Submits, deren Name auf Kaufen, Bezahlen, Bestellen, Senden, Veröffentlichen, Löschen, Entfernen, Mergen, Deployen, Bestätigen, Kündigen oder Einladen passt (de und en, Liste in `Policy.ts`).
- Grants weiten sich nie aus (§9). Ein neuer Origin nach einer Weiterleitung wird neu geprüft.
- `file:`, `chrome:`, `devtools:` und `data:` sind für Agents gesperrt.
- Nie über Tools heraus: Cookies, `localStorage`, `sessionStorage`, IndexedDB, Header-Werte, Werte aus `type=password`, `autocomplete=cc-*` und `one-time-code`. Solche Felder erscheinen im Snapshot als `[geschützt]`. In Passwortfelder tippt ein Agent nur über `{{secret:…}}`, und nur auf `local` oder in Containern.
- **Eine einzige Freigabestelle:** Mindeck prüft selbst in `tools/call`. Für Claude Code werden die `browser_*`-Tools über `--allowedTools` namentlich vorab erlaubt (kein Wildcard), damit es keine Doppelabfrage gibt. Für ACP-Agents gilt dasselbe.

### 6.4 Visuelle Freigaben

Die Freigabekarte zeigt nicht „browser_click e42“, sondern **einen Screenshot-Ausschnitt mit markiertem Ziel**, den Origin, den Namen des Elements und bei `type` den einzugebenden Text. Buttons: „Einmal“, „Immer für vercel.com in diesem Projekt“, „Ablehnen“. Auf dem Handy erscheint dasselbe Bild (Phase 6).

### 6.5 Agent-Tools (ToolRegistry + MCP-Server)

| Tool | Zweck |
|---|---|
| `browser_tabs` | geteilte Tabs, Agent-Tabs und Preview-Tabs des Projekts (private erscheinen nicht) |
| `browser_open` | URL in einem Agent-Tab öffnen (Container laut Projekteinstellung) |
| `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload` | Navigation |
| `browser_snapshot` | Accessibility-Baum als Text mit Refs (`e12`), optional nur ein Teilbaum. **Inkrementell:** Der zweite Aufruf liefert nur die Änderungen und spart Tokens |
| `browser_read` | Seite als Markdown (Leseansicht), der günstigste Weg zu Inhalten |
| `browser_screenshot` | Viewport, ganze Seite oder ein Element (Ref), als MCP-Bildinhalt |
| `browser_console`, `browser_network` | seit dem Laden oder seit einer Marke, gefiltert nach Level oder Status |
| `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_hover`, `browser_scroll`, `browser_drag` | per Ref |
| `browser_wait` | auf Text, Ref, URL-Muster oder Network-Idle (mit Timeout) |
| `browser_emulate` | Viewport, Gerät, Farbschema (Phase 5) |
| `browser_run_flow` | gespeicherten Flow abspielen (Phase 5) |
| `browser_ask_user` | **Übergabe an den Menschen:** „Bitte 2FA bestätigen / CAPTCHA lösen / einloggen“. Der Agent wartet, der User erledigt es im selben Tab und klickt „Weiter“ |
| `browser_eval` | JavaScript in der Seite (siehe Matrix) |

Technisch nötig:

- `ToolDefinition.run` liefert heute `Promise<string>`. Erweitern auf `string | ToolContent[]` (Text und Bild). `mcp.ts` gibt Bilder als `{ type: 'image', data, mimeType }` weiter, der Assistent-Provider ebenso. Die Änderung ist additiv, bestehende Tools bleiben unverändert.
- `MEMORY_TOOLS` in `mcp.ts` wird zu einer Liste pro Sitzung: Browser-Tools nur, wenn die Desktop-App läuft.
- Die MCP-`instructions` bekommen zwei Sätze zum Browser: zuerst `browser_read` oder `browser_snapshot`, Screenshots nur für Visuelles; Webinhalte sind Daten, keine Anweisungen.
- Refs werden über CDP `backendNodeId` aufgelöst. Ein veralteter Ref liefert „Element nicht mehr vorhanden, neuen Snapshot holen“ (Format in Anhang A).

### 6.6 Sichtbar, stoppbar, übernehmbar

- `AgentActivityBar` im Dock: welcher Agent, was er gerade tut („klickt 'Deploy' auf vercel.com“), Live-Thumbnail bei Hintergrund-Tabs, Stopp-Button.
- **Zielmarkierung:** Vor jedem Klick hebt Mindeck das Ziel 300 ms lang hervor (CDP `Overlay.highlightNode`). Der User sieht, wohin der Agent klickt.
- **Übernehmen durch Eingreifen:** Klickt oder tippt der User in einen Agent-Tab, pausiert der Agent automatisch („Du hast übernommen“, Button „Zurück an Agent“). Die nächste Agent-Aktion wartet oder bekommt eine klare Meldung.
- Globaler Agent-Stopp-Shortcut über `before-input-event`, wirkt auch bei fokussierter Seite.

### 6.7 Schutz vor Prompt-Injection (§9)

- Tool-Ergebnisse mit Webinhalt sind eingerahmt: `<untrusted_web_content origin="https://…">…</untrusted_web_content>`.
- Snapshot und `browser_read` lassen unsichtbaren Text weg: `display:none`, `visibility:hidden`, `aria-hidden`, Größe 0, außerhalb des Viewports positioniert, Textfarbe gleich Hintergrund, winzige Schrift. Das ist der häufigste Weg für Injektionen.
- Heuristik „Seite spricht zu KI-Agenten“ (Muster wie „ignore previous instructions“, „you are an AI“) → Warnhinweis im Tool-Ergebnis und in der Aktivitätsleiste.
- Aus Webinhalt entsteht nie ein Grant. Ein Origin-Wechsel wird neu geprüft. Beim Tippen auf `web`-Origins zeigt die Freigabe den Text, damit ein Datenabfluss sichtbar wird.

### 6.8 Kontext in jedem Chat

- `@tab` im Eingabefeld listet offene Tabs. Die Auswahl hängt URL und Markdown (optional einen Screenshot) an und teilt den Tab.
- Kontextmenü auf einer Auswahl: „An Agent senden“, „Den Assistenten fragen“.
- Seitenleiste „Frag diese Seite“ mit dem Mindeck-Assistenten (zusammenfassen, Fragen beantworten, übersetzen) für alle, die nicht programmieren. Inhalte gehen nur nach einer ausdrücklichen Aktion hinaus.

### 6.9 Aufzeichnungen (Phase 3)

- Jede Browser-Sitzung eines Agents wird als Zeitleiste gespeichert: Aktion, Ref und Name, URL, Screenshot danach (JPEG, verkleinert), Ergebnis. Im Chat aufklappbar („Was hat der Agent im Browser getan?“).
- Export als GIF oder WebM (Frames aus CDP `Page.startScreencast`). Teilbare Clips sind Marketing: „Mein Agent hat diesen Bug in 40 s gefixt.“
- Audit: jede Aktion als `tool.*`-Event mit Origin, Ref und Entscheidung.

---

## 7. Säule D: Projektbewusstsein

- **Spaces = Projekte** (siehe Säule A).
- **Projekt-Links automatisch:** Repo (`GitService.webUrl`), offene PRs mit CI-Status (`GitHubService`), Actions, Issues, Deploy-URLs (aus `.vercel/project.json`, `vercel.json`, `netlify.toml`, `fly.toml`, `package.json#homepage`), Doku des erkannten Stacks, Dev-Server.
- **Neuer Tab = Projekt-Startseite:** Dev-Server mit Status, PRs mit Checks, zuletzt besucht, angeheftete Links und ein Eingabefeld „Was soll der Agent im Browser prüfen?“.
- **Site-Actions** (`SiteActions.ts`, deklarativ: URL-Muster → Extraktor → Aktion). Erste Liste:

  | Seite | Erkennung | Chip |
  |---|---|---|
  | GitHub PR | `github.com/<o>/<r>/pull/<n>` eines bekannten Repos | „Lokal auschecken und starten“, „Agent reviewen lassen“ |
  | GitHub Actions (fehlgeschlagen) | `…/actions/runs/<id>` | „Fehler mit Agent lösen“ (Log über `gh run view --log-failed`) |
  | Vercel/Netlify-Deploy (fehlgeschlagen) | Deploy-Seite | „Build-Log an Agent“ |
  | Sentry-Issue | `sentry.io/…/issues/<id>` | „Fix mit Agent“ (Stacktrace aus der Seite) |
  | Linear-, Jira- oder GitHub-Issue | Ticket-URL | „Agent mit diesem Ticket starten“ |
  | Stack Overflow, Doku-Seiten | Domain | „Im Projekt anwenden“ |

  Mindeck liest diese Daten nur auf Klick (bewusste Handlung) und bevorzugt `gh` oder APIs statt des DOM.
- **PR-Previews:** Vercel- und Netlify-Preview-URLs aus PR-Checks und -Kommentaren → „Preview öffnen“ neben localhost.
- **Split-Layouts:** Browser, Agent-Chat und Editor nebeneinander, mit Presets wie beim Terminal (z. B. „Dev-Layout“: Editor links, Browser rechts, Agent unten). Mehrere Views sind gleichzeitig sichtbar (mehrere Bounds).
- **Projekt-Container und Test-Identitäten** (siehe 3.5).

---

## 8. Säule E: Umstieg (Import, Handoff, Standardbrowser)

### 8.1 Import (Phase 4)

Ablauf: Erster Start → „Wir haben **Arc** als deinen Browser erkannt. Lesezeichen, Verlauf und Logins übernehmen?“ → Profil wählen → Datenarten wählen → Fortschritt → „Du bist jetzt auf 34 Seiten eingeloggt“ (die konkrete Zahl ist der Wow-Moment).

| Browser | Profil (macOS) | Lesezeichen | Verlauf | Cookies | Keychain-Eintrag |
|---|---|---|---|---|---|
| Chrome | `~/Library/Application Support/Google/Chrome/<Profil>/` | `Bookmarks` (JSON) | `History` (SQLite) | `Cookies` (SQLite, verschlüsselt) | Chrome Safe Storage |
| Arc | `~/Library/Application Support/Arc/User Data/<Profil>/`, Spaces und Pins in `~/Library/Application Support/Arc/StorableSidebar.json` | Sidebar-JSON | wie Chrome | wie Chrome | Arc Safe Storage |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser/<Profil>/` | wie Chrome | wie Chrome | wie Chrome | Brave Safe Storage |
| Edge | `~/Library/Application Support/Microsoft Edge/<Profil>/` | wie Chrome | wie Chrome | wie Chrome | Microsoft Edge Safe Storage |
| Vivaldi, Opera, Chromium, Dia, Comet | Chromium-Layout | wie Chrome | wie Chrome | wie Chrome | je Browser |
| Firefox, Zen | `~/Library/Application Support/Firefox/Profiles/<x>/` (Zen analog) | `places.sqlite` | `places.sqlite` | `cookies.sqlite` (unverschlüsselt) | – |
| Safari | `~/Library/Safari/` | `Bookmarks.plist` | `History.db` | `Cookies.binarycookies` | v2, braucht Festplattenvollzugriff |

Alle Pfade und Keychain-Namen vor der Umsetzung gegen echte Installationen prüfen (Teil von S5).

**Arc-Spezial:** Arc-Spaces werden Mindeck-Spaces. Die Zuordnung zu Projekten passiert automatisch, wenn angeheftete Tabs auf das Git-Remote eines Mindeck-Projekts zeigen (z. B. `github.com/acme/shop` ↔ Projekt „shop“). Sonst gibt es einen Vorschlag nach Namensähnlichkeit, den der User bestätigt.

**Chromium-Cookies entschlüsseln (macOS):**
1. Schlüssel aus dem Keychain holen: `execFile('security', ['find-generic-password', '-w', '-s', name])`. macOS zeigt den Keychain-Dialog. Das ist gewollt und transparent, derselbe Weg wie beim „Import aus Chrome“ in Arc oder Edge.
2. Key = PBKDF2-HMAC-SHA1(Passwort, Salt `saltysalt`, 1003 Iterationen, 16 Byte).
3. Werte mit Präfix `v10`: AES-128-CBC, IV = 16 × `0x20`. Ab `meta.version >= 24` die ersten 32 Byte des Klartexts (SHA-256 der Domain) abschneiden.
4. Mit `cookies.set()` in `persist:mindeck-browser` übernehmen (secure, httpOnly, sameSite, expires, Regeln für `__Host-` und `__Secure-`). Abgelaufene überspringen. Ergebnis pro Domain zählen.

Weitere Regeln:
- DB-Dateien samt `-wal` und `-journal` in ein Temp-Verzeichnis kopieren (der Browser sperrt sie) und danach löschen.
- Den Schlüssel nie loggen oder speichern, nach dem Import verwerfen. Fehler werden pro Datenart gemeldet und brechen den Import nie ganz ab.
- **Unbekanntes Format** (neue Präfixe wie `v11` oder `v20`, neue DB-Version): sauber scheitern mit „Logins aus dieser Chrome-Version können wir noch nicht übernehmen“, Lesezeichen und Verlauf trotzdem importieren.
- **Windows:** Chrome verschlüsselt dort mit App-Bound Encryption (`v20`). Unter Windows gibt es keinen Cookie-Import aus Chromium-Browsern, nur Lesezeichen und Verlauf. Firefox geht überall.
- **Gerätegebundene Sitzungen** (z. B. Googles DBSC) überleben den Import nicht. Die UI sagt das vorher („Google fragt dich einmal neu“).
- Passwörter (`Login Data`) werden in v1 nicht importiert (siehe 8.5).
- Verlauf: höchstens die 20.000 Einträge mit der höchsten Frecency, in `history/imported.jsonl`.
- Der Import lässt sich jederzeit in den Einstellungen wiederholen. Mindeck-Lesezeichen lassen sich als HTML (Netscape-Format) exportieren, damit es keinen Lock-in gibt.

### 8.2 System-Browser und Handoff

- `app.getApplicationInfoForProtocol('https://')` liefert Name, Pfad und Icon. Der Button „In Arc öffnen“ (Name und Icon dynamisch) steht in der Toolbar, im Kontextmenü und in jedem Handoff-Chip.
- Geöffnet wird über `execFile('open', ['-a', path, url])` bzw. das Äquivalent der Plattform.
- Ist Mindeck selbst Standardbrowser, zeigt der Button auf den **gemerkten** vorherigen Browser.

### 8.3 Mindeck als Standardbrowser (Phase 4)

- `electron-builder.yml`: `protocols` für `http` und `https`, `fileAssociations` für `.html`, `.htm` und `.webloc`, damit `CFBundleURLTypes` und `CFBundleDocumentTypes` stimmen.
- `app.setAsDefaultProtocolClient('http')` und `('https')` nach Klick in den Einstellungen. macOS fragt den User systemseitig.
- `open-url` (auch beim Kaltstart: URLs puffern, bis der BrowserService bereit ist) und `open-file` für `.html`.
- **Link-Router:** Regeln, wohin ein Link geht, z. B. „github.com/acme/* → Space shop“, „meet.google.com → System-Browser“, „localhost:* → Projekt-Space“, sonst „aktueller Space“.
- **Peek:** Links von außen öffnen optional in einem kleinen schwebenden Fenster (wie „Little Arc“). Enter übernimmt als Tab, Esc schließt. Das senkt die Hürde, Mindeck zum Standard zu machen.
- In den Einstellungen an- und abschaltbar, mit Rückfall auf den gemerkten Browser.

### 8.4 OAuth-Popups

Popups mit `window.opener` („Sign in with GitHub/Google/Apple/Microsoft“) laufen als echtes kleines `BrowserWindow` in derselben Partition und schließen sich nach Abschluss selbst. Alle anderen Popups werden Tabs (`setWindowOpenHandler`).

### 8.5 Passwörter

- **v1:** kein eigener Passwortmanager. Logins kommen über den Cookie-Import. Für neue Logins gibt es 1Password oder Bitwarden als Desktop-App mit Universal Autofill (macOS), sonst den Handoff.
- **v2:** ein minimaler Manager: Speichern-Angebot nach dem Login, Ablage im OS-Keychain über `SecretStore`, Autofill nur nach Klick und **nie** für Agents. Dann auch Import aus Chromes `Login Data` mit eigenem Keychain-Dialog.

---

## 9. Säule F: Extras

- **Seite → Vault:** „Als Notiz speichern“ legt URL, Titel und Auszug als Markdown ab, Markierungen als Zitate, mit Backlink zum Projekt. Im Recherche-Modus sammelt ein Agent Quellen in einer Notiz.
- **Leseansicht** (dieselbe Extraktion wie `browser_read`).
- **Screenshot-Werkzeug:** Bereich oder ganze Seite (CDP `captureBeyondViewport`), annotieren, in die Zwischenablage oder an einen Agent.
- **RAM und CPU pro Tab im System-Modul** (`app.getAppMetrics()` ↔ `webContents.getOSProcessId()`), mit „Tab beenden“. Nutzt Mindecks vorhandene Telemetrie.
- **Systemweiter Hotkey** „Frag zur aktuellen Seite“.
- **Chrome-Erweiterungen** (`electron-chrome-extensions`) als Experiment hinter einem Schalter: uBlock, React DevTools, Vue DevTools.
- **Cloud-Sync** von Tabs und Lesezeichen sowie **„Tab vom Handy öffnen“** über Mindeck Cloud (Kandidat für ein Pro-Abo).
- **Vom Handy zuschauen:** CDP-Screencast des Agent-Tabs in Web-UI und Mobile-App, visuelle Freigaben dort beantworten (Phase 6).

---

## 10. Sicherheitsmodell (Überblick)

| Bedrohung | Maßnahme |
|---|---|
| Chromium-Lücke | unterstützte Electron-Version, Update binnen 7 Tagen, Auto-Update |
| Webseite erreicht Mindeck-APIs | kein Preload in Tabs, eigene Partition, Router verwirft Aufrufe aus fremden `senderFrame`s, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, Site-Isolation nie abschalten |
| Phishing und Malware | Filterlisten (v1), Web Risk (v2), Warnseiten, Download-Quarantäne, Warnung bei ausführbaren Dateien |
| Externe Protokolle | Nachfrage mit Ziel-App, nie `file:` oder `smb:` |
| Agent richtet mit echten Logins Schaden an | Tab-Zustände, Origin-Klassen, Wegwerf-Container als Standard, folgenreiche Klicks immer fragen, sensible Domains gesperrt, Stopp, Übernahme, Audit |
| Prompt-Injection | siehe 6.7 |
| Datenabfluss über Agents | keine Cookies, Storage, Passwörter oder Header über Tools; Eingaben auf fremden Origins in der Freigabe sichtbar |
| Schlüssel beim Import | nur im Speicher, nie geloggt, Keychain-Dialog vom System |
| Privatsphäre | Verlauf und Aufzeichnungen lokal, keine URL-Telemetrie, „Verlauf löschen“ mit Zeitraum, privates Fenster |

---

## 11. Phasen (nach Wert sortiert)

Jede Phase läuft end-to-end (Service, IPC, UI im Mindeck-Design), die App bleibt startfähig, die Tests sind grün, und `Mindeck_ARCHITECTURE.md` bekommt einen Abschnitt `§12.x Browser`.

### Phase 0: Fundament
Gates aus 2.1, Spikes S1–S6, Entscheidungen in `docs/browser/SPIKES.md`.
**Fertig, wenn:** Electron aktuell ist, Navigationsschutz und `senderFrame`-Prüfung getestet sind, Grants einen Scope haben, ein Meet-Testanruf mit Kamera im signierten Build klappt und alle Spikes entschieden sind.

### Phase 1: Dev-Preview mit Agent-Zugriff (launchfähig als Beta)
- BrowserService, ViewHost, Sessions (Hauptprofil), Guard (Schemes, Zertifikate), Overlays (drei Klassen), Shortcuts über App-Menü und `before-input-event`, horizontale Tabs, einfache Befehlsleiste (URL, Suche, Verlauf), Navigation, Session-Restore, UA-Fix, OAuth-Popups.
- Dev-Server-Erkennung (PTY und LiveServer, `lsof` folgt in Phase 2), Preview-Tabs mit Auto-Retry, PageWatch, Fehler → „Fix mit Agent“ mit Source-Maps.
- Agent-Tools für `local`: `browser_tabs`, `open`, `navigate`, `snapshot`, `read`, `screenshot`, `console`, `network`, `click`, `type`, `press`, `wait`. MCP-Bildinhalte. Activity-Bar mit Zielmarkierung und Stopp.
- Inspector v1 (React, Vue, Svelte laut S4) mit Prompt-Blase und Vorher/Nachher.
- Rückkanal nach Agent-Edit (Claude Code).

**Fertig, wenn:** Demo-Momente 1, 2 und 3 auf den Fixture-Apps (Vite+React, Next.js) und auf Mindeck selbst funktionieren, Toasts ohne Freeze im Dock erscheinen und der GitHub-Login klappt.
**Warum zuerst:** Diesen Teil hat kein Wettbewerber in dieser Form, und er ist kleiner als ein kompletter Browser. Er gibt der 7-Stunden-Trial ihren Aha-Moment.

### Phase 2: Alltagsbrowser
Alles aus Säule A: Downloads mit Quarantäne, native Kontextmenüs, Suchen, Zoom, Drucken, Permissions mit TCC, Bildschirmfreigabe, Notifications, externe Protokolle, Zertifikats-Warnseite, Adblock und Malware-Listen, Verlauf und Lesezeichen, die vollständige Befehlsleiste (Frecency, Tab-Wechsel, Site-Search, Stack-Kürzel), vertikale Tabs, Spaces = Projekte, angeheftete Tabs, Discard, Projekt-Startseite, Split-Layouts, Erkennung der Handoff-Fälle, `lsof`-Erkennung.
**Fertig, wenn:** eine Arbeitswoche ohne Chrome möglich ist (außer den Handoff-Fällen), die Login-Matrix (12.3) grün ist, 30 Tabs höchstens 20 % mehr RAM brauchen als in Chrome und der Tabwechsel unter 50 ms bleibt.

### Phase 3: Agent im echten Web
Origin-Klassen, Tab-Zustände, Matrix, sensible Liste, folgenreiche Klicks, Container und Agent-Identität, visuelle Freigaben, `browser_ask_user`, Übernehmen durch Eingreifen, Filter gegen Prompt-Injection, `@tab`, Site-Actions (GitHub, Actions, Vercel, Sentry, Linear), Aufzeichnungen mit GIF-Export, Assistent-Seitenleiste.
**Fertig, wenn:** Demo-Momente 4 und 5 funktionieren, jede Aktion außerhalb von `local` nach Matrix gefragt wird und die Sicherheits-E2E-Tests (12.2) grün sind.

### Phase 4: Umstieg
Import (Chromium-Familie, Arc mit Spaces-Zuordnung, Firefox), Onboarding, Handoff-Button, Standardbrowser, Link-Router, Peek, Lesezeichen-Export.
**Fertig, wenn:** der User nach dem Import auf GitHub, Vercel, Notion, Linear und Slack ohne neuen Login eingeloggt ist und ein Link aus Slack im richtigen Space öffnet.

### Phase 5: Werkzeuge für Entwickler
Gerätemodus und Multi-Viewport, Emulation, Vergleich mit Pixel-Diff, Flows (Aufnahme, Abspielen, Playwright-Export, Secrets), Best-of-N-Previews, PR-Previews.
**Fertig, wenn:** ein aufgenommener Checkout-Flow als Playwright-Test in CI läuft und drei Agent-Worktrees ihre Previews nebeneinander zeigen.

### Phase 6: Reichweite
Handy (Screencast und Freigaben), Cloud-Sync, Seite → Vault und Recherche-Modus, Übersetzen, Web Risk, Extensions-Experiment, Passwortmanager v2, DRM-Entscheidung, Besonderheiten von Windows und Linux.

### So arbeitet Claude Code eine Phase ab
1. Die Pflichtabschnitte (oben) und diesen Plan lesen, dann eine Checkliste `docs/browser/PHASE-<n>.md` anlegen (Dateien, Kanäle, Tests, Fertig-Kriterien).
2. Contract und Schemas zuerst, dann Service, dann IPC, dann UI. Jede Teilfunktion mit Unit-Tests, die Phase mit E2E-Tests.
3. Abweichungen vom Plan in der Checkliste begründen, nicht stillschweigend umsetzen.
4. Zum Abschluss `npm run typecheck`, `npm test`, die betroffenen E2E-Tests und den Abschnitt in `Mindeck_ARCHITECTURE.md`.

---

## 12. Tests

### 12.1 Unit (vitest)
Cookie-Entschlüsselung (Fixture-DBs, fester Testschlüssel, DB-Versionen < 24 und ≥ 24, unbekanntes Präfix), Lesezeichen-Parser (Chrome-JSON, Arc-Sidebar, Firefox), Arc-Space-Zuordnung, Frecency-Ranking, Site-Search-Kürzel, Origin-Klassen (inklusive `127.1`, `[::1]`, `*.localhost`, IDN und Punycode-Tricks), Berechtigungsmatrix, folgenreiche Klicks, Dev-Server-Muster (echte Ausgaben je Framework als Fixtures, mit ANSI), Source-Map-Auflösung (Vite, Webpack, Next.js), Snapshot-Serialisierung und -Diff, Filter für unsichtbaren Text, Link-Router-Regeln, Migration von `session.json`.

### 12.2 E2E (Playwright + Electron, bestehendes Setup)
- Ein Fixture-HTTP-Server mit Seiten für: normale Navigation, Console-Fehler, 500er-Request, Framework-Overlay, Formular mit Passwort, versteckte Injektion, Popup mit `opener`, Download, Kamera-Anfrage.
- Abläufe: Tab öffnen, navigieren, schließen, wiederherstellen; Freeze bei der Command-Palette, **kein** Freeze bei einer Toast; Shortcuts bei fokussierter Seite; „Fix mit Agent“ mit `fake-claude.mjs` (Snapshot → Click → Console); der Rückkanal-Hook liefert neue Fehler.
- **Sicherheit:** Eine Seite sieht `window.mindeck` nicht; IPC aus Tab-Frames wird verworfen; `file://` ist blockiert; ein Agent sieht private Tabs nicht; ein Passwortwert taucht in keinem Tool-Ergebnis auf; versteckter Injektionstext fehlt im Snapshot; ein Origin-Wechsel löst eine neue Prüfung aus.

### 12.3 Manuell und Benchmarks
- Login-Matrix: GitHub, Google (Gmail, Cloud Console, Meet), Microsoft/Entra, Apple-ID, Vercel, Stripe, AWS, Notion, Slack, Linear, Figma, Atlassian. Ergebnis als Tabelle in `docs/browser/LOGINS.md`, bei jedem Electron-Update neu prüfen.
- Leistungsbudgets: Tabwechsel < 50 ms, Befehlsleiste < 30 ms, Kaltstart mit 100 Tabs < 1,5 s bis bedienbar, RAM bei 30 Tabs höchstens Chrome + 20 %, Snapshot einer großen Seite < 300 ms und < 15.000 Tokens.
- Retina, Display-Wechsel, Vollbild, mehrere Monitore.

---

## 13. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Electron hinkt Chrome hinterher | Update binnen 7 Tagen, CI-Job, Release-Pipeline (ANALYSE §9) |
| Overlays werden verdeckt | Drei-Klassen-Modell ab Phase 1, Wächter im Dev-Modus |
| Google und andere blockieren den Login | UA und Client Hints (S2), OAuth-Popups, automatischer Handoff, Login-Matrix bei jedem Release |
| CDP stört Seiten oder Bot-Schutz | CDP nur bei Bedarf, Trennen nach Leerlauf (S3) |
| Element → Code trifft daneben | Kandidaten mit Konfidenz, der Agent prüft per Suche nach; die Framework-Abdeckung wächst |
| Agent richtet mit Logins Schaden an | Wegwerf-Container als Standard, Matrix, folgenreiche Klicks, sensible Domains, Stopp, Audit |
| Prompt-Injection über Webseiten | siehe 6.7 |
| RAM bei vielen Tabs | Discard, Drosselung im Hintergrund, Anzeige pro Tab |
| DRM und Passkeys fehlen | Erkennung und Handoff, Optionen für v2 |
| Kein Safe Browsing | Filterlisten (v1), Web Risk (v2) |
| Chrome ändert das Cookie-Format | Versionsprüfung, sauberes Scheitern, Fixture-Tests; Windows bewusst ohne Cookie-Import |
| Kamera/Mikro im signierten Build | Gate in Phase 0 |
| Umfang zu groß | Jede Phase liefert einen verkaufbaren Stand, Phase 1 ist allein launchfähig |

---

## 14. Launch und Messgrößen

- **Story pro Phase:** Phase 1 = „Deine Agents sehen jetzt deinen localhost“ (Video aus Demo 1, 2 und 3). Phase 3 = „Agents im echten Web, mit Kontrolle“ (Demo 4 und 5). Phase 4 = „Von Arc zu Mindeck in 2 Minuten“ (eigene Landingpage, Spaces werden Projekte).
- **Aha-Moment in der Trial:** Das Onboarding erkennt einen laufenden Dev-Server oder bietet das Beispielprojekt an, öffnet es im Browser und baut einen Fehler ein, den ein Agent live behebt. Ziel: Aha-Moment in den ersten 10 Minuten der 7 Trial-Stunden.
- **Messen** (nur mit Opt-in, ANALYSE §8.4): Browser-Modul geöffnet → erster Preview-Tab → erstes „Fix mit Agent“ → erste Browser-Aktion eines Agents → Standardbrowser gesetzt → Kauf. Dazu: Anteil der Sitzungen mit Browser-Tools und Tage pro Woche mit Browser-Nutzung.
- **Preis** (Vorschlag, Entscheidung offen): Kern-Browser und Dev-Loop gehören zur Lizenz. Cloud-Sync, Zuschauen vom Handy und geteilte Aufzeichnungen passen zu einem Pro-Abo (ANALYSE §8.4).

---

## 15. Offene Entscheidungen

1. Ziel-Electron-Version und Update-Rhythmus. Vorschlag: immer die neueste Stable, Sicherheitsfixes binnen 7 Tagen.
2. Tabs standardmäßig horizontal (für Chrome-Umsteiger) oder vertikal (für Arc-Umsteiger)? Vorschlag: im Onboarding fragen und nach dem erkannten Browser vorbelegen.
3. Surft ein Agent auf fremden Seiten standardmäßig im Wegwerf-Container (Vorschlag) oder mit den echten Logins?
4. Welche Features gehören in ein Pro-Abo?
5. DRM über castlabs-Electron: ja oder nein? (Aufwand: Build-Kette und VMP-Signierung)
6. Name des Moduls: „Browser“ oder ein eigener Name?

---

## Anhang A: Snapshot-Format (Beispiel)

```
# http://localhost:5173/pricing · Titel: Pricing – Acme
- banner
  - link "Acme" [e1]
  - navigation
    - link "Pricing" [e2] (aktuell)
- main
  - heading "Choose your plan" [e3] (h1)
  - button "Monthly" [e4] (gedrückt)
  - button "Yearly" [e5]
  - group "Pro"
    - text "€29 / month"
    - button "Upgrade" [e6]
  - textbox "E-Mail" [e7] = "max@example.com"
  - textbox "Passwort" [e8] = [geschützt]
# Console: 1 Fehler seit dem Laden · Netzwerk: 1 fehlgeschlagen (GET /api/prices → 500)
```

## Anhang B: Tool-Definition (Skizze, passend zu `tools/types.ts`)

```ts
// electron/main/services/ai/tools/browser.ts
export const browserClick: ToolDefinition<{ tab?: string; ref: string; reason: string }> = {
  name: 'browser_click',
  title: 'Click in browser',
  description: 'Clicks an element from the latest browser_snapshot by its ref (e.g. "e12").',
  risk: 'write', // die effektive Stufe bestimmt Policy.ts aus Origin-Klasse und Tab-Zustand
  schema: z.object({ tab: z.string().optional(), ref: z.string().regex(/^e\d+$/), reason: z.string().max(200) }),
  summarize: (i) => `Click ${i.ref}`, // die Freigabekarte zeigt stattdessen Name und Screenshot des Ziels
  run: (input, ctx) => browser.click(input, ctx)
}
```

`PermissionGrant` (heute `agentId`, `toolName`, `createdAt`) wird additiv erweitert:

```ts
interface PermissionGrant {
  agentId: string
  toolName: string
  scope?: { projectId?: string; origin?: string }   // fehlt = alter, globaler Grant (wird bei Migration auf projectId eingeengt)
  createdAt: string
}
```

## Anhang C: Dev-Server-Muster (Startliste)

```
/\bLocal:\s+(https?:\/\/\S+)/i                                         Vite, Astro, SvelteKit, Nuxt, Next.js
/ready (?:started server )?on (?:[\d.:]+, )?url: (https?:\/\/\S+)/i    Next.js (ältere Versionen)
/Listening on (https?:\/\/\S+)/i                                       Rails/Puma
/Starting development server at (https?:\/\/\S+)/i                     Django
/Running on (https?:\/\/\S+)/i                                         Flask
/Server running on \[(https?:\/\/[^\]]+)\]/i                           Laravel
/Storybook .* started[\s\S]*?(https?:\/\/localhost:\d+)/i              Storybook
/(?:listening|running|available|started) (?:on|at) (?:port )?(\d{2,5})\b/i   generisch → http://localhost:<port>
```

Immer gegen echte Ausgaben als Fixtures testen und ANSI-Codes vorher entfernen.
