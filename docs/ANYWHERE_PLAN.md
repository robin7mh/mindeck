# Plan: Mindeck Anywhere – die App lebt auch ohne Mac

**Stand:** 2026-10-27 · freigegeben von Robin, noch nichts umgesetzt
**Gegenstück:** `mindeck-cloud` (Relay, Inbox, Cloud-Cores), `mindeck-mobile` (Wegwahl, Pocket). Alle Repos auf `develop`.
**Vor jeder Phase lesen:** `Mindeck_ARCHITECTURE.md` §1.2, §2.1, §9, §12.4, §12.7, dazu [`API.md`](API.md) (Encryption, Pairing) und [`MOBILE-REMOTE-2026-10.md`](MOBILE-REMOTE-2026-10.md) (Stand der App, M1–M5).
**Regeln:** Neue Fähigkeiten werden **einmal** in `src/shared/ipc/contract.ts` und `schemas.ts` angelegt. Jeder neue Weg zum Core läuft durch den Router, eine eigene Policy gibt es nicht.

## Context

Heute ist die Mobile-App nur ein Client des Cores auf dem Mac:
- `mindeck-mobile/src/app/_layout.tsx` lässt nur mit gekoppeltem Core in die App. `src/stores/core.ts` kennt nur `online/connecting/offline`. Auf dem Handy wird nichts gespeichert (`src/stores` hat keine Persistenz).
- Erreichbar ist der Core nur im selben WLAN (`https://<LAN-IP>:7420`). `docs/API.md` sagt für unterwegs: „Tailscale/WireGuard“.
- Ergebnis: Mac zu oder Handy draußen → die App ist tot (bis auf den eigenen Browser).

Das sind **zwei verschiedene Probleme**:
1. **Mac an, Handy unterwegs:** Die App erreicht den Mac nicht.
2. **Mac aus oder im Ruhezustand:** Es läuft nichts, das antworten könnte.

**Ziel:** Die App ist nie tot. Sie nimmt von selbst den besten Weg. Wenn gar kein Core läuft, kann man trotzdem weitermachen.

**Was schon da ist und trägt:**
- Der Core läuft headless: `server/main.ts`, `Dockerfile`, das Remote-SSH-Paket `remote/Dockerfile`, follower leases. Ein Core in der Cloud ist also derselbe Code.
- Ein Router für alles: `electron/ipc/router.ts` mit `CHANNEL_ACCESS` und Zod. Jeder neue Weg zum Core übernimmt Rechte, den Schalter für Remote-Shells, RemoteScope und Rate-Limits.
- Die Cloud kennt Konto, Geräte (`/v1/me/devices`) und Push (`/v1/push/notify`). Die KI über die Cloud nimmt das Handy-Token schon an (`mindeck-cloud/src/modules/ai/routes.ts:92` schließt nur `web` aus). Ein Assistent ohne Mac ist also möglich.
- `npm run sync:shared` bringt geteilten Protokollcode 1:1 aufs Handy.

---

## Zielbild: vier Wege, eine App

| Lage | Weg | Was geht |
|---|---|---|
| Mac an, gleiches WLAN | **Direkt** (wie heute) | alles |
| Mac an, Handy unterwegs (5G, fremdes WLAN) | **Relay** über Mindeck Cloud, Ende-zu-Ende verschlüsselt | alles, wie im WLAN |
| Mac aus oder zugeklappt | **Cloud-Core**: dein eigener Mindeck in der Cloud (Abo) | Agents, Terminal, Git, Notizen: echt weiterarbeiten |
| kein Core erreichbar (kein Abo, kein Netz) | **Pocket** auf dem Handy | letzten Stand lesen, Notizen schreiben, Aufträge in die Warteschlange, Assistent über die Cloud-KI |

Die App wählt selbst: direkt vor Relay, Mac vor Cloud-Core. Ein Chip zeigt den Weg: „Mac · WLAN“, „Mac · unterwegs“, „Mac schläft seit 23:14“, „Cloud“, „Offline · Stand 14:32“.

