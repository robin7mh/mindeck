# Mindeck // Command Center

**[Deutsch](#deutsch)** · **[English](#english)**

<a id="deutsch"></a>

Eine hochwertige, dunkle, futuristische **Desktop-App**: ein Command Center im Jarvis-Stil für
deine Projekte, deine Coding-Agenten und dein Wissen. Sie folgt dem *Prinzip* von
Sci-Fi-Terminal-Oberflächen (Terminal · System-Telemetrie · HUD-Panels) und ist **kein** Klon
eines bestehenden Tools.

> Schon heute echt: ein Agent-Cockpit für die Coding-Agenten, die du ohnehin nutzt (Claude Code
> mit deinem eigenen Abo, Codex und Gemini), ein Editor wie VS Code, ein Obsidian-kompatibler
> Gedächtnis-Vault mit Graph, Projekte mit Strukturkontext, echte Shells und Live-Telemetrie. Das
> läuft auf dem Desktop, im Browser und über eine Netzwerk-API für die kommende Mobile-App. Siehe
> [`Mindeck_ARCHITECTURE.md`](Mindeck_ARCHITECTURE.md) und die API-Referenz [`docs/API.md`](docs/API.md).

## Stack

Electron (rahmenlos) · React 18 · TypeScript · Vite (über **electron-vite**) · Tailwind CSS ·
Framer Motion · **Monaco** · **xterm.js** + node-pty · Agent Client
Protocol · Anthropic SDK · Zod · `ws` · Vitest + Testing Library · Playwright. Die Schriften
(Inter, JetBrains Mono) sind lokal eingebunden.

## Loslegen

Voraussetzungen: Node 22. Docker nur für das optionale Server-Image (`npm run docker:up`).

```bash
git clone https://github.com/robin7mh/mindeck.git
cd Mindeck
npm install
```

Mindeck ist ein **Core** (alle Dienste), den du auf drei Arten startest:

| | Befehl | Was du bekommst |
|---|---|---|
| **Desktop-App** | `npm run dev` | Electron-Fenster (im Dev-Modus mit HMR) |
| **Web-UI + API, ohne Docker** | `npm run web` | baut Web-UI und Core-Server und stellt beides unter `http://127.0.0.1:7420` bereit |
| **Docker** | `npm run docker:up` | der Core als Container unter `https://127.0.0.1:7420` (Heimserver, NAS) |

**Zugriff aus dem Browser wird gekoppelt.** Öffne die Adresse und gib den Einmal-Code ein. Den
Code bekommst du auf einem dieser Wege:

- der Server gibt ihn beim Start aus;
- `npm run server:pair` oder `npm run docker:pair`;
- in der Desktop-App: Settings → *Pair a device*, dort gibt es auch einen QR-Code fürs Handy.

Jeder Browser und jedes Handy bekommt ein eigenes Token; Geräte entziehst du in den Settings.
Remote-Shells sind aus, solange du nicht `MINDECK_REMOTE_TERMINAL=1` (Server) setzt oder Settings →
*Allow remote shells* (Desktop) einschaltest. Ohne sie erreichen gekoppelte Geräte nur freigegebene
Ordner (Desktop: Settings → *Shared folders* und die dort hinzugefügten Projekte; Server:
`MINDECK_REMOTE_ROOTS`, Standard `/projects`) und geben nur Lesezugriffe frei. Gekoppelte Geräte
sind *Mitglieder*; Geräte koppeln, den KI-Key setzen und das Konto an- oder abmelden dürfen nur der
Desktop und *Admin*-Geräte (beim Koppeln vergeben, `npm run server:pair -- --admin`; beim Server
ist das erste Gerät Admin).

**Die Desktop-App kann die Web-UI auch selbst ausliefern:** Schalte Settings → Remote access →
*Run the API server* ein, fürs Handy zusätzlich *Reachable on the local network*.

**Im Netzwerk verschlüsselt:** Sobald der Core übers Netzwerk erreichbar ist (*Reachable on the
local network*, `MINDECK_LAN=1`, Docker), spricht er dort nur HTTPS/WSS — mit einem selbst
ausgestellten Zertifikat (im Datenordner unter `data/tls`, rechtzeitig und bei neuer IP erneuert).
Der Browser warnt einmal; der QR-Code und die Kopplungsseite zeigen den SHA-256-Fingerabdruck des
Zertifikats, den du mit dem im Browser vergleichst. Der Computer selbst behält
`http://127.0.0.1:7420`. Abschalten: *Encrypted (HTTPS)* bzw. `MINDECK_TLS=0` (etwa hinter einem
Reverse-Proxy); ein eigenes Zertifikat: `MINDECK_TLS_CERT` + `MINDECK_TLS_KEY`. Details:
[docs/API.md](docs/API.md#encryption-https--wss).

### Agents

Der Bereich **Agents** arbeitet mit der KI, für die du schon bezahlst. Mindeck braucht dafür keinen
API-Key:

- **Claude Code** läuft als dein eigenes, unverändertes `claude`-CLI mit deinem Claude-Abo.
  Einmal anmelden mit `claude auth login`.
- **Codex** läuft mit deinem Codex-Login über seinen ACP-Adapter. Beim ersten Start wird der
  Adapter einmalig per `npx` geladen, dafür braucht es Node.js.
- **Gemini CLI** läuft als `gemini --experimental-acp` mit deiner eigenen Gemini-Anmeldung.

Zum Starten öffnest du *New chat* und wählst Agent und Projekt. Optional gibst du gleich die
erste Nachricht mit und setzt das Häkchen bei *Own working folder*. Jede Sitzung ist ein Chat:

- **Freigaben** erscheinen im Chat, im Command Deck und als Mitteilung, wenn Mindeck im Hintergrund
  ist. Befehle werden jedes Mal gefragt; Datei- und Gedächtnis-Werkzeuge kannst du dauerhaft
  erlauben.
- **Changes** zeigt, was der Agent seit Sitzungsbeginn geändert hat. Jede Änderung öffnet sich als
  Diff in Monaco.
- **Plan** zeigt die Aufgabenliste des Agenten, **Memory** die Vault-Notizen, die er gelesen oder
  geschrieben hat.
- Im **Kopf** steht der Name der Sitzung; ein Klick darauf benennt sie um. Daneben gibt es Buttons
  für *GitHub* (die Repo-Seite), *VS Code* (der Ordner der Sitzung) und *Terminal*. Bei Claude
  Code ist das sein eigenes Terminal, bei Codex und Gemini eine Shell im Ordner der Sitzung.

**Eigener Arbeitsordner.** Mit dieser Option arbeitet der Agent in einem Git-Worktree unter
`~/Mindeck/worktrees/<projekt>-<id>`, auf einem lokalen Branch `mindeck/<id>`. Dein Projektordner
bleibt unberührt, so können mehrere Agenten (und du) parallel arbeiten.

- *Take over* kopiert die Änderungen des Agenten als nicht committete Änderungen in dein Projekt.
  Committe und pushe sie wie gewohnt; erst dann sind sie auf GitHub.
- *Discard* löscht den Ordner und seinen Branch.

**Gedächtnis für jeden Agenten.** Jeder Agent kann deinen Vault über den MCP-Server von Mindeck
durchsuchen und lesen. Nach jeder Antwort schreibt Mindeck eine Protokoll-Notiz nach
`Agents/<projekt>/…` (Auftrag, Ergebnis, geänderte Dateien, Offenes). Der nächste Agent, egal von
welchem Anbieter, kann dort anknüpfen.

**Mindeck Assistant.** Daneben gibt es einen eingebauten Assistenten mit Anthropic-API-Key.
Standardmäßig nutzt er `claude-opus-5-5`, alternativ ist Sonnet 5.5 wählbar. Setze
`ANTHROPIC_API_KEY` für den Core oder trage den Key in den Settings ein. Der Key wird einmal
geprüft und nur im Core gespeichert (auf dem Desktop verschlüsselt über den Schlüsselbund des
Betriebssystems); an Clients geht er nie.

### Daten

Der Core braucht keine Datenbank. Alles, was er behält, sind Dateien unter `~/Mindeck`:
Einstellungen, Projekte, Agent-Sitzungen, das Aktivitätsprotokoll (`data/events.jsonl`),
Assistenten-Läufe (`data/runs.json`) und das Gedächtnis als Markdown (`vault/`). Ein Backup
ist eine Kopie dieses Ordners. Die einzige Datenbank im System hat Mindeck Cloud.

Weitere Skripte:

```bash
npm run build         # Electron main / preload / renderer → out/
npm run web:build     # die Web-UI → out/web
npm run server:build  # der eigenständige Core → out/server/index.cjs
npm run server        # ihn starten (MINDECK_PORT, MINDECK_LAN, MINDECK_TLS, MINDECK_REMOTE_TERMINAL, MINDECK_REMOTE_ROOTS, MINDECK_HOME …)
npm run web:dev       # Web-UI mit HMR; leitet /api an einen Core auf :7420 weiter
npm run typecheck     # tsc für node (electron + server), web (renderer) und die Tests
```

Alle Einstellungen und Daten liegen unter `~/Mindeck` (änderbar mit `MINDECK_HOME`):

- `data/`: Einstellungen, Projekte, gekoppelte Geräte, Secrets, Unterhaltungen, Agent-Sitzungen
- `vault/`: das Obsidian-kompatible Gedächtnis
- `worktrees/`: die eigenen Arbeitsordner der Agenten

Um Docker-Ports oder Bind-Adressen zu ändern, kopiere `.env.example` nach `.env`.

## Tests

```bash
npm test                 # Unit-Tests (Vitest): Main-Prozess in Node, Renderer in jsdom
npm run test:coverage    # dasselbe mit Abdeckung; schlägt unter 100 % fehl
open coverage/index.html # der Abdeckungsbericht
npm run test:e2e         # Build + Playwright gegen die echte Electron-App
npm run test:all         # Typecheck + Abdeckung + E2E: das, was CI bei einem Pull Request ausführt
```

- **Unit** (`tests/unit/main`, `tests/unit/renderer`): Jede Datei in `electron/` und `src/` wird
  gemessen. Zeilen, Zweige, Funktionen und Anweisungen müssen alle bei **100 %** bleiben.
  Ausgenommen sind nur reine Typ-Module (`vitest.config.ts`).
- **E2E** (`tests/e2e`): Jeder Test läuft mit einem Wegwerf-`MINDECK_HOME`, dein echtes `~/Mindeck`
  wird nie angefasst.
  - *electron*: die gebaute Desktop-App. Geprüft werden der Start, jedes Modul, eine
    echte Shell, eine Vault-Notiz auf der Platte, ein Projekt, der Editor, der eingebettete
    API-Server. Dazu kommt eine Agent-Sitzung gegen einen Stellvertreter
    für Claude Code (`tests/e2e/fake-claude.mjs`, kein Konto nötig): Chat, Freigabe, Diff,
    Umbenennen und Protokoll. Die Nutzerwege (`app-*.spec.ts`) gehen durch Workspace, Browser,
    Files, Memory, Editor, Terminal, den Agent-Composer und die ganze Ersteinrichtung – einige über
    einen echten Neustart der App (`restart()` in `fixtures.ts`). Unter Linux ohne Bildschirm mit
    `xvfb-run -a` starten. Was die QA-Runde gefunden hat: [`docs/QA-2026-10.md`](docs/QA-2026-10.md).
  - *web*: die gebaute Web-UI in Chromium gegen den echten eigenständigen Core. Geprüft werden
    Kopplung, Live-Daten, der Ordner-Browser, die Zugriffsregeln und der Assistent von Anfang bis
    Ende (gestreamte Antwort, ein Werkzeugaufruf hinter einer Freigabe, die Notiz auf der Platte).
    Der Assistent spricht dabei mit einem lokalen Stellvertreter für die Messages API
    (`tests/e2e/fake-anthropic.mjs`, kein Key nötig). `PW_CHROMIUM=/pfad/zu/chrome` nutzt ein
    vorinstalliertes Chromium.

## CI/CD (GitHub Actions)

| Workflow | Läuft bei | Macht |
| --- | --- | --- |
| `ci.yml` | jedem Pull Request (und manuell) | Typecheck · Unit-Tests mit 100-%-Schwelle (Bericht als Artefakt) · E2E (Electron, Web-UI + Core) · Docker-Image-Build |
| `cd.yml` | Push auf `main`/`develop` (Merges), Tags `v*` (Releases) | **keine Tests**: baut das Core-Image (API + Web-UI) und pusht es nach `ghcr.io/robin7mh/mindeck` (`:develop`, `:main`, `:sha-…`; bei einem Tag zusätzlich `:1.2.3` und `:latest`); ein Tag erstellt außerdem ein GitHub-Release mit dem Web-Bundle |

Release: `git tag v0.2.0 && git push origin v0.2.0`.

`npm run build` und `npm run web:build` starten Node mit 4 GB Heap. Das Bündeln von Monaco (der
Editor und seine Sprach-Worker) braucht etwa 2,5 GB. Auf GitHubs Runnern für private Repos
(7 GB RAM) und in Docker nimmt Node sonst nur etwa 2 GB.

Damit die Tests vor dem Mergen Pflicht sind, aktiviere den Branch-Schutz für `main` und `develop`
(GitHub → Settings → Branches) und mache die CI-Checks erforderlich.

### Später: Website / Monorepo

Wenn die Mindeck-Website kommt, kann das Repo zu einem npm-Workspaces-Monorepo werden, ohne die
Form der Pipeline zu ändern:

- `apps/desktop`: diese App
- `apps/web`: die Website
- `packages/shared`: das heutige `src/shared`

Jede App bekommt ihr eigenes Dockerfile, CI und CD laufen pro Workspace.

## Was auf dem Bildschirm ist

| Bereich | Komponente | Hinweise |
| --- | --- | --- |
| Boot-Overlay | `BootSequence` | Ein getipptes Boot-Log mit Fortschritt, das zur Oberfläche überblendet (Klick überspringt). |
| Obere Leiste | `TopStatusBar` | Codename, Live-Uhr und Modus/Laufzeit/Verbindung. Native Fensterknöpfe unter macOS, eigene unter Windows/Linux. Ziehbarer Bereich. |
| Linke Leiste | `SideNavigation` | Core · Editor · Terminal · Projects · Memory · Agents · System · Settings, dazu der verbundene Core. Bei schmalen Fenstern nur Icons. |
| Mitte | das aktive Modul | Siehe [Module](#module) unten. |
| Rechte Leiste | `SystemMonitorPanel` | CPU/RAM-Anzeigen, Verlaufskurven und eine Prozess-Vorschau. Nur auf Core; alle anderen Module nutzen die volle Breite. |
| Unten | `BottomDashboard` | *Command Deck*: laufende Agent-Sitzungen (öffnen / beenden), wartende Freigaben, Live-Aktivität. |
| Overlay | `ApprovalToasts` | Ein Agent, der auf eine Freigabe wartet, ist in jedem Modul sichtbar. |

### Module

- **Core**: Begrüßung, HUD-Uhr und Kacheln für Projekte, Gedächtnis und System.
- **Editor**: Monaco (der Editor-Kern von VS Code) auf deinen Projektdateien, mit Dateibaum, Tabs
  und ⌘S, beliebig vielen Editor-Gruppen (⌘\\, ⌘K ⌘\\, Tabs an einen Rand ziehen, ⌘1…⌘9 — das
  Layout merkt sich jedes Projekt), Breadcrumbs und Gliederung. Er folgt Änderungen, die anderswo
  gemacht werden.
- **Terminal**: echte Login-Shells (node-pty) in Tabs oder geteilt.
- **Projects**: Git- und Stack-Erkennung plus Strukturkontext.
- **Memory**: der Obsidian-Vault mit Editor und Graph.
- **Agents**: das Agent-Cockpit, beschrieben unter [Agents](#agents).
- **System**: vollständige Telemetrie.
- **Settings**: Coding-Agenten, Mindeck Assistant, Fernzugriff und Geräte, Berechtigungen, Vault,
  Info.

### Designsystem (eine Quelle der Wahrheit)

- **Farben** sind CSS-Variablen in `src/index.css`, als Tailwind-Tokens in `tailwind.config.ts`
  verfügbar; Komponenten enthalten keine festen Hex-Werte. Unter Einstellungen → Darstellung
  (`src/lib/theme.ts`) wählt man Modus (dunkel, hell, System), Akzentfarbe und dunklen
  Hintergrund. „Cyber“ färbt Flächen, Linien, Text und Raster im Ton des Akzents, „Schwarz“ und
  „Graphit“ bleiben neutral. Der Modus setzt `data-theme`, Akzent und Hintergrund überschreiben
  einzelne Tokens direkt an `<html>`. Die Wahl wird pro Gerät gespeichert, Standard ist System
  in Cyan. Es ändern sich nur die Variablen, nie die Komponenten. Glows hängen am Token `--glow`,
  sind dezent und im hellen Modus aus.
- **Ein `Panel`-Baustein** (`src/components/ui/Panel.tsx`) gibt jeder gerahmten Fläche denselben
  Rahmen und Kopf. `HudFrame` ergänzt optionale Eckmarken. Ein gemeinsamer Glow-Token, sparsam
  eingesetzt.
- **Typografie**: Inter für Oberfläche und Überschriften, JetBrains Mono für alle technischen
  Werte, kleine Großbuchstaben-Labels über `TechLabel`.
- **Bewegung**: Boot → gestaffelt erscheinende Panels → pulsierende Status-Punkte → tippendes
  Terminal → Hover-Glows → gleitende Navigationsmarke. Alles dezent und bei
  `prefers-reduced-motion` abgeschaltet.

### Noch nicht gebaut

- die Mobile-App selbst
- P5 Gedächtnis-Pipeline, P10 Files, P11 Automations, P13 Embeddings
- Auslieferung: Installer, Signierung, Auto-Update

Siehe §12.4 im Architekturdokument.

## Projektstruktur

```
electron/      der Mindeck-Core: main.ts (Desktop-Fenster), preload.ts (window.mindeck-Brücke),
               ipc/ (Router + Kanal-Bindungen), main/core (createCore, EventHub),
               main/server (HTTP- + WebSocket-API), main/platform (electron | headless),
               main/services/ (agents, ai, auth, db, events, files, fs, git, memory, projects,
               system, terminal, …)
server/        main.ts: derselbe Core ohne Oberfläche (out/server/index.cjs, Docker)
src/
  components/  shell · topbar · nav · monitor · dashboard · boot · ui
  features/    agents · session (Kopplung) · settings · dashboard · editor · projects · memory ·
               terminal · system · context
  shared/      Vertrag, Schemas, Transport, Typen: geteilt von Core, Web-UI und Mobile-App
  hooks/ data/ lib/ types/
tests/
  unit/main      Vitest (node): Dienste, Core, API-Server, Agent-Laufzeit, main.ts
  unit/renderer  Vitest (jsdom): Stores, Hooks, jede Komponente
  e2e            Playwright: die gebaute Electron-App und die Web-UI gegen den Core
docker-compose.yml · Dockerfile            Core-Image (API + Web-UI) für Heimserver
.github/workflows/                          ci.yml (PR-Tests) · cd.yml (Image + Release)
```

## Mobile-App

Die React-Native-App spricht über HTTP und WebSocket mit demselben Core, mit einem Token pro
Gerät. Die Referenz, inklusive Kopplungsablauf und einer Client-Skizze, steht in
[`docs/API.md`](docs/API.md). Der Client-Code in `src/shared/ipc/transport.ts` läuft unverändert
in React Native.

---

<a id="english"></a>

A premium, dark, futuristic **desktop app**: a Jarvis-style command center for your projects,
your coding agents and your knowledge. It follows the *principle* of sci-fi terminal UIs
(terminal · system telemetry · HUD panels) and is **not** a clone of any existing tool.

> Real today: an agent cockpit for the coding agents you already use (Claude Code on your own
> plan, Codex and Gemini), a VS Code–style editor, an Obsidian-compatible memory vault with graph,
> projects with structural context, real shells and live system telemetry. It runs on the
> desktop, in the browser, and over a network API for the coming mobile app. See
> [`Mindeck_ARCHITECTURE.md`](Mindeck_ARCHITECTURE.md) and the API reference [`docs/API.md`](docs/API.md).

## Stack

Electron (frameless) · React 18 · TypeScript · Vite (via **electron-vite**) · Tailwind CSS ·
Framer Motion · **Monaco** · **xterm.js** + node-pty · Agent Client
Protocol · Anthropic SDK · Zod · `ws` · Vitest + Testing Library · Playwright. The fonts (Inter,
JetBrains Mono) are bundled locally.

## Getting started

Requirements: Node 22. Docker only for the optional server image (`npm run docker:up`).

```bash
git clone https://github.com/robin7mh/mindeck.git
cd Mindeck
npm install
```

Mindeck is one **core** (all services) with three ways to run it:

| | Command | What you get |
|---|---|---|
| **Desktop app** | `npm run dev` | Electron window (HMR in dev) |
| **Web UI + API, no Docker** | `npm run web` | builds the web UI and the core server and serves both on `http://127.0.0.1:7420` |
| **Docker** | `npm run docker:up` | the core as a container on `https://127.0.0.1:7420` (home server, NAS) |

**Browser access is paired.** Open the address and enter the one-time code. You get the code in
one of these ways:

- the server prints it at startup;
- `npm run server:pair` or `npm run docker:pair`;
- in the desktop app: Settings → *Pair a device*, which also shows a QR code for a phone.

Each browser or phone gets its own token, and you can revoke devices in Settings. Remote shells
stay off unless you set `MINDECK_REMOTE_TERMINAL=1` (server) or turn on Settings → *Allow remote
shells* (desktop). Without them, paired devices reach only shared folders (desktop: Settings →
*Shared folders* plus the projects added there; server: `MINDECK_REMOTE_ROOTS`, default `/projects`)
and approve reads only. Paired devices are *members*; pairing devices, setting the AI key and signing
the core in or out of the account are for the desktop and *admin* devices (chosen when pairing,
`npm run server:pair -- --admin`; a server's first device is admin).

**The desktop app can serve the web UI too:** turn on Settings → Remote access → *Run the API
server*, and also *Reachable on the local network* for your phone.

**Encrypted on the network:** as soon as the core is reachable over the network (*Reachable on the
local network*, `MINDECK_LAN=1`, Docker), it speaks HTTPS/WSS only there — with a certificate it
makes itself (kept in the data folder under `data/tls`, renewed in time and for a new IP). The
browser warns once; the QR code and the pairing page show the certificate's SHA-256 fingerprint
to compare with the one in the browser. The computer itself keeps `http://127.0.0.1:7420`. To
switch it off: *Encrypted (HTTPS)* or `MINDECK_TLS=0` (e.g. behind a reverse proxy); an own
certificate: `MINDECK_TLS_CERT` + `MINDECK_TLS_KEY`. Details:
[docs/API.md](docs/API.md#encryption-https--wss).

### Agents

The **Agents** module works with the AI you already pay for. Mindeck needs no API key for it:

- **Claude Code** runs as your own, unmodified `claude` CLI on your Claude plan. Sign in once
  with `claude auth login`.
- **Codex** runs with your Codex sign-in through its ACP adapter. On first start the adapter is
  fetched once with `npx`, so Node.js is needed.
- **Gemini CLI** runs as `gemini --experimental-acp` with your own Gemini sign-in.

To start one, open *New chat* and pick the agent and the project. Optionally give the first
message, and optionally tick *Own working folder*. Every session is a chat:

- **Approvals** appear inline, in the Command Deck, and as a desktop notification while Mindeck is
  in the background. Commands are asked every time; file and memory tools can be allowed for good.
- **Changes** shows what the agent changed since the session started. Each change opens as a
  diff in Monaco.
- **Plan** shows the agent's task list, and **Memory** shows the vault notes it read or wrote.
- The **header** shows the session's name: click it to rename. Next to it are buttons for
  *GitHub* (the repo page), *VS Code* (the session's folder) and *Terminal*. For Claude Code the
  terminal is its own; for Codex and Gemini it is a shell in the session's folder.

**Own working folder.** With this option the agent works in a git worktree under
`~/Mindeck/worktrees/<project>-<id>`, on a local branch `mindeck/<id>`. Your project folder stays
untouched, so several agents (and you) can work in parallel.

- *Take over* copies the agent's changes into your project as uncommitted edits. Commit and push
  them as usual; only then do they reach GitHub.
- *Discard* deletes the folder and its branch.

**Memory for every agent.** Each agent can search and read your vault over Mindeck's MCP server.
After every turn, Mindeck writes a journal note to `Agents/<project>/…` (task, result, changed
files, open items). The next agent, from any vendor, can pick up from there.

**Mindeck Assistant.** Separately, there is a built-in assistant on an Anthropic API key. It uses
`claude-opus-5-5` by default, and Sonnet 5.5 can be selected instead. Set `ANTHROPIC_API_KEY` for
the core, or paste the key in Settings. The key is verified once and stored on the core only
(encrypted by the OS keychain on the desktop); it is never sent to any client.

### Data

The core needs no database. Everything it keeps is files under `~/Mindeck`: settings, projects,
agent sessions, the activity log (`data/events.jsonl`), assistant runs (`data/runs.json`) and the
memory as Markdown (`vault/`). A backup is a copy of that folder. The only database in the
system belongs to Mindeck Cloud.

Other scripts:

```bash
npm run build         # Electron main / preload / renderer → out/
npm run web:build     # the web UI → out/web
npm run server:build  # the standalone core → out/server/index.cjs
npm run server        # run it (MINDECK_PORT, MINDECK_LAN, MINDECK_TLS, MINDECK_REMOTE_TERMINAL, MINDECK_REMOTE_ROOTS, MINDECK_HOME …)
npm run web:dev       # web UI with HMR; proxies /api to a core on :7420
npm run typecheck     # tsc for node (electron + server), web (renderer) and the tests
```

All settings and data live under `~/Mindeck` (`MINDECK_HOME` overrides this):

- `data/`: settings, projects, paired devices, secrets, conversations, agent sessions
- `vault/`: the Obsidian-compatible memory
- `worktrees/`: the agents' own working folders

To change Docker ports or bind addresses, copy `.env.example` to `.env`.

## Tests

```bash
npm test                 # unit tests (Vitest): main process in Node, renderer in jsdom
npm run test:coverage    # the same, with coverage; fails below 100 %
open coverage/index.html # the coverage report
npm run test:e2e         # build + Playwright against the real Electron app
npm run test:all         # typecheck + coverage + e2e: what CI runs on a pull request
```

- **Unit** (`tests/unit/main`, `tests/unit/renderer`): every file in `electron/` and `src/` is
  measured. Lines, branches, functions and statements must all stay at **100 %**. Only type-only
  modules are excluded (`vitest.config.ts`).
- **E2E** (`tests/e2e`): every test runs with a throwaway `MINDECK_HOME`, so your real `~/Mindeck` is
  never touched.
  - *electron*: the built desktop app. It covers boot, every module, a real
    shell, a vault note written to disk, a project, the editor, the embedded API server. It
    also runs a coding agent session against a stand-in for Claude Code
    (`tests/e2e/fake-claude.mjs`, no account needed): chat, approval, diff, rename and journal.
    The user journeys (`app-*.spec.ts`) go through the workspace, browser, files, memory, editor,
    terminal, the agent composer and the whole first-start setup — some across a real restart of
    the app (`restart()` in `fixtures.ts`). On Linux without a display, run it under `xvfb-run -a`.
  - *web*: the built web UI in Chromium against the real standalone core. It covers pairing, live
    data, the folder browser, the access rules, and the assistant end to end (streamed answer, a
    tool call behind an approval, the note on disk). The assistant talks to a local stand-in for
    the Messages API (`tests/e2e/fake-anthropic.mjs`, no key needed).
    `PW_CHROMIUM=/path/to/chrome` uses a preinstalled Chromium.

## CI/CD (GitHub Actions)

| Workflow | Runs on | Does |
| --- | --- | --- |
| `ci.yml` | every pull request (and manually) | typecheck · unit tests with the 100 % gate (report as artifact) · E2E (Electron, web UI + core) · Docker image build |
| `cd.yml` | push to `main`/`develop` (merges), tags `v*` (releases) | **no tests**: builds the core image (API + web UI) and pushes it to `ghcr.io/robin7mh/mindeck` (`:develop`, `:main`, `:sha-…`; on a tag also `:1.2.3` and `:latest`); a tag also creates a GitHub Release with the web bundle |

To release: `git tag v0.2.0 && git push origin v0.2.0`.

`npm run build` and `npm run web:build` run Node with a 4 GB heap. Bundling Monaco (the editor
and its language workers) needs about 2.5 GB. On GitHub's runners for private repos (7 GB RAM)
and in Docker, Node otherwise picks only about 2 GB.

To make the tests mandatory before merging, enable branch protection for `main` and `develop`
(GitHub → Settings → Branches) and require the CI checks.

### Later: website / monorepo

When the Mindeck website arrives, the repo can become an npm-workspaces monorepo without changing
the shape of the pipeline:

- `apps/desktop`: this app
- `apps/web`: the website
- `packages/shared`: today's `src/shared`

Each app gets its own Dockerfile, and CI and CD run per workspace.

## What's on screen

| Region | Component | Notes |
| --- | --- | --- |
| Boot overlay | `BootSequence` | A typed boot log with progress that fades to reveal the shell (click to skip). |
| Top bar | `TopStatusBar` | Codename, live clock and mode/uptime/link status. Native traffic lights on macOS, custom window controls on Windows/Linux. Draggable region. |
| Left rail | `SideNavigation` | Core · Editor · Terminal · Projects · Memory · Agents · System · Settings, plus which core it is linked to. Collapses to icons only on narrow widths. |
| Center | the active module | See [Modules](#modules) below. |
| Right rail | `SystemMonitorPanel` | CPU/RAM gauges, sparklines and a process preview. Shown on Core only; every other module uses the full width. |
| Bottom | `BottomDashboard` | *Command Deck*: running agent sessions (jump in / end), waiting approvals, live activity. |
| Overlay | `ApprovalToasts` | An agent waiting for approval is visible in every module. |

### Modules

- **Core**: greeting, HUD clock, and tiles for projects, brain and system.
- **Editor**: Monaco (VS Code's editor core) on your project files, with file tree, tabs and ⌘S,
  as many editor groups as you like (⌘\\, ⌘K ⌘\\, drag a tab to an edge, ⌘1…⌘9 — each project
  remembers its layout), breadcrumbs and an outline. It follows changes made elsewhere.
- **Terminal**: real login shells (node-pty) in tabs or splits.
- **Projects**: git and stack detection plus structural context.
- **Memory**: the Obsidian vault with editor and graph.
- **Agents**: the agent cockpit described in [Agents](#agents-1).
- **System**: full telemetry.
- **Settings**: coding agents, the Mindeck Assistant, remote access and devices, permissions,
  vault, about.

### Design system (single source of truth)

- **Colors** are CSS variables in `src/index.css`, exposed as Tailwind tokens in
  `tailwind.config.ts`; components contain no hardcoded hex. Settings → Appearance
  (`src/lib/theme.ts`) picks the mode (dark, light, system), accent color and dark background.
  "Cyber" tints surfaces, lines, text and grid in the accent's hue; "black" and "graphite" stay
  neutral. The mode sets `data-theme`, accent and background override single tokens inline on
  `<html>`. The choice is saved per device and defaults to the OS in cyan. Only the variables
  change, never the components. Glows scale with the `--glow` token, are kept subtle and switch
  off in light mode.
- **One `Panel` primitive** (`src/components/ui/Panel.tsx`) gives every framed surface the same
  border and header treatment. `HudFrame` adds optional corner ticks. One shared glow token is
  used sparingly.
- **Typography**: Inter for UI and headlines, JetBrains Mono for all technical values, and small
  uppercase labels via `TechLabel`.
- **Motion**: boot → staggered panel entrance → pulsing status dots → typing terminal → hover
  glows → sliding nav indicator. All motion is subtle and turned off under
  `prefers-reduced-motion`.

### Not built yet

- the mobile app itself
- P5 memory pipeline, P10 Files, P11 Automations, P13 embeddings
- packaging: installers, signing, auto-update

See §12.4 in the architecture document.

## Project structure

```
electron/      the Mindeck core: main.ts (desktop window), preload.ts (window.mindeck bridge),
               ipc/ (router + channel bindings), main/core (createCore, EventHub),
               main/server (HTTP + WebSocket API), main/platform (electron | headless),
               main/services/ (agents, ai, auth, db, events, files, fs, git, memory, projects,
               system, terminal, …)
server/        main.ts: the same core, headless (out/server/index.cjs, Docker)
src/
  components/  shell · topbar · nav · monitor · dashboard · boot · ui
  features/    agents · session (pairing) · settings · dashboard · editor · projects · memory ·
               terminal · system · context
  shared/      contract, schemas, transport, types: shared by the core, the web UI and the mobile app
  hooks/ data/ lib/ types/
tests/
  unit/main      Vitest (node): services, core, API server, agent runtime, main.ts
  unit/renderer  Vitest (jsdom): stores, hooks, every component
  e2e            Playwright: the built Electron app, and the web UI against the core
docker-compose.yml · Dockerfile            the core image (API + web UI) for a home server
.github/workflows/                          ci.yml (PR tests) · cd.yml (image + release)
```

## Mobile app

The React Native app talks to the same core over HTTP and WebSocket with a per-device token.
The reference, including the pairing flow and a client sketch, is in [`docs/API.md`](docs/API.md).
The client code in `src/shared/ipc/transport.ts` runs in React Native unchanged.
