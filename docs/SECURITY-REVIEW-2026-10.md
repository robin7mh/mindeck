# Mindeck: Security-Review der Runde 2026-10 (Workspace-Ausbau)

**Stand:** 2026-10-15 · **Basis:** `feature/workspace-complete` (`d15e9ad`), geprüft gegen den Stand davor (`e8121f2`, ~37.600 neue Zeilen in 342 Dateien)
**Branch mit den Fixes:** `wip2/security`

**Bedrohungsmodell:** bösartige Webseite im eingebauten Browser, bösartige Extension, bösartiges Repo/Projekt,
gekoppeltes Gerät mit gestohlenem Token, Angreifer im LAN, bösartige Agent-Ausgabe/Prompt-Injection,
manipulierte Dateien im Datenordner (`~/Mindeck/data`).

Jeder Befund nennt Schwere, Fundstelle und den Fix-Commit (mit Regressionstest, 100 % Coverage der
geänderten Dateien) oder die Begründung, warum er nicht in dieser Runde behoben ist.

---

## 1. Kurzfazit

Die neue Fläche ist im Kern sauber gebaut: Jeder neue Kanal steht in `CHANNEL_ACCESS` (Browser, Finder,
Desktop, Extensions, Terminal-Profile und -Restore nur für das Desktop-Fenster; Pairing-Codes, Rollen,
KI-Schlüssel und Cloud-Login nur für Admin-Geräte), jede Payload läuft durch ein Zod-Schema mit
Längen- und Größenlimits, die Tab-Views sind sandboxed und ohne Bridge, CRX3-Pakete werden wie in Chrome
geprüft, und Archive werden ohne Zip-Slip und ohne Symlinks entpackt.

Gefunden und behoben wurden sechzehn Befunde. Die wichtigsten:

| # | Befund | Schwere |
|---|---|---|
| S1 | Fenster eines Remote-Cores übergab jede `window.open()`-URL an `shell.openExternal` (`file:`, `smb:`, App-Schemata) und lief in der Session, die `mindeck-file://` (beliebige lokale Dateien) bedient | **Hoch** |
| S2 | Ergebnisse der Projektsuche (Dateiinhalte) gingen per Push an **alle** gekoppelten Geräte, auch aus nicht geteilten Projekten; Suchen von Geräten lasen Dateien der Deny-Liste | **Mittel** |
| S3 | Deny-Liste für Geräte per Symlink, Windows-Schreibweisen (`id_rsa.`, `::$DATA`, 8.3-Namen) umgehbar; UNC-Pfade lösten NTLM-Authentifizierung zum Angreifer aus | **Mittel** |
| S9 | Electron-Fuses nicht gesetzt: `NODE_OPTIONS`/`--inspect` am signierten Hauptprozess, keine asar-Integrität, Browser-Cookies (Logins) unverschlüsselt | **Mittel** |
| S13 | Agent-Transkripte, Diffs, Freigaben und Projekt-Events gingen an alle gekoppelten Geräte, auch für nicht freigegebene Projekte | **Mittel** |

In einer zweiten Runde behoben: Agenten-/Assistenten-Aktivität ist pro Gerät auf freigegebene Projekte
beschränkt (S13), Agent-Tokens stehen nicht mehr in der Kommandozeile (S14), Offline-Zertifikate sind an
die Installation gebunden (S15), die macOS-Entitlements sind enger (S16). Die unverschlüsselte LAN-API (N1)
hat das parallel gemergte Paket `wip2/tls` behoben. Offen bleiben nur niedrige Punkte (§4).

---

## 2. Behobene Befunde