**Demo-Momente (für Launch-Videos):**
1. Im Zug auf 5G: Terminal auf dem Mac, Claude Code fixt einen Bug, Freigabe per Push. *(Phase 1)*
2. Mac zu, im Café: „Fix den Login-Bug im Shop“ tippen. Der Auftrag wartet. Mac aufklappen → er startet von selbst, Push „Auftrag gestartet“. *(Phase 2)*
3. Mac zu, der Agent läuft trotzdem: in der Cloud. Das Ergebnis kommt als PR, Diff am Handy prüfen, mergen. *(Phase 3)*
4. Abends am Mac: die Session aus der Cloud übernehmen und genau dort weitermachen. *(Phase 5)*

**Sicherheitsversprechen (für die Website):** Auf den Mac kommt man auch über die Cloud nur mit einem per QR gekoppelten Gerät. Die Cloud reicht nur verschlüsselte Bytes weiter. Selbst eine gehackte Cloud kommt nicht an deinen Mac.

## Entscheidungen (Robin, 2026-10-27)

- **D1: Cloud-Core kommt, als Abo.** Die Doktrin „der Core bleibt lokal“ gilt weiter als Standard. Der Cloud-Core ist optional, ausdrücklich gewählt und bezahlt, die Daten bleiben exportierbar.
- **D2: Hosting ist offen.** Der bisherige Server (über 25space.com, betreut von Robins Serveradmin) wird aufgelöst. Zu unterscheiden sind zwei Dinge:
  - **Cloud-API, Relay und Website** laufen auf einem normalen Server mit Docker Compose (`mindeck-cloud/deploy/`). Das kann der Admin übernehmen. Gebraucht wird es ab Phase 0, für das Relay ab Phase 1.
  - **Cloud-Cores** (ab Phase 3) brauchen pro Nutzer eine **isolierte VM**, denn Agents führen dort beliebigen Code aus. Fragen an den Admin:
    1. Gibt es eine eigene VM pro Nutzer (KVM/Firecracker), nicht nur Container?
    2. Lassen sich VMs per API anlegen, starten, in den Ruhezustand schicken und löschen?
    3. Wacht eine VM aus dem Ruhezustand in wenigen Sekunden auf?
    4. Bekommt jeder Nutzer ein Volume, das erhalten bleibt?
    5. Standort in der EU, mit AV-Vertrag?
    6. Was kostet eine VM mit 2 vCPU und 4 GB RAM, die meist schläft?

    Kann der Admin das nicht, laufen die Cloud-Cores bei Fly.io in Frankfurt. Das ist der Rückfallweg und auch die Empfehlung. Der Code kennt nur das Interface `CoreHost`, ein späterer Wechsel braucht also nur einen neuen Adapter. Phase 1 und 2 hängen nicht davon ab.
- **D3: Relay nach dem Koppeln an.** Beim Koppeln erklärt ein Satz, dass die Cloud nur verschlüsselte Bytes sieht. Ausschalten geht unter Settings → Remote-Zugriff.

---

## Phase 0 – Voraussetzungen (aus MOBILE-REMOTE M1, M3, M4)

- **M3:** mindeck-cloud läuft produktiv unter `api.mindeck.de` (`deploy/` steht schon), auf dem neuen Server (D2). Ohne Cloud gibt es kein Relay. Die Website (`mindeck-web`) kann auf denselben Server.
- **M1:** SPKI-Pin unter iOS (`modules/mindeck-net/ios`). Für direkte Verbindungen bleibt er nötig.
- **M4:** Apple Developer Program und EAS, damit Push und echte Builds laufen.

**Fertig, wenn:** ein echter iOS-Build per QR koppelt, Push ankommt und `api.mindeck.de/health` mit 200 antwortet.

---

## Phase 1 – „Unterwegs“: Relay über Mindeck Cloud (Mac an, Handy überall)

**Prinzip:** Der Core baut eine **ausgehende** WebSocket-Verbindung zur Cloud auf. Kein offener Port, nichts am Router einstellen. Das Handy verbindet sich mit der Cloud, die Cloud reicht nur Bytes durch. Innen sprechen Handy und Core über einen Noise-Kanal. Den Schlüssel dafür bekommt das Handy beim Koppeln. Die Cloud kann deshalb weder mitlesen noch sich dazwischenschalten.

