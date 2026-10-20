# Mindeck Core API

The Mindeck core speaks one contract to every client: the desktop window (over Electron IPC), the
web UI and the mobile app (over HTTP + WebSocket). This page is the reference for network clients —
first of all the React Native app.

- Contract (every channel, request and response type): [`src/shared/ipc/contract.ts`](../src/shared/ipc/contract.ts)
- Request validation (Zod, the same schemas the core enforces): [`src/shared/ipc/schemas.ts`](../src/shared/ipc/schemas.ts)
- Ready-made client (only `fetch` + `WebSocket`, works in React Native as is): [`src/shared/ipc/transport.ts`](../src/shared/ipc/transport.ts)
- Domain types: [`src/shared/types/`](../src/shared/types)

All of these are plain TypeScript with no DOM, Node or Electron imports — copy them into the app, or
(better) move them into a shared workspace package once the app repository exists.

## Where the core runs

| Host | Start | Base URL |
|---|---|---|
| Desktop app | Settings → Remote access → *Run the API server* (+ *Reachable on the local network* for a phone) | `https://<computer-ip>:7420` (this computer: `http://127.0.0.1:7420`) |
| Standalone (no Docker) | `npm run web` | `http://127.0.0.1:7420` (`MINDECK_LAN=1` for all interfaces: then `https://`) |
| Docker | `npm run docker:up` | `https://127.0.0.1:7420` (`MINDECK_BIND=0.0.0.0` in `.env` for the LAN) |

For access from outside your home network use a VPN such as Tailscale or WireGuard rather than
opening the port to the internet.

### Encryption (HTTPS / WSS)

A core that the network can reach speaks **HTTPS and WSS** (desktop: Settings → Remote access →
*Encrypted (HTTPS)*, on by default; headless: `MINDECK_TLS=1`, the default). One port serves both
protocols: the computer the core runs on may keep plain HTTP on `127.0.0.1` (the local web UI,
health checks, tests); everyone else gets HTTPS only. A plain HTTP request from the network is
never answered: a page request (`GET`/`HEAD`) is redirected (`308`) to the same `https://`
address, anything else — a pairing code, a token — gets `403 https-required`, and so does a plain
WebSocket.