| # | Befund | Schwere | Fundstelle | Fix |
|---|---|---|---|---|
| S1 | **Remote-Fenster: beliebige Schemata an das OS.** `openRemoteWindow` (Remote-SSH/Dev-Container) reichte jede URL aus `setWindowOpenHandler` an `shell.openExternal` weiter. Eine Seite des (fremden, evtl. kompromittierten) Remote-Rechners konnte so `file:///…/x.exe`, `smb://angreifer/share/x.exe`, `ms-msdt:` usw. öffnen — auf Windows ein bekannter Weg zur Codeausführung. Zusätzlich lief das Fenster in der Default-Session, in der `mindeck-file://local/<pfad>` jede lokale Datei ausliefert (Existenz-Orakel, Bilder einbettbar). | Hoch | `electron/main/platform/electron.ts` | `f8fc18d`: nur `http(s):` und `mailto:` an das OS (`safeExternal`), Navigation bleibt auf dem Origin des Cores, eigene Partition `persist:mindeck-remote`. Test: `tests/unit/main/remote-window.test.ts` |
| S2 | **Suchergebnisse an alle Geräte.** `search:progress` war kein Desktop-Event und ging per WebSocket an jedes gekoppelte Gerät — die Treffer (Zeilen aus Dateien) jeder Desktop-Suche, auch in Projekten außerhalb der geteilten Ordner, und die Suchen anderer Geräte. Eine Gerätesuche las mit `rg --hidden` auch `.npmrc`, `*.pem` usw. (Deny-Liste). Ein Gerät konnte fremde Suchen per gleicher `id` abbrechen. | Mittel | `electron/main/services/search/SearchService.ts`, `electron/ipc/search.ipc.ts`, `electron/main/server/HttpServer.ts` | `1e45e67`, `cae7215`: Ergebnisse tragen das suchende Gerät, die Netzwerk-API sendet nur an dieses (Desktop-Suchen an kein Gerät); Deny-Liste filtert Gerätesuchen; Such-IDs pro Aufrufer. Tests: `search.test.ts`, `server.test.ts` |
| S3 | **Deny-Liste umgehbar, NTLM-Leck.** `RemoteAccess.file()` prüfte nur die Schreibweise. (a) Ein Link im Projekt (`notes.txt → ~/.ssh/id_rsa`, `config.txt → .env`) wurde gelesen; (b) Windows öffnet `id_rsa.`, `id_rsa ` und `id_rsa::$DATA` als `id_rsa`, Kurznamen wie `ENV~1.LOC` als `.env.local`; (c) `projects:add`/`memory:setVault`/`fs:dirs` mit `\\angreifer\share` und jeder Dateikanal über `confine()` (`existsSync` vor der Bereichsprüfung) sprachen den UNC-Pfad an — Windows sendet dabei den NTLM-Hash des Nutzers an den Angreifer (LAN-Angreifer mit gestohlenem Geräte-Token). | Mittel | `electron/main/server/RemoteAccess.ts`, `electron/main/lib/confine.ts` | `d667b1c`: Dateien im Projekt zusätzlich über ihren kanonischen Pfad (`realpath.native`: Links aufgelöst, lange Windows-Namen) geprüft; Segmente auf Windows ohne Punkte/Leerzeichen am Ende und ohne Stream-Namen verglichen; UNC-/Device-Pfade vor jedem Dateisystemzugriff abgelehnt; `confine()` prüft den geschriebenen Pfad, bevor es die Platte fragt. Tests: `remote-access.test.ts`, `confine.test.ts` |
| S4 | **Terminal-Scrollback lesbar für alle.** `terminals.json` (bis 12 × 512 KB Scrollback — Tokens, Keys, was die Shell ausgab) wurde mit Default-Modus (0644) geschrieben; bei Installationen, deren `data/` älter ist als das `mkdir 0700`, für andere lokale Nutzer lesbar. | Mittel | `electron/main/services/terminal/TerminalService.ts` | `b88abf8`: Schreiben mit 0600. Größenlimit war bereits im Schema (`terminal:persist`). Test: `terminal.test.ts` |
| S5 | **Tar: Speicher/Platte erschöpfbar.** Pax- und GNU-Longname-Records wurden in der Größe gelesen, die der Header behauptet (bis Terabytes, im Hauptprozess → Absturz). Ein `.tar.gz` (Größe unbekannt) wurde geschrieben, bis die Platte voll war. | Mittel (DoS) | `electron/main/services/finder/archive.ts` | `326b178`: Metadaten-Records > 1 MB abgelehnt, Summe der Dateigrößen ≤ freier Platz (wie bei ZIP). Test: `finder-ops.test.ts` |
| S6 | **Ausbruch aus `<untrusted_web_content>`.** Seitentext, Titel oder Adresse mit `</untrusted_web_content>` beendeten den Wrapper vorzeitig; danach folgender Text liest sich für das Modell wie Anweisung (Prompt-Injection). | Mittel | `electron/main/services/ai/tools/browser.ts` | `ac67fdd`: Wrapper-Tags in Seiteninhalt, Titeln und Adressen werden als `&lt;…` entschärft, `"` im `origin`-Attribut kodiert. Test: `browser-tools.test.ts` |
| S7 | **Log-Redaction lückenhaft.** Nicht entfernt wurden Passwörter in URLs (MongoDB-Connection-Strings, Git-Remotes mit Token), JWTs, PEM-Private-Keys sowie Tokens von GitLab (`glpat-`), npm (`npm_`), Google (`AIza`), Slack-Refresh (`xoxe-`), GitHub (`ghu_`, `ghr_`). Logs landen in Bug-Reports. | Niedrig–Mittel | `electron/main/lib/log.ts` | `9ea716b`. Test: `desktop.test.ts` |
| S8 | **Downloads ohne Mark of the Web (Windows).** Electron setzt keine Quarantäne-Markierung; Mindeck tat es nur auf macOS. Auf Windows liefen heruntergeladene Installer/Office-Dateien ohne SmartScreen bzw. Protected View. | Mittel | `electron/main/platform/browser/session.ts` | `7f3b292`: `Zone.Identifier`-Stream (ZoneId=3, HostUrl ohne Zugangsdaten, sonst `about:internet`); Platten ohne Streams werden still übersprungen. Test: `browser-host.test.ts` |
| S9 | **Electron-Fuses nicht gesetzt.** `NODE_OPTIONS` und `--inspect` am signierten Hauptprozess (Code-Injektion/Debugger, Umgehung von Keychain-Bindung), App-Code nicht nur aus `app.asar` und ohne Integritätsprüfung, Cookie-Store des Browsers (Logins!) unverschlüsselt auf der Platte. | Mittel | `electron-builder.yml` | `2f0bf51`: `electronFuses` (EnableNodeOptionsEnvironmentVariable/EnableNodeCliInspectArguments aus, EnableEmbeddedAsarIntegrityValidation/OnlyLoadAppFromAsar/EnableCookieEncryption an). electron-builder 26.15 schreibt die Integrität für macOS (Info.plist) und Windows (Ressource). `RunAsNode` bleibt an, siehe N5. Test: `build-config.test.ts` |
| S10 | **`npm audit --omit=dev`: source-map-js 1.2.1** (GHSA-68fv-2mgg-jv7q, hoch: Event-Loop-DoS über indizierte Source-Map-Sections), zur Laufzeit über `sass`. | Hoch (Advisory), praktisch niedrig | `package-lock.json` | `5f645d9`: 1.2.2 (Patch, kein Breaking Change). Danach nur noch die zwei niedrigen Monaco-Einträge (N7). |
| S11 | **`mindeck-file://` ohne CSP.** SVGs wurden als `image/svg+xml` ohne Policy ausgeliefert; als Dokument geöffnet (statt als `<img>`) liefe ihr Script in einem `secure`/`standard`-Origin. Heute nur über `<img>/<video>/<audio>` genutzt — Defense in Depth. | Niedrig | `electron/main/platform/fileProtocol.ts` | `fee5792`: jede Antwort mit `default-src 'none'; …; sandbox`. Test: `file-protocol.test.ts` |
| S12 | **Extension-Entfernen löschte beliebige Pfade.** Für Store-/Profil-Extensions wurde `rm -rf` auf den Pfad aus `extensions.json` ausgeführt; eine manipulierte Datei im Datenordner (oder ein Sync) konnte das auf jeden Ordner lenken. | Niedrig | `electron/main/services/browser/extensions/ExtensionService.ts` | `aded608`: gelöscht wird nur innerhalb von `data/browser/extensions`. Test: `browser-extension-service.test.ts` |
| S13 | **Aktivität aller Projekte an alle Geräte.** `agents:message`, `agents:changed`, `ai:message`/`ai:delta`, `permission:request`, `events:event` und projektbezogene Events (lsp, tests, sftp, live server, context) gingen an jedes gekoppelte Gerät; `agents:list\|get\|changes\|diff`, `ai:conversations\|conversation`, `ai:runs`, `permission:pending`, `events:recent` waren nicht auf freigegebene Projekte begrenzt. Ein Mitglied-Gerät las Transkripte, Diffs und Freigaben von Projekten, die es nicht öffnen darf. Inline-Edits (`ai:inlineDelta`, Code des Anfragenden) gingen an alle; `remote:changed` verließ das Desktop-Fenster. | Mittel | `electron/main/server/RemoteScope.ts` (neu), `HttpServer.ts`, `electron/ipc/router.ts`, `InlineService.ts` | `6639a4e`: `RemoteScope` ordnet Sessions, Unterhaltungen, Freigaben und Events ihrem Projekt zu und fragt `RemoteAccess`: Aufrufe mit Session-/Unterhaltungs-/Freigabe-ID werden wie Aufrufe mit `projectId` geprüft (Guard), Listen für Geräte gekürzt (neuer Router-Schritt `shape`), Push-Events pro Gerät verworfen oder gekürzt — in Reihenfolge, und nicht gesendet, wenn die Prüfung scheitert. Inline-Edits nur an das anfragende Gerät; `remote:changed` ist Desktop-Event. Tests: `remote-scope.test.ts`, `server.test.ts`, `infra.test.ts`, `inline.test.ts`, `createCore.test.ts` |
| S14 | **Agent-Token in der Kommandozeile.** `claude --settings '{…Bearer <token>…}' --mcp-config '{…}'` stand in `argv` und war für jeden Nutzer der Maschine über `ps`/`/proc/*/cmdline` lesbar → Zugriff auf Hook-Endpunkt und Memory-/Browser-Tools der Session. | Mittel (Mehrbenutzer-Systeme) | `electron/main/services/agents/claudeLaunch.ts`, `AgentSessionService.ts` | `34b6bbb`: Beide Optionen nehmen laut `claude --help` Dateipfade (`--settings <file-or-json>`, `--mcp-config <configs...>`); Mindeck schreibt sie pro Lauf 0600 in einen 0700-Ordner (`data/agents/launch/<session>/<lauf>`) und löscht sie, wenn der Lauf endet, die Session entfernt wird oder Mindeck neu startet. Der Relay-Hook liest das Token wie bisher aus der Umgebung (`/proc/*/environ` nur für den Nutzer lesbar). Eingefügte Bilder liegen nicht mehr im geteilten `/tmp`, sondern in `data/agents/images`. Codex/Gemini (ACP) bekommen den MCP-Server über stdio, nicht über `argv`. Der erste Prompt steht weiterhin in `argv` (kein Geheimnis; Claude Code nimmt ihn nur so). |
| S15 | **Offline-Zertifikat nicht ans Gerät gebunden.** Der Claim `dev` wurde ignoriert: ein Lifetime-Zertifikat, in den Store einer anderen Installation kopiert, hielt diese ohne Cloud am Laufen. | Niedrig–Mittel | `electron/main/services/cloud/CloudService.ts` | `3e72013`, `f2267db`: Mindeck Cloud setzt `dev` auf **ihre** ID der Installation (`devices.id`, `mindeck-cloud/src/modules/license/service.ts` über `auth.deviceId`), nicht auf die `installId`. Der Core merkt sich diese ID aus seinen verifizierten Leases (bei Bestandsdaten aus dem zuletzt gespeicherten Lease) und akzeptiert ein Zertifikat nur, wenn `dev` dieser ID oder der `installId` entspricht; ohne `dev` (ältere Clouds) gilt es weiter. Grenze: Wer den ganzen Datenordner samt Secret-Store kopiert, kopiert auch die IDs — eine Hardware-Bindung gibt es nicht. |
| S16 | **macOS-Entitlements zu weit.** `allow-unsigned-executable-memory` und `disable-library-validation` galten für App und alle Helper (`entitlementsInherit` = dieselbe Datei). | Niedrig | `build/entitlements.mac.plist`, `build/entitlements.mac.inherit.plist` (neu), `electron-builder.yml` | `34b2678`: `allow-unsigned-executable-memory` entfernt (V8 nutzt MAP_JIT über `allow-jit`; `@electron/osx-sign` gibt App, Renderer und GPU auch nur `allow-jit`). Helper (Renderer/GPU/Plugin) bekommen nur noch `allow-jit`. `disable-library-validation` bleibt **nur** am Haupt-Binary: als Lint-Worker (`ELECTRON_RUN_AS_NODE`) lädt es ESLint/Prettier des Projekts mit deren Plugins, deren native Addons (z. B. `unrs-resolver`, `@swc/core`) nicht mit Mindecks Team-ID signiert sind. Mindecks eigene Module (node-pty, ssh2, cpu-features) bräuchten es nicht. Test: `build-config.test.ts`. Noch zu verifizieren: ein signierter, notarisierter Build auf macOS. |