### 1a Protokoll (geteilt, kommt per `sync:shared` aufs Handy)
- **Neu `src/shared/relay/noise.ts`:** `Noise_IK_25519_ChaChaPoly_BLAKE2s` auf `@noble/curves`, `@noble/ciphers` und `@noble/hashes`. Das ist reines JS und läuft in Hermes; auf dem Handy braucht es `getRandomValues` über `expo-crypto`. Das Handy ist Initiator und kennt den statischen Schlüssel des Cores. Der Core ist Responder und prüft den statischen Schlüssel des Handys gegen das gekoppelte Gerät.
- **Neu `src/shared/relay/frames.ts`:** die Nachrichten im Tunnel.
  - `hello { token, resume? }`
  - `rpc { id, channel, payload }` und `res { id, result }`
  - `event { channel, payload, stream, seq }`
  - `ping` und `pong`

  Die Bedeutung ist dieselbe wie bei `POST /api/rpc` und `WS /api/events`, Replay über `stream`/`since` eingeschlossen.
- **`src/shared/ipc/transport.ts`:** neu `createRelayTransport(...)`. Sie implementiert `Transport` wie `createRemoteTransport`, die Stores merken keinen Unterschied.
- **Schlüssel:**
  - Der Core erzeugt ein X25519-Schlüsselpaar und legt es im SecretStore ab (headless: als 0600-Datei).
  - `server:createPairingCode` und `POST /api/pair` liefern zusätzlich `relayKey` und `cloudInstallId`. Der QR-Link bekommt `&rk=` und `&ci=`, `parsePairingLink` liest beides.
  - Das Handy erzeugt sein eigenes Schlüsselpaar (in SecureStore) und schickt den öffentlichen Schlüssel beim Koppeln mit. `AuthService` speichert ihn als `relayKey` am Gerät in `devices.json`.
- **Koppeln von unterwegs:** Es reicht, den QR-Code am Mac zu scannen; das Koppeln läuft dann durch den Tunnel. Von Hand eingetippte Codes gehen nur im WLAN, denn ein Code mit 8 Zeichen ist als Schlüssel gegen ein böswilliges Relay zu schwach.

### 1b Core (`mindeck`)
- **`electron/main/server/HttpServer.ts`:** RPC- und Event-Logik werden von HTTP getrennt. Ein Client ist künftig eine „Senke“ mit `send`, `device` und `stream`, entweder WebSocket oder Relay-Pipe. Für beide Wege läuft derselbe Code: `auth.verify`, `router.dispatch`, `DeviceRateLimiter`, `scope`/RemoteScope und `EventStreams`. Es gibt **keinen** zweiten Pfad mit eigener Policy.
- **Neu `electron/main/server/RelayLink.ts`:**
  - Steuerverbindung zu `wss://api…/v1/relay/core`. Bearer ist die Cloud-Sitzung des Cores aus `CloudService`; Reconnect mit Backoff.
  - Bei `open { pipe }` wählt der Core `…/v1/relay/accept?pipe=` an, führt als Responder den Noise-Handshake und hängt die Pipe als Client an.
  - Die Pipe hat die Adresse `relay`, nie Loopback. Sie bekommt also nie die Rechte von „dieser Computer“.
- **`electron/main.ts`, `powerMonitor`:** Bei `suspend` schickt der Core `{ t: 'sleep' }` ans Relay. Bei `resume` verbindet er sofort neu.
- **Wach halten:** über `powerSaveBlocker.start('prevent-app-suspension')`.
  - „Wach bleiben, solange am Strom und Unterwegs an ist“
  - „Wach bleiben, solange ein Agent läuft“

  Im UI ehrlich sagen: Ein zugeklapptes MacBook ohne externen Monitor schläft trotzdem.
- **Settings → Remote-Zugriff:** Schalter „Unterwegs erreichbar (über Mindeck Cloud, Ende-zu-Ende verschlüsselt)“. Voraussetzung: API-Server an und Konto angemeldet. Der LAN-Schalter wird dafür nicht gebraucht.
- **Headless (`server/main.ts`):** `MINDECK_RELAY=1` ist an, sobald die Cloud angemeldet ist. Damit ist jeder Docker-Core auf einem eigenen Server ohne Tailscale erreichbar („Bring your own server“, ohne Abo).