**Certificate.** Without one of its own, the core makes a self-signed certificate on the first start
with network access: RSA 2048, SHA-256, valid two years, for `localhost`, `127.0.0.1`, the machine
name (and `<name>.local`) and every LAN address. It lives in `<MINDECK_HOME>/data/tls/` (`key.pem`
with mode `0600`) and is made anew — on the same key — a month before it ends and when the
computer has an address it does not cover (checked at start, before every pairing and twice a day).
An own certificate (e.g. from Let's Encrypt for a domain that points at the core) is given with
`MINDECK_TLS_CERT` and `MINDECK_TLS_KEY` (PEM files, both); it is used as it is (renew it outside and
restart the core). `MINDECK_TLS=0` switches HTTPS off — e.g. behind a reverse proxy (Caddy, nginx,
Traefik) or `tailscale serve` that terminates TLS itself and reaches the core on `127.0.0.1`.

**Names (DNS rebinding).** The core answers only requests whose `Host` is one of its own names: an
IP address, `localhost`, the machine name (and `<name>.local`) or a name in its certificate.
Anything else gets `403 host-not-allowed` — a web page that points its own domain at the core
cannot talk to it. Other names the core is reached by (a reverse proxy's domain, the Docker host's
name, `tailscale serve`) go into `MINDECK_ALLOWED_HOSTS` (comma-separated; `.example.com` = every
subdomain, `*` = any name).

**Behind a proxy on the same computer.** Requests from `127.0.0.1` count as this computer's —
plain HTTP is allowed for them while the core speaks HTTPS. A request carrying `X-Forwarded-For`,
`X-Real-IP` or `Forwarded` is a proxy passing someone else on: it is not trusted like this computer
(no plain HTTP while TLS is on), and failed pairings are counted per address it passes on, not for
`127.0.0.1` as a whole. Only ever let a proxy you run reach the core's port.

**Trust without a certificate authority (TOFU).** Nobody vouches for a self-signed certificate, so a
browser shows a warning once. The pairing QR code therefore carries the certificate's SHA-256
fingerprint: `https://192.168.1.20:7420/#pair=K7QM-2XPA&fp=<64 hex digits>`. The web UI shows it
on the pairing page and asks to compare it with the one in the browser's certificate viewer;
Settings → Remote access shows it too (`AB:CD:…`), as does the server's pairing banner. Over HTTPS
the core answers `POST /api/pair` with the same `fingerprint`. A native client compares the
certificate of its first connection with `fp` from the QR code (refuses on a mismatch), then pins
it. `server:status` reports `tls: { fingerprint, spkiFingerprint, expiresAt, selfSigned }` while the
core speaks HTTPS; `server:createPairingCode` returns `fingerprint` and `spkiFingerprint`.

**Pin the public key, not the certificate.** The core renews its self-signed certificate a month
before it ends and whenever the computer gets an address it does not cover (another Wi-Fi) — always
on the same key. `fingerprint` (the certificate's SHA-256) changes then; `spkiFingerprint` (SHA-256
of the DER SubjectPublicKeyInfo, `AB:CD:…`) does not. The QR code carries it as `&pk=<64 hex
digits>` next to `&fp=`, `POST /api/pair` answers it next to `fingerprint`. A client that pins
`spkiFingerprint` keeps working across renewals; `fingerprint` stays for clients that pin the
certificate (they need to pair again after a renewal).

Headers over HTTPS: the usual `nosniff`, `no-referrer`, `DENY` framing and CSP; `Strict-Transport-
Security` only with an own certificate from an authority — with a self-signed one HSTS would turn
the warning (that a person may pass after comparing the fingerprint) into a dead end. Apps send their
token in headers (`Authorization`, the WebSocket subprotocol); the only cookie is the web UI's own
(*The web UI's browser session* in §1), `Secure` over HTTPS.

**The mobile app** trusts only the system's certificate authorities (React Native's `fetch` and
`WebSocket`); pinning a self-signed certificate needs a native module. Until the app pins
`fingerprint`, pair it with a core that has an own trusted certificate or runs behind Tailscale /
a reverse proxy, or switch *Encrypted (HTTPS)* off on a network you trust.

## 1. Pairing (once per device)

1. On a device that is already trusted: Settings → *Pair a device*. It shows a code like
   `K7QM-2XPA` (valid 10 minutes, one use) and a QR code with `http(s)://<core>/#pair=K7QM-2XPA`
   (over HTTPS also `&fp=<sha256>`, the certificate's fingerprint, and `&pk=<sha256>`, its public
   key's — see *Encryption*).
   Headless: `npm run server:pair` or `npm run docker:pair` (append `-- --admin` for an admin
   device). The standalone server also prints a code at startup as long as no device is paired.
2. The app reads the URL from the QR code (`parsePairingLink` in `transport.ts` → `{ baseUrl, code,
   fingerprint?, spkiFingerprint? }`), or the user types the address and the code. With a `fingerprint`, check the
   certificate of the first connection against it before sending the code.
3. Redeem the code:

```http
POST /api/pair
Content-Type: application/json

{ "code": "K7QM-2XPA", "name": "Pixel 9" }
```

```json
{ "ok": true, "data": { "token": "mindeck_…", "device": { "id": "…", "name": "Pixel 9", "role": "member", "createdAt": "…" }, "fingerprint": "AB:CD:…", "spkiFingerprint": "EF:01:…" } }
```

(`fingerprint` and `spkiFingerprint` only over HTTPS: the certificate and its public key to pin.)

Every device has a **role**, set by the code it redeemed:

- `member` (the default): projects, memory, the assistant, the agent cockpit and approvals, within
  the remote rules below.
- `admin`: also pairs and removes devices and changes their roles, sets the AI key, and signs the
  core in or out of the Mindeck account (channels marked *admin* in §4). Given at the desktop when
  pairing (*Pair as admin*) and changeable in the device list there; on a headless core its first
  device is admin, and so are devices paired before roles existed.

Store the token in the platform's secure storage (`expo-secure-store` / Keychain / Keystore). It is
shown exactly once; the core only keeps its SHA-256. Wrong codes answer `401 bad-code`; ten failures
in ten minutes from one address (IPv6: one `/64`) answer `429`. A pairing request may be 16 KB.

A token that is not used for 90 days expires: the core forgets the device, which then gets
`401 unauthorized` and has to pair again.

### The web UI's browser session (cookie)

The web UI the core serves itself (same origin) never holds its token in a script or in web storage.
It pairs with `"cookie": true` and the core keeps the token in an HttpOnly cookie for `/api`:

```http
POST /api/pair
Content-Type: application/json
Origin: https://192.168.1.20:7420

{ "code": "K7QM-2XPA", "name": "Firefox · macOS", "cookie": true, "remember": true }
```

→ `{ ok: true, data: { device, fingerprint?, spkiFingerprint? } }` (no `token`) and
`Set-Cookie: mindeck_<port>=<token>; Path=/api; HttpOnly; SameSite=Strict[; Secure]; Max-Age=34560000`.
`remember: false` ("Stay paired on this browser" off) makes it a session cookie that ends with the
browser. The name carries the core's port: browsers share cookies across the ports of one host, and
two cores on one computer must not overwrite each other's. Calls and the events socket then send no
token at all — the browser sends the cookie.

- **CSRF.** The cookie counts only for requests the browser marks as the web UI's own:
  `Sec-Fetch-Site: same-origin`, or — browsers without Fetch Metadata — an `Origin` that names the
  address asked (`Host`, or behind a proxy on the same computer `X-Forwarded-Host`); calls must also be
  `POST` with `Content-Type: application/json`. Anything else answers `403 cross-origin` / `415
  bad-content-type` — so does a WebSocket from another page (`403`). A `Bearer` header always wins
  over the cookie and needs none of this (apps).
- **Revoked or expired.** A cookie whose token the core no longer knows answers `401 unauthorized`
  and is deleted (`Max-Age=0`) — calls and the socket alike.
- **Signing out:** `POST /api/logout` removes the calling device (cookie or Bearer) on the core,
  closes its sockets (`4401`) and deletes the cookie; it answers `{ ok: true }` either way.
- **A token from before.** Web UIs that kept their token in `localStorage`/`sessionStorage` hand it over
  once: `POST /api/session` with `Authorization: Bearer <token>` and `{ "remember": bool }` sets the
  cookie for it (`{ ok: true, data: { device } }`), then they delete their copy. The desktop's remote
  windows sign in the same way.

`GET /api/health` → `{ ok, name: "Mindeck", mode: "desktop" | "server" }` (public) tells whether a
URL really is a Mindeck core; with a device's `Authorization: Bearer …` it adds `version`.

## 2. Calls

```http
POST /api/rpc/<channel>
Authorization: Bearer mindeck_…
Content-Type: application/json

<request payload as JSON, or nothing for channels without a payload>
```

Every call answers HTTP 200 with an `IpcResult`:

```ts
{ ok: true, data: T } | { ok: false, error: { code: string, message: string } }
```

Only authentication problems use HTTP status codes: `401 unauthorized` means the token is unknown,
was revoked or expired — drop it and pair again. `413` = body over 8 MB, `400 bad-json` / `bad-url`,
`403 https-required` = plain HTTP from the network to a core that speaks HTTPS, `403
host-not-allowed` (see *Names*). Errors of the core's operating system (`ENOENT`, `EACCES` …) and
unexpected failures reach devices as `Something went wrong on the Mindeck core (ref 1a2b3c4d)` —
the details, under that reference, are in the core's log.

**Rate limits.** Calls that cost the user money or quota are counted per device (a token bucket per
group: a burst, then a steady rate). Over the limit a call answers `429` with `Retry-After: <s>` and
`{ ok: false, error: { code: "rate-limited", message: "Too many ai calls from this device — try again in 12 s" } }`.

| group | channels | default |
|---|---|---|
| `ai` | `ai:send`, `agents:create`, `agents:send`, `agents:resume` | 20 at once, 20 / min |
| `inline` | `ai:inlineComplete`, `ai:inlineEdit` | 40 at once, 60 / min |
| `github` | `github:*` | 60 at once, 60 / min |
| `cloud` | `cloud:*` except `cloud:status` and `cloud:adopt` | 10 at once, 10 / min |

`MINDECK_RATE_LIMITS` changes them: `ai=10,github=120:60,cloud=off` (`<group>=<per minute>[:<burst>]`,
`off` switches a group off). The desktop window is never limited.

**Remote rules.** Without remote shells a paired device reaches only the *shared folders*: the ones
set at the desktop (Settings → Remote access → *Shared folders*) or, headless, in
`MINDECK_REMOTE_ROOTS` (default `/projects`, the Docker mount), plus the projects added at the
desktop. `fs:dirs`, `projects:add` and `memory:setVault` stay inside them (the vault never in or
around a project's folder: its notes would be project files), `projects:list` shows only the
projects a device may use, and every call naming a project (`projectId`, or `id` for
`projects:*`) is checked. Databases (`mongo:*`) are not in any shared folder: reading them needs an
admin device or remote shells, changing them remote shells; a device's filter, sort, projection or
pipeline never runs JavaScript on the database server (`$where`, `$function`, `$accumulator`,
`$eval`, BSON `Code` — at any depth: `remote-forbidden`). Always — with
remote shells, too — off-limits: the home folder itself and the folders above it, hidden folders,
system folders, Mindeck's own data folder, and keys and credentials by name (`.ssh`, `.aws`,
`.gnupg`, `.git`, `.env*`, `.npmrc`, `.netrc`, `*.pem`, `*.key`, `id_*`, Terraform state,
`credentials*.json`, keystores, keychains, browser profiles …), as files or folders.

Approvals from a device: `deny` always works, read requests may be allowed; changes (`write`) and
commands (`execute`) can be allowed only while remote shells are on (`remote-terminal-disabled`
otherwise). An agent that wants to read outside its folder (or keys and credentials) or fetch a web
page asks with `risk: "write"`: what it reads could leave with it. `always` from a device counts as `once`, and requests reach devices with
`allowAlways: false` — "Always allow" is given at the desktop only. An assistant run started by a
device uses no write or command tool without remote shells.

Error codes worth handling in the UI:

| code | meaning |
|---|---|
| `bad-request` | payload failed the channel's schema (message names the field) |
| `desktop-only` | native dialogs / opening apps on the host — not available remotely |
| `remote-terminal-disabled` | the core does not allow remote shells (also: approving changes or commands; databases for non-admin devices) |
| `admin-only` | the channel needs an admin device (or the desktop app) |
| `remote-forbidden` | outside the shared folders, or a key / credential / system path |
| `no-key` | the assistant has no Anthropic API key yet (Settings → AI) |
| `busy` | the conversation is still running |
| `rate-limited` | too many calls from this device (see *Rate limits*; `Retry-After` says when), too many failed pairings, or the AI provider's own limit |
| `not-found`, `not-pending`, `bad-key`, `ai-unavailable` | as named |

## 3. Push events

```
GET /api/events   (WebSocket — wss:// on an HTTPS core; subprotocols: "mindeck", "mindeck.bearer.<token>")
```

The token travels as the second offered subprotocol — never in the URL, where it would land in
proxy and access logs. The core answers with the `mindeck` protocol only
(`new WebSocket(url, eventsProtocols(token))` in `transport.ts`; React Native's `WebSocket` takes
the same second argument). The old `?token=mindeck_…` query is no longer accepted.

Messages are JSON `{ "channel": string, "payload": …, "seq": number }`. The first one is
`{ channel: "hello", payload: { deviceId, role, stream, seq } }`. A revoked device is closed with code `4401`.
While at least one client is connected the core samples system telemetry (`system:tick`, ~1.5 s);
remote clients do not need `system:subscribe`.

**Sequence numbers and replay.** The core numbers each device's events: `seq` counts exactly the
events this device may see (its shared folders, its own search results and inline edits), `1, 2, 3 …`
without gaps, within a *stream* — `hello` names the stream (`stream`, an id) and where it stands
(`seq`, the last number given out). `system:tick` is a snapshot the next one replaces: it carries no
`seq` and is never replayed. For a reconnect the core keeps a device's events for 5 minutes (at most
5000 events and 2 MB per device, and the streams of 32 devices that went away); a client that lost the
socket names where it stopped — never a token, the numbers are no secret:

```
GET /api/events?stream=<hello.stream>&since=<last seq it saw>
```

After `hello` the core sends what was missed, in order and with their `seq`, then goes on live. When
it can't — the gap is no longer kept, the stream is another one (the core restarted), `since` makes
no sense, or what devices may see changed in between (shared folders, remote shells) — it sends
`{ channel: "resync-required", payload: { stream, seq } }` instead: reload what you mirror (pending
approvals, conversations, agent sessions, terminals) and go on from that `seq`. The core sends it to
connected clients, too, when it had to drop events under load. A client that sees a `seq` skip
numbers treats it the same way; one with a `seq` it saw already drops it. Clients that don't send
`stream`/`since` get the same messages as before (the extra `seq` field aside) and no replay —
`createRemoteTransport` in `transport.ts` does all of this and calls `onResync` only when a reload is
needed.

| channel | payload | when |
|---|---|---|
| `system:tick` | `SystemSnapshot` | every ~1.5 s |
| `memory:changed` | `{ paths?: string[] }` | vault changed (Mindeck or Obsidian) |
| `context:progress` | `ContextProgress` | project scan running |
| `ai:delta` | `{ conversationId, messageId, text }` | streamed answer text |
| `ai:message` | `{ conversationId, message: ChatMessage, running }` | new message, tool status, run finished |
| `ai:conversationsChanged` | `{ reason, id }` | list changed |
| `permission:request` | `PermissionRequest` (`allowAlways` always `false` for devices) | an agent waits for approval |
| `permission:resolved` | `{ id, decision }` | answered (by any device) or timed out |
| `events:event` | `MindeckEvent` | activity timeline |
| `terminal:data` / `terminal:exit` | … | only when remote shells are allowed |

Apply `ai:delta` exactly like the core does: append to the message's last part if it is a text
part, otherwise start a new text part (`applyDelta` in `src/features/agents/store.ts`).

## 4. Channels by feature

Remote clients may call every channel except those marked *desktop*; channels marked *admin* need
an admin device. Types: see `contract.ts`.

- **App / server:** `app:info` · `server:status` · `server:devices` → `Device[]` (with `role`) · `server:revokeDevice { id }` (any device may remove itself; others: *admin*) · *(admin:)* `server:createPairingCode { role? }` → `{ code, role, expiresAt, urls }` · `server:setDeviceRole { id, role }` → `Device[]` · `server:configure` (*desktop*; `remoteRoots` = the shared folders)
- **Projects:** `projects:list` (the ones the device may use) · `projects:add { path }` (inside the shared folders) · `projects:remove` · `projects:refresh` · *(only with remote shells:)* `projects:pull` (`git pull --ff-only`) · `context:get` · `context:reindex` · `fs:dirs { path? }` (folder browser on the core's machine; for devices: the shared folders, listed in `roots`, no `path` = the first) · `projects:pickFolder` / `projects:openInEditor` / `projects:githubDesktop` / `projects:openInGitHubDesktop` / `projects:openFile` (*desktop*)
- **Editor (project files):** `files:list { projectId, dir? }` → `FileEntry[]` · `files:read { projectId, path }` → `FileContent` (`unsupported: "binary" | "too-large"` instead of text) · `files:stat { projectId, paths }` · `files:write { projectId, path, content, expectedMtime? }` (only with remote shells; fails with `conflict` when the file changed since `expectedMtime`)
- **Agent cockpit:** `agents:detect` · `agents:list` · `agents:get { id }` → session + messages · `agents:changes { id }` · `agents:branch { id }` → own working folder: pushed, pull request (via `gh`), merged, uncommitted files · `agents:diff { id, path }` · *(only with remote shells:)* `agents:create { kind, projectId, isolated?, prompt? }` · `agents:send { id, text }` · `agents:interrupt` · `agents:stop` · `agents:resume` · `agents:remove` · `agents:accept` · `agents:discard` · `agents:rename { id, title }` · `agents:shell { id }` → `{ terminalId }` (a shell in the session's folder, attach with `terminal:*`) · *(desktop only:)* `agents:openInEditor { id }` (VS Code on the session's folder). Push: `agents:changed { session? , removed? }`, `agents:message { sessionId, message }`; approvals come as `permission:request` like the assistant's
- **Mindeck account (license):** `cloud:status` → `{ enforced, allowed, state, account, license, validUntil, offlineUntil, online, webUrl, error }` (`state`: `active` · `paused` · `signed_out` · `checking` · `email_unverified` · `trial_expired` · `license_suspended` · `offline`; `offlineUntil`: end of the lifetime license's offline certificate, warn in its last 30 days — §6) · *(admin:)* `cloud:login { email, password }` (`403 device_limit`: too many devices — removed under Devices on `${webUrl}/account`) · `cloud:register { email, password, name?, locale }` · `cloud:logout` · `cloud:adopt { token, account, revokedKids? }` · `cloud:installId` → `{ installId }` (both for follower cores, §6) · `cloud:refresh` · `cloud:resendVerification` · `cloud:forgotPassword { email }` · `cloud:checkout` → `{ url }` (Stripe Checkout). Push: `cloud:status`. On a licensed core every other channel answers `license-required` until `allowed` — sign in first.
- **Memory (vault):** `memory:status` · `memory:list` · `memory:read` · `memory:search` · `memory:graph` · `memory:folders` · `memory:create` · `memory:write` · `memory:writeBody` · `memory:rename` · `memory:move` · `memory:moveFolder` · `memory:createFolder` · `memory:link` · `memory:unlink` · `memory:trash` · `memory:createVault` · `memory:setGraphStyle` · *(admin:)* `memory:setVault { path }` · `memory:setDailyNotes` · `memory:pickVault` / `memory:reveal` (*desktop*)
- **System:** `system:snapshot` · `system:user`
- **Assistant:** `ai:status` · *(admin:)* `ai:setKey { key }` · `ai:clearKey` · `ai:configure { model?, effort? }` · `ai:agents` · `ai:tools` · `ai:conversations` · `ai:conversation { id }` (while a run is going: as it stands — streamed text, tool calls waiting for approval — so a client reconnecting after missed push events can catch up) · `ai:send { text, conversationId?, agentId?, projectId? }` → `{ conversationId, messageId }` (the answer streams via push events) · `ai:cancel { conversationId }` · `ai:deleteConversation` · `ai:runs` · *(only with remote shells:)* `ai:inlineComplete` · `ai:inlineEdit`
- **Permissions:** `permission:pending` · `permission:respond { id, decision: "once" | "always" | "deny" }` (see the remote rules in §2) · `permission:grants` → `PermissionGrant[]` (`{ agentId, toolName, projectId?, createdAt }`: an "Always allow" holds for one agent, one tool and one project — no `projectId` = outside projects, `"*"` = every project, kept from before grants were per project) · *(admin:)* `permission:revoke { agentId, toolName, projectId? }`
- **Activity:** `events:recent { limit?, conversationId? }`
- **Push and settings sync:** `agents:pushSettings` · `cloud:syncStatus` · *(admin:)* `agents:setPushSettings { enabled }` · `cloud:syncPush` · `cloud:syncPull`
- **Databases** (admin devices, or with remote shells): `mongo:connections` · `mongo:databases` · `mongo:collections` · `mongo:find` · `mongo:indexes` · *(only with remote shells:)* `mongo:add` · `mongo:remove` · `mongo:insert` · `mongo:replace` · `mongo:delete` · `mongo:aggregate` · `mongo:createCollection` · `mongo:dropCollection`
- **Terminal** (only with remote shells): `terminal:create` · `terminal:list` · `terminal:attach` · `terminal:write` · `terminal:resize` · `terminal:kill`

## 5. React Native sketch

```ts
import { createRemoteTransport, pairDevice, parsePairingLink, probeCore } from './shared/ipc/transport'
import * as SecureStore from 'expo-secure-store'

// once: from the scanned QR URL "https://192.168.1.20:7420/#pair=K7QM-2XPA&fp=ab12…"
const link = parsePairingLink(scanned)
if (!link) throw new Error('Not a Mindeck pairing code')
const { baseUrl, code, fingerprint } = link
// over HTTPS: the first connection's certificate must have `fingerprint` (needs a pinning module)
if (!(await probeCore(baseUrl))) throw new Error('Not a Mindeck core')
const { token } = await pairDevice(baseUrl, code, 'Pixel 9')
await SecureStore.setItemAsync('mindeck', JSON.stringify({ baseUrl, token, fingerprint }))

// every start
const core = createRemoteTransport({
  baseUrl,
  token,
  onUnauthorized: () => SecureStore.deleteItemAsync('mindeck'), // revoked → pair again
  onLinkState: (state) => setLink(state) // connecting | online | offline
})
const res = await core.invoke('ai:send', { text: 'What is on my plate today?', agentId: 'assistant' })
const off = core.on('ai:delta', ({ messageId, text }) => appendText(messageId, text))
core.onResync?.(() => reloadEverything()) // events were lost (the core could not replay the gap)
core.on('permission:request', (req) => showApprovalSheet(req)) // → core.invoke('permission:respond', …)
```

The web UI in `src/` is the reference implementation of every flow (session/pairing in
`src/features/session`, the assistant in `src/features/agents`).

## 6. Cloud-Vertrag: Signierschlüssel, Lizenz und follower leases (Mindeck Cloud)

### 6.1 Signing keys: `kid`, `Mindeck-Keys`, revocations (CL-SEC-06)

Mindeck Cloud signs entitlements, offline certificates and follower leases with Ed25519 and can
rotate its key (mindeck-cloud `README.md` → *Signing keys*, `src/lib/keys.ts`). The core side
(`electron/main/services/cloud/entitlement.ts`, `CloudService.ts`, implemented):

- **Keys built in:** `MINDECK_CLOUD_KEY` (build time; dev runs: env) is a **list** — PEM blocks and/or
  base64 SPKI DER, separated by commas or line breaks, **the original key first** (the *legacy key*,
  the one older cores pinned). A key that is no Ed25519 public key fails the build
  (`cloudKeyDefine`). After `keys:generate` the next public key goes into the list *before*
  `keys:rotate` on the server.
- **Key id:** `kid` = the first 16 characters of `base64url(SHA-256(SPKI DER of the public key))` —
  the cloud's `keyId()`; the core computes it from the keys built in (`Map<kid, KeyObject>`).
- **Verifying a token** (`mindeck1.<payload>.<signature>`): the payload is read unverified only to
  take its `kid`; the key with that id verifies it. **No `kid`** (tokens from before key ids): the
  legacy key only. An **unknown or revoked `kid`** is rejected — the core never tries its other keys.
- **`Mindeck-Keys: <kid>,<kid>`** goes with every `/v1/license/*` call (heartbeat, `GET /v1/license`,
  follower lease, revocations): the trusted kids minus the revoked ones, none if every key is revoked.
  The cloud signs with its active key if the core names it, else with a previous key it names, else
  with the legacy key — so old and new builds both keep working through a rotation.
- **Revocations:** `GET /v1/license/revocations` (no session) → `{ revokedKids, revocations }`. Only the
  signed copy counts: `mindeck-rl1.<base64url { kid, iat, exp, revokedKids }>.<Ed25519 over
  "mindeck-rl1.<payload>">` — its own prefix (never taken for an entitlement), signed by a trusted,
  not revoked key its `kid` names (no legacy fallback), `exp` not passed, `revokedKids` strings.
  Asked before the heartbeat, again every 6 hours; a list that does not verify or a cloud without
  the endpoint (`404`) is asked again after an hour, an unreachable cloud with the next heartbeat.
- **Revoked is forever:** the kids go into `cloud.json` (`revokedKids`) and are never removed, even
  if a later list no longer names them. Whatever such a key signed is dropped at once — the stored
  entitlement, the offline certificate, cached follower leases — and rejected from then on, offline
  and after restarts too. The next heartbeat brings tokens signed with a key still trusted.
- **Followers** (Remote-SSH, Dev Containers) never ask the cloud: the desktop hands its revoked kids
  over with every licence (`cloud:adopt { token, account, revokedKids? }`, ≤ 256 ids); the follower
  keeps them like its own and drops what they signed.
- **Dev builds without a key built in** (trust on first use): `/v1/meta` → `entitlementPublicKey`
  (legacy) plus `entitlementKeys: [{ kid, publicKey, active }]` and `revokedKeyIds`, kept in
  `cloud.json` (`publicKey`, `publicKeys`, `revokedKids`). Release builds trust only what is built in
  and the signed list.

### 6.2 Licence states and offline certificate

- **Entitlement claims** `{ sub, email, plan, active, reason, rem, dev?, kid?, iat, exp, perpetual?, lease? }`,
  `reason`: `ok` · `trial_expired` · `email_unverified` · `license_suspended`. `active: false` with
  `license_suspended` (a lifetime licence whose payment is disputed, a chargeback) is its own state
  `license_suspended` ("Zahlung angefochten – Lizenz pausiert"; nothing to buy, `check again` once the
  dispute is closed) — not `trial_expired`.
- **Offline certificate** (`offlineCertificate` of heartbeat / `GET /v1/license`): kept in the secret
  store and used only while the cloud can't be reached. It holds when the signature verifies (as
  above), `perpetual`, `active`, **`plan: "lifetime"`**, **`sub` = the signed-in account** (its id from
  sign-in `user.id`; for older clouds and older `cloud.json` the `sub` of the stored entitlement) and
  `dev` = this install (the cloud's device id or the install id; none: any device of the account).
  A certificate **without `kid`** (the 100-year ones from before key ids) holds **400 days from its
  `iat`** at most. The cloud's answer wins while it answers: inactive, or a plan other than lifetime,
  drops the certificate.
- `cloud:status.offlineUntil` = the certificate's (capped) end; the desktop shows a warning in the
  profile and a chip in the top bar once fewer than 30 days are left (`offlineDaysLeft`).

### 6.3 Error codes the core shows in its own words (DE + EN)

| Code (cloud) | Where | Shown as |
|---|---|---|
| `device_limit` (403, `details: { limit, devices }`) | sign-in / register | "signed in on the most computers it may use" + link *Manage devices* → `${webUrl}/account` (the core fetches `/v1/meta` for `webUrl` if it doesn't know it yet) |
| `license_suspended` (entitlement `reason`) | licence gate, profile | state `license_suspended` |
| `already_licensed` (409) | checkout | "This account already has the lifetime license" |
| `ai_blocked` (403) → `ai-blocked` | assistant | "switched off for your account — support or an own API key"; `/v1/me/ai` `blocked: true` → `AiStatus.cloud.blocked`, a notice in Settings → AI |
| `ai_unsupported_content` (400, `details.path`) → `ai-unsupported-content` | assistant | "a document by URL / Files API id is not taken — attach the file itself" |

### 6.4 Follower leases

A core the desktop app starts on another machine — Remote-SSH, Dev Containers — runs as a
*follower*: it never signs in itself, the desktop hands it a license. That hand-over must not be a
copy of the desktop's own entitlement (which any server could replay, BE-SEC-09): Mindeck Cloud
issues the desktop a short **follower lease** bound to that one core.

**Endpoint (mindeck-cloud):**

```http
POST /v1/license/follower-lease
Authorization: Bearer <the desktop's session token — the same as for /v1/license/heartbeat>
Content-Type: application/json

{ "installId": "<the follower core's install id>", "appVersion": "0.3.0" }
```

```json
{ "entitlement": { "token": "mindeck1.<base64url JSON>.<base64url Ed25519>" } }
```

- **Token:** the format and key of every entitlement (`mindeck1.<claims>.<signature>`, Ed25519 over
  `mindeck1.<claims>`, `kid` as in §6.1, `electron/main/services/cloud/entitlement.ts` ↔ `mindeck-cloud/src/lib/entitlement.ts`).
  The request carries `Mindeck-Keys` like every licence call.
- **Claims:** those of the heartbeat's entitlement for this account (`sub`, `email`, `plan`, `active`,
  `reason`, `rem`, `iat`, `exp`) plus `"dev": "<installId from the request>"` and `"lease": "follower"`;
  never `perpetual`. `exp` short: **1 hour** recommended, 24 hours at most. The desktop asks again
  once half of it has passed (and hands the lease over every minute while the window is open).
- **When:** only for a session whose account may use Mindeck now (trial time left, a lifetime
  license); otherwise `{ "entitlement": null }` (or the same `active: false` lease the heartbeat would
  give). A lease counts no trial time of its own — the desktop's heartbeat counts it while remote
  windows are open.
- **Limits (cloud side, recommended):** a rate limit per account (e.g. 60 an hour) and a cap on
  distinct `installId`s per account and day (e.g. 10) — a lease bound to a core is still one per core.
- **Errors:** `401` = the session is gone (the desktop signs out, as for every call). `404` = the
  cloud offers no leases yet — see the transition. Anything else (`429`, `5xx`, a lease that does not
  verify, is not `lease: "follower"` or names another `dev`) is ignored for this round: the desktop
  keeps a lease it still holds, else falls back to the transition.

**Core side (mindeck, implemented):**

- `cloud:installId` (*admin*, license-free) → `{ installId }`: the follower's install id
  (`cloud.json`), what the desktop puts into the request.
- `cloud:adopt { token, account }` (*admin*) on a follower accepts, after the signature: an active,
  unexpired entitlement that is not an offline certificate, and then
  1. a **lease for this core** (`lease: "follower"`, `dev` = its install id) — as signed. From then on
     the core remembers that it ran on a lease (`leased` in `cloud.json`) and takes leases only:
     the desktop's own entitlement answers `lease-required`;
  2. a lease for another core: `bad-entitlement`;
  3. **transition** — the desktop's own entitlement, while the cloud issues no leases (`404`): it
     holds until `exp`, but never longer than **24 hours after the desktop last handed it over**
     (`adoptedAt` in `cloud.json`; also across restarts).
- The desktop (`RemoteService.handLicense`, every minute): asks the remote core for its
  `cloud:installId`, then the cloud for a lease (`CloudService.followerLease`); without one (a `404`
  is remembered for an hour, an older remote core has no `cloud:installId`) it hands over its own
  entitlement as before.

**What mindeck-cloud has to do:** offer the endpoint above with these claims and limits. Nothing
else changes: as soon as it answers `200`, desktops hand over leases and remote cores switch to
leases only.