---

## 3. Geprüft ohne Befund

- **IPC-Grenze.** `CHANNEL_ACCESS` für jeden neuen Kanal: `browser:*`, `finder:*`, `desktop:*`,
  `terminal:configure|persist|restore` → `desktop`; `terminal:*`, `scm:`-Schreibzugriffe, `agents:create|send|configure…`
  → `terminal`; `server:createPairingCode|setDeviceRole`, `ai:setKey|clearKey`, `permission:revoke`,
  `cloud:login|register|logout|adopt` → `admin`; `server:revokeDevice` erlaubt Nicht-Admins nur das eigene Gerät.
  `DESKTOP_EVENTS`/`TERMINAL_EVENTS` für Browser-, Finder- und Terminal-Events. Zod-Schemas mit Längen-/Größenlimits
  (Bilder base64-validiert, `MAX_IMAGE(S)_BYTES`, Pfade ≤ 4096, Scrollback ≤ 512 KB, Profile-IDs per Regex).
  `bindIpc` beantwortet nur Frames mit Mindecks eigener URL (`isAppUrl`); `files:start-drag` prüft dasselbe.
  Preload: Allowlist aus dem Contract; `browserPage.ts` exponiert nichts (`executeInMainWorld` patcht nur `navigator.userAgentData`).