### 1c Cloud (`mindeck-cloud`)
- **Neu `src/modules/relay/`:**
  - `routes.ts`: drei WebSockets, `core`, `connect` und `accept`
  - `registry.ts`: ordnet jeder `installId` ihre Steuerverbindung zu, im Speicher; für den Start reicht eine Instanz
  - `limits.ts`
- **Regeln:**
  - `connect` nur mit `client: mobile` desselben Kontos wie der Core.
  - `core` nur für `desktop`/`server` mit Gerät.
  - Frames höchstens 256 KB, höchstens 10 Pipes pro Konto, ein Leerlauf-Timeout, Ping alle 25 s.
  - Bytes werden pro Konto und Monat gezählt (Fair Use).
  - Die Cloud speichert keinen Inhalt. Geloggt werden nur Konto, Zeit und Bytes.
- **`GET /v1/relay/cores`:** liefert die Cores des Kontos mit `name`, `online`, `sleepingSince`, `lastSeen` und `hosted`.
- **`deploy/`:** Die Caddy-Timeouts für `/v1/relay/*` müssen für lange WebSocket-Verbindungen reichen. Die Relay-Metadaten kommen in die Datenschutzerklärung.

### 1d Mobile (`mindeck-mobile`)
- **Neu `src/lib/link.ts`, genutzt von `src/lib/core.ts`:** wählt den Weg wie bei „Happy Eyeballs“.
  - Direkt (letzte LAN-Adresse, gepinnt) und Relay starten parallel. Antwortet direkt in etwa 1,5 s, gewinnt direkt.
  - Bei einem Netzwechsel (`expo-network`) wählt die App neu, ohne die Stores zu leeren. Das Replay füllt die Lücke.
- **`src/stores/core.ts`:** `link` bekommt `via: 'lan' | 'relay'`. `LinkChip` in `src/components/link-state.tsx` zeigt Weg und Schlafzustand.
- **`src/app/pair.tsx`:** übernimmt `rk` und `ci` aus dem QR-Code. Antwortet das LAN nicht, wird über das Relay gekoppelt.

### Fertig, wenn
- Handy im Mobilfunk mit WLAN aus: Terminal, Agents, Freigaben, Files und Notizen gehen wie im WLAN. Ein Wechsel zwischen WLAN und 5G mitten in einer Terminal-Sitzung braucht kein Neuladen.
- Ein Relay, das Bytes verfälscht, vertauscht oder einschleust, führt zum Abbruch, nie zu falschen Daten. Ein fremdes Konto bekommt keine Pipe.
- Der Snapshot in `tests/unit/main/channel-access.test.ts` bleibt unverändert: Das Relay öffnet keine neuen Kanäle.

### Tests
- **Core unit:**
  - Noise gegen die offiziellen Testvektoren (cacophony); Frames.
  - `RelayLink` mit einem Fake-Relay: Reconnect, Schlaf.
  - Gleichheit beider Wege: dieselbe Testtabelle für WebSocket und Pipe, mit Auth, `remote-forbidden`, Rate-Limit und Replay.
  - Die Pipe bekommt nie Loopback-Rechte.
- **Cloud integration** (gegen echtes Postgres wie bisher): falsches Konto, falscher Client, Limits, Bytezähler; ist der Core weg, schließt die Pipe.
- **E2E `tests/e2e/app-relay.spec.ts`:** Core, lokale Cloud und ein Node-Client über das Relay. Koppeln per QR-Link, Echo im Terminal, Event-Replay nach einem Abriss.

---

## Phase 2 – „Pocket“: Die App ist nie tot (kein Core erreichbar)

### 2a Letzter Stand, offline lesbar
- **Neu `src/lib/offline/` (Mobile, `expo-sqlite`):** speichert pro Core die Antworten ausgewählter Lesekanäle.
  - `projects:list`, `scm:status`, `scm:log`
  - `agents:list`, `agents:get`, `agents:changes`, `agents:diff`
  - `memory:list`, `memory:read`, `memory:folders`
  - `events:recent`, `system:snapshot`

  Die Liste steht in `src/lib/offline/channels.ts`.