- **Browser.** Tab-Views und Popups: `sandbox`, `contextIsolation`, kein Node, keine Bridge; `setWindowOpenHandler`
  nur `http(s)` → neuer Tab; Hauptfenster: `will-navigate`/`will-redirect` gesperrt, `openLink` nur `http(s)`/`mailto`;
  Kontextmenü-„Im Standardbrowser öffnen“ und DRM-Übergabe nur `http(s)` (`isWebUrl`); `javascript:`/`vbscript:` in der
  Adresszeile verworfen; Permission-Handler fragt für Kamera/Mikrofon/Standort/Benachrichtigungen/Clipboard-Lesen/
  Bildschirm/externe Apps (mit App-Namen), alles Unbekannte abgelehnt; Zertifikatsausnahme nur für Loopback;
  Download-Namen per `basename` + freier Name; Agenten-Tabs im Container `persist:mindeck-agents` (Default), Passwortfelder
  im Snapshot `[protected]`, kein Tippen in Passwortfelder; Lese-Tools nur auf geteilten Tabs.
- **Extensions.** CRX3: alle Signaturen müssen verifizieren, eine vom Schlüssel der ID, ID = angefragte ID, SHA-256 aus
  der Update-Antwort geprüft; ZIP ohne `..`/absolute Pfade, ohne ZIP64/Verschlüsselung, 512-MB-Grenze; Profil-Import nur aus
  `<Profil>/Extensions/<id>/<version>`; Extensions nur im Nutzerprofil, nie in privaten Tabs oder im Agenten-Container.
- **Files/Finder.** Schreiben nur in Home/Laufwerken (`realpath` des Elternordners), Löschen nur in den Papierkorb,
  Ordner nicht in sich selbst, Undo prüft Ziel frei und beschreibbar; ZIP: Namen vorab geprüft, `validateEntrySizes`,
  Platzprüfung, Links nie angelegt, `wx`, Rechte ohne setuid; `mindeck-file://` nur in der Session des UI-Fensters
  (Tab-Partitionen erreichen es nicht), Nicht-Medien als `text/plain` + `nosniff`.
- **Agents.** Bilder: Typ-Allowlist, 5 MB, zufällige Namen, 0600 in 0700-Ordner; `@`-Referenzen über `confine()` (Links
  aufgelöst), Tabs nur `http(s)`; Modell/Modus gegen die angebotene Liste geprüft; ACP-Clients bekommen keine
  `fs`-Capabilities; Hook-/MCP-Server nur auf 127.0.0.1 mit Host-/Origin-Prüfung und Token pro Session
  (`timingSafeEqual`); Grants pro Agent+Tool+Projekt, Geräte geben nie „Immer erlauben“ und Schreibfreigaben nur mit Remote-Shells;
  Push-Texte ohne Tool-Eingaben und ohne Fehlermeldungen.