- **`invoke` in `src/lib/core.ts`:** online wird die Antwort gespeichert. Offline kommt sie aus dem Cache, zusammen mit `stale: { at }`.
- **UI:** Banner „Offline · Stand 14:32“. Schreibaktionen sind ausgegraut, mit Hinweis; Ausnahmen sind 2b und 2c.
- **Einstellung „Offline-Kopie“:** standardmäßig an, mit Größengrenze. Sie umfasst Notizen und die letzten 20 Sessions; dazu der Knopf „Offline-Kopie löschen“.

### 2b Notizen offline schreiben
- **Neu `src/lib/offline/outbox.ts`:** `memory:write` und `memory:create` gehen offline in eine Warteschlange, mit dem Hash der zuletzt gelesenen Version.
- Beim Wiederverbinden werden sie angewendet. Hat sich die Notiz am Mac inzwischen geändert, wird nie still überschrieben: Es entsteht eine Konfliktkopie `Name (iPhone 2026-10-27).md`, und die App zeigt einen Hinweis.
- **Core:** `memory:write` bekommt `expectedHash?` und antwortet `conflict`. Das Muster ist `expectedMtime` beim Editor (`src/shared/ipc/contract.ts:225`).

### 2c Aufträge: „Erledigen, sobald der Mac da ist“ (das Herzstück)
- **Mobile:** Ist der Core offline, heißt der Knopf im Composer (`src/components/agent-composer.tsx`, `src/app/new-chat.tsx`) „Wenn der Mac aufwacht“ statt „Senden“. Ein Auftrag hat die Form `{ id, kind: 'agent.start' | 'memory.append', projectId, agent, model?, mode?, prompt, images?, createdAt }`.
- **Ende-zu-Ende:** Das Handy verschlüsselt den Auftrag mit `Noise_X` an den statischen Schlüssel des Cores aus Phase 1. Nur dieser Core kann ihn lesen, und er weiß sicher, von welchem Gerät er kommt.
- **Cloud, neu `src/modules/inbox/`:** speichert nur Chiffretext.
  - `POST /v1/inbox` vom Handy: höchstens 1 MB, höchstens 100 offen, 14 Tage aufbewahrt
  - `GET /v1/inbox?core=` vom Core
  - `DELETE /v1/inbox/:id`

  Ist der Core verbunden, meldet ihm die Steuerverbindung des Relays einen neuen Auftrag sofort.
- **Core, neu `electron/main/services/inbox/InboxService.ts`:**
  - Beim Online-Werden und beim Aufwachen holt er die Aufträge ab, entschlüsselt sie und prüft den Absender gegen `devices.json`.
  - Danach führt er sie **über den Router als dieses Gerät** aus (`agents:create` + `agents:send`), also mit denselben Rechten wie live. Ohne Remote-Shells gibt es keinen Agent.
  - Er bestätigt den Start per Push. Dafür bekommt `mindeck-cloud/src/modules/push/routes.ts` die neuen Arten `task_started` und `task_failed`.
  - Ins Aktivitätslog kommt `device.inbox` (Klasse `audit`). Die `id` macht die Ausführung idempotent.
- **Am Mac:** Das Command Deck zeigt „3 Aufträge vom iPhone“. Eine Einstellung „Vor dem Start fragen“ ist standardmäßig aus; bei Projekten ohne Trust fragt der Mac immer.

### 2d Assistent ohne Mac
- Ist kein Core erreichbar, läuft „Ask Mindeck“ (`src/components/assistant-view.tsx`) auf dem Handy selbst, gegen `POST /ai/v1/messages`. Es gilt das Guthaben wie bisher.
- **Neu `src/lib/pocket-assistant.ts`:** eine kleine Werkzeugschleife mit Werkzeugen auf dem Handy: Offline-Notizen suchen und lesen, eine Notiz anlegen (geht in die Outbox), einen Auftrag anlegen (2c).
- Die Antworten sind gekennzeichnet: „läuft auf dem Handy“.

### Fertig, wenn
- Im Flugmodus: Die App öffnet, Projekte, Sessions und Notizen sind mit „Stand“-Banner lesbar, eine Notiz lässt sich schreiben und ein Auftrag anlegen.
- Mac aufklappen: Die Notiz ist am Mac, der Auftrag startet von selbst, der Push kommt.
- Mac aus, Handy im WLAN: Der Assistent antwortet über die Cloud-KI.

### Tests
- **Core unit:**
  - `InboxService`: entschlüsseln, falsches Gerät, entzogenes Gerät, Ablehnung ohne Remote-Shells, doppelte Zustellung.
  - `memory:write` mit `expectedHash`.
- **Cloud:** Grenzen, fremdes Konto, Ablauf nach 14 Tagen.
- **E2E `app-inbox.spec.ts`:** Auftrag in die Cloud, Core startet, Session existiert.
- **Mobile:** tsc und lint, dazu ein Handtest im Flugmodus.

---

## Phase 3 – Cloud-Core „Always-On“ (Mac aus, trotzdem arbeiten) · Abo

**Prinzip:** Jeder Abo-Kunde bekommt einen eigenen Mindeck-Core in der Cloud. Es ist derselbe headless Core, mit eigener MicroVM und eigenem Volume. Er hat **keinen offenen Port** und verbindet sich wie jeder Core nur ausgehend mit dem Relay. Für die App ist er einfach ein zweiter Core namens „Cloud“. Neuer Code auf dem Handy entsteht kaum.

### 3a Image (`mindeck`)
- **Neu `cloudcore/Dockerfile`**, auf Basis von `Dockerfile` und `remote/Dockerfile`:
  - der Core (`out/server`)
  - git, ripgrep, Node, Python und Build-Werkzeuge
  - Claude Code, Codex und Gemini CLI vorinstalliert
  - ein Benutzer ohne root, `MINDECK_HOME=/data/Mindeck`, Projekte unter `/data/code`
- **Umgebung:** `MINDECK_RELAY=1`, `MINDECK_REMOTE_TERMINAL=1` und `MINDECK_HOSTED=1`. Letzteres koppelt über das Konto statt per Code und blendet reine Desktop-Dinge aus.

### 3b Orchestrierung (`mindeck-cloud`)
- **Neu `src/modules/hosted/`:**
  - `provider.ts` mit dem Interface `CoreHost`: `create`, `start`, `suspend`, `destroy`, `status`
  - eine erste Umsetzung gemäß D2: der Adapter des Admins oder `fly.ts` (Fly Machines API, Region `fra`, eine Maschine und ein Volume pro Konto)
- **Aufwecken:** Kommt `connect` für einen gehosteten Core und ist er offline, ruft die Cloud `start` auf, wartet, bis er sich meldet, und gibt dann die Pipe. Ziel: unter 5 s aus dem Ruhezustand, unter 30 s kalt. Ein Auftrag aus der Inbox weckt ihn ebenso.
- **Schlafen:** Der Core meldet „idle“, wenn keine Clients verbunden sind, kein Agent läuft und kein Terminal-Prozess im Vordergrund ist. Nach 15 min folgt `suspend`. **Laufende Agents halten ihn wach**, genau darum geht es.
- **Koppeln über das Konto:**
  - Die Handys des Kontos melden ihren öffentlichen Relay-Schlüssel bei der Cloud.
  - Die Cloud signiert jeden Schlüssel mit dem Entitlement-Key: `mindeck-dk1.<{ sub, dev, relayKey, exp }>.<sig>`.
  - **Nur** ein Core mit `MINDECK_HOSTED=1` nimmt solche Geräte an. Der Mac verlangt weiter das QR-Koppeln, so gilt das Sicherheitsversprechen.
  - Ehrlich dazusagen: Beim Cloud-Core vertraust du Mindeck als Betreiber, wie bei jedem Cloud-Dienst.