- **Terminal.** Profile (Programme) nur am Desktop; Shell-Integrationsskripte werten `cwd`/Titel nicht aus; OSC 7 setzt nur
  Label/Ordner neuer Tabs (UNC auf Windows abgelehnt); Links öffnen Dateien im Editor bzw. Web-URLs über `openLink`.
- **Lizenz.** Ed25519-Signatur, Release-Builds nur mit eingebackenem Schlüssel (`cloudDefines` verweigert URL ohne Key),
  `isReleaseBuild` zur Build-Zeit, Offline-Zertifikat nur mit `perpetual`, `active` und gültigem `exp`.
- **Renderer.** Markdown (Chat, Notizen, Vorschau, PRs) über DOMPurify, CSP `script-src 'self'`, `object-src 'none'`.

---

## 4. Nicht behoben (mit Begründung)

| # | Befund | Schwere | Fundstelle | Begründung / Empfehlung |
|---|---|---|---|---|
| N1 | **Netzwerk-API im LAN unverschlüsselt.** Bei `lan: true` lauschte der Core per HTTP auf `0.0.0.0`; Bearer-Tokens, Pairing-Codes und alle Daten gingen im Klartext durchs Netz. | Hoch (im LAN-Modell) | `electron/main/server/HttpServer.ts`, `ServerController.ts` | Während dieses Reviews durch das Paket `wip2/tls` behoben (Merge `6309a60`, hier mitgemergt): HTTPS/WSS im LAN-Modus standardmäßig (`tls: true`), selbstsigniertes Zertifikat, Fingerprint im Pairing-QR-Code gepinnt. Rest-Risiko: `tls: false` schaltet zurück auf Klartext — Settings sollten davor warnen. |
| N5 | **Fuse `RunAsNode` bleibt an.** | Niedrig | `electron-builder.yml` | Nachträglich behoben (BE-SEC-14): tsserver, Lint-Worker, PHP-Debug-Adapter und Dev-Containers-CLI laufen als Electron-Utility-Prozesse (`electron/main/lib/nodeProcess.ts`, `electron/nodeHost.ts`), `runAsNode: false`. `disable-library-validation` nur noch im Plugin-Helper (`build/sign.cjs`, `build/entitlements.mac.plugin.plist`). Tests: `node-process.test.ts`, `build-config.test.ts`, e2e `app-node-programs.spec.ts` |
| N7 | **`npm audit`: DOMPurify 3.4.15 in monaco-editor** (GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2, niedrig). | Niedrig | `node_modules/monaco-editor` | Betrifft nur den Modus `IN_PLACE`, den Monaco nicht nutzt (vendored in `esm/vs/base/browser/dompurify`). Fix nur per Downgrade auf monaco 0.56 (Breaking). Mindecks eigenes DOMPurify ist ≥ 3.4.16. |
| N8 | **Passwortfelder nur im Hauptdokument erkannt.** `secretNodes` sucht `input[type=password]` ohne Shadow DOM/iframes; `browser_type` könnte dort in ein Passwortfeld tippen. | Niedrig | `electron/main/services/ai/tools/browser.ts` | Chromium maskiert Passwortwerte im Accessibility-Tree ohnehin; Tippen ist ein Schreib-Tool und wird vom Nutzer freigegeben. Empfehlung: `DOM.getDocument({ pierce: true, depth: -1 })`. |
| N9 | **Adblock-Listen nur per HTTPS geschützt.** | Niedrig | `electron/main/services/browser/adblock.ts` | Wie uBlock/Ghostery: keine Signatur verfügbar. Eingesetzt werden nur Netzwerkregeln, Redirect-Ressourcen und kosmetisches CSS (`getInjectionRules: false`, keine Scriptlets). |
| N10 | **Lokale Dev-Seiten automatisch für Agenten geteilt.** Jede `localhost`-Seite im Nutzerprofil (auch Jupyter, Admin-UIs) ist für Agenten-Lese-Tools ohne Rückfrage sichtbar. | Info | `electron/main/services/browser/BrowserService.ts` | Gewolltes Feature (UI-Checks); Empfehlung: auf Ports von Live Server/erkannten Dev-Servern beschränken oder einmal fragen. |
| N11 | **Downloads vor Größenprüfung im Speicher.** Extension-Pakete (100 MB) und Filterlisten werden erst ganz geladen, dann geprüft. | Info | `ExtensionService.ts`, `adblock.ts` | Nur Google-/Listen-Server über HTTPS; Streaming mit Abbruch wäre die saubere Lösung. |

---

## 5. Prüfungen und Status

- Typecheck (`npm run typecheck`): grün.
- Volle Suite (`npx vitest run --coverage`): 1768 Tests grün; rot sind nur die bekannten Container-Fehlschläge
  (createCore „wires every service…“, finder „finds drives…“, lint × 2, notebook, tests „an unreadable folder…“)
  und die daraus folgenden Coverage-Lücken (`remote.ipc.ts`, `createCore.ts`, `FinderService.ts`, `NotebookService.ts`).
- 100 % Coverage der geänderten Dateien (`RemoteAccess.ts`, `RemoteScope.ts`, `confine.ts`, `router.ts`,
  `SearchService.ts`, `search.ipc.ts`, `HttpServer.ts`, `ServerController.ts`, `TerminalService.ts`, `archive.ts`,
  `browser.ts`, `log.ts`, `session.ts`, `fileProtocol.ts`, `ExtensionService.ts`, `electron.ts`, `InlineService.ts`,
  `ConversationStore.ts`, `AgentSessionService.ts`, `claudeLaunch.ts`, `CloudService.ts`).
- `npm audit --omit=dev` nach dem Fix: 2 × niedrig (N7).