- **Lizenz:** Der gehostete Core meldet sich als `client: server` mit `hosted: true` an. Sein Token stellt die Cloud beim Anlegen aus, nur als Secret der Maschine. Er zählt nicht gegen `DEVICE_LIMIT`.
- **Abo in `src/modules/billing/`:**
  - Stripe Checkout mit `mode: subscription`.
  - Webhooks: `customer.subscription.updated` und `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
  - Neue Tabelle `hosted_cores`: Konto, Provider-ID, Volume, Zustand, Region, Nutzungssekunden.
  - Nach einer Kündigung wird der Core gestoppt. Das Volume bleibt 30 Tage, ein Export ist möglich, dann wird es gelöscht.
- **Fair Use:** CPU-Stunden pro Monat. Bei 80 % kommt eine Mail. Bei 100 % starten keine neuen Agents mehr; laufende laufen zu Ende.
- **Admin:** Liste der Cloud-Cores mit Zustand und Kosten, dazu eine Notbremse.

### 3c Einrichten ohne Mac (Mobile, neu `src/app/cloud-core.tsx`)
- „Mindeck Cloud starten“ → Abo (Stripe im Browser) → Fortschritt, bis der Core steht.
- **Erstausstattung, von der App geführt:**
  1. **GitHub verbinden** (Device Flow), Repos wählen, klonen.
  2. **Claude Code anmelden:** Der Login-Ablauf der CLI läuft im Terminal des Cloud-Cores. Der Link öffnet sich im Handy-Browser, der Code geht zurück. Alternativ ein API-Key. Codex und Gemini gehen genauso.
- **Vor dem Launch prüfen**, was die Bedingungen von Anthropic, OpenAI und Google zur Nutzung der eigenen Abos auf einer gemieteten Maschine sagen. Hier nichts annehmen.

### 3d Mac ↔ Cloud-Core
- Desktop, Settings → „Mindeck Cloud“: Status und „Projekt in der Cloud verfügbar machen“ (Remote setzen, pushen, der Cloud-Core klont). **Git ist der Sync**; eine eigene Dateisynchronisation gibt es in v1 nicht.
- Das Handy zeigt die Projekte beider Cores in einer Liste, gekennzeichnet als Mac, Cloud oder beide.

### Fertig, wenn
- Mac aus. Vom Handy aus: Cloud-Core wecken, ein Projekt von GitHub holen, Claude Code etwas fixen lassen, den Diff prüfen, Commit, Push und PR.
- App zu, der Agent läuft weiter, der Push „fertig“ kommt.
- 15 min später schläft der Core und kostet nur noch Speicher.

### Tests
- **Cloud:** Fake-`CoreHost` (anlegen, Wecken bei `connect`, `suspend` nach Leerlauf, Kündigung, Zahlungsausfall), Webhooks, Fair Use, Geräte-Bestätigung (`mindeck-dk1`).
- **Core:** `MINDECK_HOSTED` nimmt Geräte vom Konto an, ein normaler Core nie (Test); Snapshot der Kanäle.
- **Vor dem Launch** ein Staging-Lauf gegen echte Maschinen: Kaltstart, Ruhezustand und Aufwachen, das Volume bleibt erhalten.

---

## Phase 4 – Notizen überall (Vault: Mac ↔ Cloud-Core ↔ Handy)

- Der Vault ist Markdown, also ein Sync auf Dateiebene. Core und Core gleichen sich über das Relay ab. Der Cloud-Core ist dabei der immer erreichbare Partner. Die Handy-Kopie aus Phase 2 wird vom Cache zu einer vollständigen Kopie.
- Pro Datei: Hash und eine Versionsuhr pro Core. Text wird mit 3-Wege-Merge zusammengeführt, sonst entsteht eine Konfliktkopie. Neu `electron/main/services/memory/VaultSync.ts`.
- Wer schon iCloud oder Obsidian Sync nutzt, schaltet es aus.

**Fertig, wenn:** Eine am Handy offline geschriebene Notiz erscheint am Mac, auch wenn beide nie gleichzeitig online waren (über den Cloud-Core). Ohne Abo gilt Phase 2: nur direkt zwischen Mac und Handy.

## Phase 5 – Übergabe: Die Session wandert mit

Ein Agent läuft, der Mac geht schlafen. Dann:

1. Der Mac fragt (dazu ein Push): „In der Cloud weiterlaufen lassen?“
2. Der Core committet den Stand des Worktrees auf `mindeck/handoff/<session>` und pusht.
3. Er schickt die Session-Datei des Agents (bei Claude Code das Transkript als JSONL) verschlüsselt über das Relay an den Cloud-Core.
4. Dort läuft die Session mit `--resume` weiter. Der Rückweg zum Mac geht genauso.

Zuerst nur für Claude Code; Codex und Gemini, sobald deren Resume das hergibt.

**Fertig, wenn:** Eine Session startet auf dem Mac, der Deckel geht zu, am Handy läuft sie in der Cloud weiter. Abends holt der Mac sie zurück, der Verlauf ist vollständig.

---

## Was bewusst nicht geht (ehrlich kommunizieren)

- Einen ausgeschalteten oder zugeklappten Mac von außen wecken, geht nicht zuverlässig. Wake-on-LAN funktioniert nur im eigenen Netz. Darum gibt es den Cloud-Core.
- Projektdateien selbst synchronisieren: nein. Git ist der Sync.
- Den Browser des Macs fernbedienen: bleibt weg (Entscheidung vom 2026-10-25).

## Geschäft

- **79 € Lifetime bleibt** und enthält Relay (Unterwegs), Pocket und Aufträge. Damit ist die App für jeden Käufer sofort mehr wert.
- **Neues Abo „Mindeck Cloud“** (Vorschlag: 12 €/Monat oder 120 €/Jahr): Cloud-Core plus mehr KI-Guthaben.
  - Erste wiederkehrende Einnahme.
  - Neue Zielgruppen: Leute ohne Rechner, der immer läuft, nur mit iPad, Windows auf der Arbeit.
- Die Kosten pro Abo vor dem Launch nachrechnen. Ziel: Infrastruktur unter ⅓ des Preises.
- **Messgrößen:** Anteil der Relay-Nutzung, Aufträge pro Woche, Umstieg von Lifetime aufs Abo.
- **Apple-Review (M5):** Ein Demo-Konto mit Cloud-Core löst das Prüfproblem.

## Reihenfolge und Aufwand (grob)

| Phase | Wert | Aufwand |
|---|---|---|
| 0 Voraussetzungen | Pflicht | klein bis mittel (Konten, Deploy) |
| 1 Relay | sehr hoch | mittel bis groß (Teilung von HttpServer, Noise, Relay) |
| 2 Pocket und Aufträge | hoch | mittel |
| 3 Cloud-Core | sehr hoch, bringt Umsatz | groß |
| 4 Vault-Sync | mittel | mittel |
| 5 Übergabe | großer Demo-Effekt | mittel |

## Arbeitsweise

- In allen Repos auf `develop`, keine neuen Branches. Vor Commit und Push fragen.
- **Erster Schritt der Umsetzung:** diesen Plan als `mindeck/docs/ANYWHERE_PLAN.md` ablegen.
- **Nach jeder Phase die Doku nachziehen:**
  - `Mindeck_ARCHITECTURE.md` um einen Abschnitt §12.x ergänzen. Die Doktrin „der Core bleibt lokal“ in §12.4 und §12.7 um den Cloud-Core erweitern.
  - `docs/API.md` (Relay, Inbox) und die README der Cloud (Endpunkte) ergänzen.
- Neue Kanäle einmal in `contract.ts` und `schemas.ts` anlegen, dann im Mobile-Repo `npm run sync:shared`.

## Verifikation (gesamt)

- **mindeck:** `npx vitest run`, `npm run typecheck`, Playwright-E2E einschließlich der neuen `app-relay.spec.ts` und `app-inbox.spec.ts`.
- **mindeck-cloud:** `npm run db:up && npm test`, `npm run typecheck`.
- **mindeck-mobile:** `npm run sync:shared`, `npx tsc --noEmit`, `npx expo lint`, `npx expo-doctor`.
- **Handtest auf dem iPhone:** WLAN aus (Relay), Flugmodus (Pocket), Mac zu (Aufträge und Cloud-Core).
