# Mindeck Architecture

**Status:** Authoritative steering document · **Created:** 2026-07-17 · **Revised:** 2026-07-17 (v1.1 — P2 split into A/B/C, search abstractions separated, event persistence classes, scoped permission grants, binding layering rules)
**Supersedes:** [`docs/MASTERPLAN.md`](docs/MASTERPLAN.md) (kept as reference — its security doctrine and phase templates remain valid and are carried over here; see §12 for the reconciliation table).

Mindeck evolves from a sci-fi command-center UI into a **modular, local-first personal intelligence system**: an AI assistant with long-term memory, a knowledge base, intelligent project workspaces, a permission-gated agent runtime, and live activity visibility — all running on the user's machine, on open formats.

Guiding doctrine (unchanged from the masterplan, restated because everything below depends on it):

1. **All privileged operations live in the Mindeck core** — the Electron main process, or the same core running headless as a server (§12.4). Clients (desktop renderer, browser, mobile app) never get Node access.
2. **Markdown is the source of truth for knowledge; everything else the core keeps is plain JSON files — no database on the user's machine (since 2026-10-11, §11.5).** The only database is Mindeck Cloud's.
3. **Local-first.** Cloud LLM APIs are called from main; data stays on disk in open formats.
4. **Policy is code, never a model.** Permission decisions are made by a deterministic engine and the user — an LLM can request, never grant.
5. **No speculative architecture.** Interfaces are introduced when the first real consumer lands; schemas grow by additive migration.

---

## 1. Current Architecture

### 1.1 Stack

| Layer | Choice |
|---|---|
| Shell | Electron 44 (Chromium 152, Node 24 — updated from 37 on 2026-10-15: a browser that loads foreign pages needs a supported Chromium), frameless window, `contextIsolation: true`, `nodeIntegration: false` |
| Build | electron-vite 2 (CJS main/preload, Vite renderer), dual tsconfig (`typecheck:node` + `typecheck:web`) |
| Renderer | React 18, TypeScript 5.5, Zustand (one store per feature), Framer Motion |
| Design system | Tailwind driven by CSS custom properties (`src/index.css` + `tailwind.config.ts`); primitives `Panel`, `TechLabel`, `StatusDot`, `HudFrame`; Inter Variable + JetBrains Mono, bundled locally |
| Persistence | Atomic JSON (tmp + rename) under `userData/mindeck/` |
| Telemetry | `systeminformation` (main-process sampling, push stream) |

### 1.2 Load-bearing patterns (binding for all future work)

1. **Typed IPC contract** — `src/shared/ipc/contract.ts` is the single source of truth: the `IpcChannels` request/response map, the `IpcResult<T>` union (errors never cross the bridge as throws), and the runtime allowlists `IPC_CHANNELS` / `IPC_EVENTS`. A capability is added exactly once, here.
2. **Single preload bridge** — `electron/preload.ts` exposes only `window.mindeck` with allowlist-guarded `invoke`/`on`. The renderer never touches `ipcRenderer`.
3. **Main-process services** — `electron/main/services/<domain>/<Domain>Service.ts`, constructed in `registerServices()` (`electron/main.ts`) with injected dependencies (e.g. `ContextService` receives a `resolvePath` callback, not a `ProjectService` reference). Handlers bind via `handle<K>()` in `electron/ipc/registry.ts`; main→renderer push goes through `broadcast()`.
4. **Renderer feature slices** — `src/features/<name>/{store.ts, components/}`; view switching via `useState<ModuleId>` in `AppShell`, nav defined in `src/data/navigation.ts`. No router.

### 1.3 What exists today

| Area | State |
|---|---|
| Projects | ✅ Real. JSON registry, git/stack detection, open in editor/terminal, `projects:openFile` with path confinement |
| System monitor | ✅ Real. 1.5 s telemetry stream, pauses when window hidden |
| Project context | ✅ Real (P3): bounded `.gitignore`-aware scan → tree/deps/configs/TODOs/README → JSON cache; UI in the project detail (analyze/reindex, TODOs open in the editor); feeds the assistant's context engine |
| Editor | ✅ Real (§12.5). Monaco in its own module: lazy file tree per project, tabs, explicit save with a stale-write guard, follows changes on disk |
| Core dashboard | ✅ Real. `features/dashboard`: greeting with the OS account name (`system:user`), HUD clock (seconds/minutes/day rings), tiles for projects (live git), brain (vault) and a system verdict |
| Terminal | ✅ Real (PT). `TerminalService`: node-pty login shell per tab (Home or a project), layouts single / side by side / stacked / 2×2 (panes only re-positioned, never remounted), output batched per frame, bounded scrollback for re-attach; xterm.js views stay mounted across modules; links clickable; theme-aware. WebGL rendering (DOM fallback on context loss), Unicode 11 widths, find (⌘F), profiles (detected shells + the user's own, a default in Settings), shell integration injected per start argument/env like VS Code (bash/zsh/fish/pwsh: OSC 7 folder, OSC 133 command marks, jump/copy output), file references `path:line` open in the Editor, tabs/layout/folders/recent output restored after a restart (`terminals.json`). Prebuilt N-API binaries (no compiler); `scripts/fix-node-pty.cjs` restores the spawn-helper exec bit on install |
| Bottom dashboard | ✅ Command Deck (P9): running agents (stop / jump in), waiting approvals, live activity outcomes |
| Memory | ✅ Real (§12.3). Obsidian-compatible vault: `VaultService` + in-memory `MemoryIndex` (wikilinks, backlinks, tags, search), live `fs.watch` for external edits, force-directed graph colored by folder or one accent |
| Agents | ✅ Cockpit (§12.6): the user's own coding agents — Claude Code (hooks, own plan), Codex and Gemini (ACP) — as chats with approvals, changes/diffs, plan and a journal in memory; plus the Mindeck Assistant on an API key (P6–P9, §12.4) |
| Settings / System | ✅ AI key + model, remote access & devices (pairing, QR), permissions, vault, about · full telemetry view |
| Network API | ✅ §12.4: the core as an HTTP + WebSocket service for the web UI and the mobile app (device pairing, bearer tokens) |
| Browser | ✅ §12.9: real Chromium tabs (`WebContentsView`), address bar with history/search, downloads, permissions, find, zoom, DevTools; agents read and drive tabs the user shares |
| Files | ✅ §12.9: Finder-like module — places, list/icons, search (Spotlight on macOS), previews (images, video, audio, Markdown, text, PDF), rename/move/copy/trash, Quick Look thumbnails |

**Assessment: everything is kept.** The design system, IPC contract, service pattern, store pattern, and security baseline carry the target architecture without modification. Mock data in `src/data/` is deliberately isolated and gets replaced surgically, phase by phase.

---

## 2. Target Architecture

```
┌─────────────────────────── RENDERER (React, no Node) ───────────────────────────┐
│  Command Center · Projects · Knowledge · Memory · Agents · Files ·              │
│  Automations · System · Settings          (features/<x>/{store,components})     │
└──────────────────────────────────┬───────────────────────────────────────────────┘
                    window.mindeck (preload, allowlisted invoke/on)
┌──────────────────────────────────┴───────────────────────────────────────────────┐
│                    TYPED IPC  (contract.ts · IpcResult · broadcast)              │
└──────────────────────────────────┬───────────────────────────────────────────────┘
┌──────────────────────────────────┴──────────────── MAIN PROCESS (Mindeck CORE) ───┐
│  ProjectService   ContextService   SystemService          (existing)            │
│  SettingsService (P2A)  VaultService (P2C)  Repos + MemoryService (P2B/P5)      │
│  KnowledgeService (P4)             ContextEngine (P6)     AIProvider (P6)       │
│  ToolRegistry + PolicyEngine (P7)  AgentRuntime (P8)      AutomationService(P11)│
│                                                                                  │
│  Cross-cutting spines:                                                           │
│   • EventBus — distributes all MindeckEvents; persists per catalog class (P2A/P2B) │
│   • Entity graph — EntityRef {kind,id} + typed links table (P2B)                │
│   • Permission gate — deterministic policy in front of every tool call (P7)     │
└──────────────────────────────────┬───────────────────────────────────────────────┘
┌──────────────────────────────────┴───────────────────────── DATA LAYER ─────────┐
│  Markdown vault (~/Mindeck/vault, Obsidian-compatible — SoT for knowledge)        │
│  SQLite mindeck.db (memories, entities, links, events, indexes, FTS5)              │
│  Search: TextSearchIndex (FTS5, P2B) · EmbeddingIndex (P13) · RetrievalService  │
│  JSON (settings, project registry, context cache) · safeStorage (API keys)      │
└──────────────────────────────────┬───────────────────────────────────────────────┘
┌──────────────────────────────────┴──────────────────── INTEGRATIONS / TOOLS ────┐
│  Filesystem · Git · Web search · Browser · Terminal · Calendar · APIs           │
│  — reachable ONLY through registered tools behind the permission gate           │
└───────────────────────────────────────────────────────────────────────────────────┘
```

The three spines are what turn separate features into one system:

- **EventBus** (§10): every meaningful action becomes a structured `MindeckEvent` — distributed to all subscribers, persisted according to its catalog class (`activity`/`audit`), consumed by the Agent Activity UI and automations.
- **Entity graph** (§4): every domain object is addressable as `EntityRef {kind, id}`; typed edges in a `links` table connect memories ↔ projects ↔ knowledge ↔ people ↔ decisions. This is how "open project Mindeck and know everything about it" works, and it *is* the knowledge graph's data layer.
- **Permission gate** (§9): tools are the only way agents touch the system, and the policy engine fronts every tool call.

### 2.1 Layering rules (binding)

- **Services** implement business capabilities.
- **Repositories** implement persistence — nothing else.
- **IPC handlers** contain no business logic; they bind contract channels to service calls.
- **Tools** orchestrate approved service calls; they never touch `fs`/`child_process` directly.
- **Renderer stores** contain no domain logic; they hold view state and call typed IPC.

The one permitted flow:

```
Renderer → IPC handler → domain/application service
         → repository or capability service
         → SQLite / filesystem / external API
```

---

## 3. Module Map

| Nav module | Feature dir | Backing services | Real in |
|---|---|---|---|
| Home / Command Center (`core`) | `features/dashboard` — a personal HUD by user decision; the assistant surface (`features/assistant`) gets its own place in P6 | SystemService, ProjectService, VaultService (read-only) | done |
| Editor | `features/editor` — Monaco in its own tab, project files; VS Code stays one click away | FilesService (confined list/read/stat/write) | done (§12.5) |
| Projects | `features/projects` (+ `context`) | ProjectService, ContextService | done / P3 |
| ~~Knowledge~~ | merged into Memory (§12.3) | — | — |
| Memory | `features/memory` | VaultService, MemoryIndex; MemoryService pipeline later | vault ✅ / pipeline P5 |
| Agents | `features/agents` | AgentRuntime, ToolRegistry, PolicyEngine | P7–P9 |
| Files | `features/files` | FinderService (whole machine, writes confined to Home + drives) | done (§12.9) |
| Browser | `features/browser` | BrowserService (core) + ElectronBrowserHost (`platform/browser`) | done (§12.9) |
| Automations | `features/automations` | AutomationService | P11 |
| System | `features/system` | SystemService | done |
| Terminal | `features/terminal` | TerminalService (node-pty) | tabs + split layouts (side by side, stacked, 2×2) ✅ |
| Settings | `features/settings` | SettingsService | P2A onward |

`ModuleId` (`src/types/index.ts`) and `NAV_ITEMS` (`src/data/navigation.ts`) grow one phase at a time — never in bulk. New views reuse `Panel`/`TechLabel`/`StatusDot` and the token palette exclusively; a new module must look like it was always there.

---

## 4. Data Model

All shared types live in `src/shared/types/` and are **pure** — no Node, DOM, or Electron imports — so they compile under both tsconfigs. The dual `typecheck` script is the guard.

### 4.1 The universal relation currency

```ts
// v1 — only kinds with real consumers today. Grows additively as each module
// lands (task, decision, person, concept, conversation, agent, tool, file,
// automation); the SQLite column stays TEXT, so additions are type-level only.
type EntityKind = 'project' | 'memory' | 'knowledge'

interface EntityRef { kind: EntityKind; id: string }

type LinkType =
  | 'related_to' | 'belongs_to' | 'created_by'
  | 'depends_on' | 'mentioned_in' | 'decided_in'

interface EntityLink { id: string; from: EntityRef; to: EntityRef; type: LinkType; createdAt: string }
```

Every cross-entity relation in the system — memory→project, knowledge→person, decision→conversation — is an `EntityLink` row. The graph view (P12), project workspaces (P3), and backlinks (P4) are all queries over this one table.

**Binding rule: the `links` table is the only persistent source of truth for relations.** Persistent domain models never carry redundant relation fields (no `relatedEntities` arrays, no `relatedProject` columns). Relations surface only in computed read models:

```ts
interface MemoryEntryWithRelations extends MemoryEntry {
  relatedEntities: EntityRef[]   // computed from links
  project?: EntityRef            // memory —belongs_to→ project
}
```

### 4.2 Canonical types and their storage home

| Type | Source of truth | Indexed in |
|---|---|---|
| `MemoryEntry` / note | Markdown file in the vault — entry fields live in frontmatter (§12.3) | in-memory `MemoryIndex` today; SQLite `memories` + FTS5 later, as a rebuildable index |
| `Project` | JSON `projects.json` (today) | mirrored into `entities` from P3 |
| `MindeckEvent` | SQLite `events`, per persistence class (§10); audit rows immutable | — |
| `AgentDefinition` / `ToolDescriptor` | code (built-ins) + SQLite (user-defined, later) | — |
| `Automation` | SQLite | — |
| `AppSettings` | JSON `settings.json` | — |
| Conversations | SQLite (P6) | — |

Tasks and decisions are **memory types** in v1, not separate tables. If P3's workspace view proves it needs structured task state, a `tasks` table arrives as an additive migration — no speculative schema now.

---

## 5. Memory Architecture

Memory is not chat history. It is a typed, curated store the assistant reads and writes deliberately.

### 5.1 Entry model

```ts
type MemoryType =
  | 'personal' | 'project' | 'conversation' | 'knowledge'
  | 'preference' | 'decision' | 'task'

type MemorySource =
  | { kind: 'user' }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'agent'; agentId: string; runId?: string }
  | { kind: 'import'; detail?: string }

interface MemoryEntry {
  id: string
  type: MemoryType
  title: string
  content: string              // markdown
  summary?: string             // AI-generated from P6
  tags: string[]
  source: MemorySource
  importance: number           // 0..1 — drives context ranking
  confidence: number           // 0..1 — how certain the fact is
  createdAt: string
  updatedAt: string
  lastAccessedAt?: string      // updated on retrieval
}
```

No relation fields in the persistent model — relations live exclusively in `links` (§4.1): `memory —belongs_to→ project`, `memory —related_to→ <entity>`, `memory —decided_in→ conversation`. Read models (`MemoryEntryWithRelations`) compute them at query time.

### 5.2 Memory pipeline

Nothing is stored blindly. Every candidate passes through:

```
input → analyze → relevance? → classify type → search existing memories
      → create new OR update existing → link related entities → store → emit memory.* event
```

The pipeline **interface** exists from P5; its stages are deterministic at first (explicit "remember this" commands, rule-based classification) and become model-assisted in P6 (analyze/summarize/dedupe via LLM) — a drop-in upgrade, not a rewrite.

### 5.3 Retrieval

1. **From P2B:** lexical search via `TextSearchIndex` (SQLite FTS5, bm25) over title/content/summary/tags; type/tag filters on `memories`, project scope resolved through `links`; `lastAccessedAt` updated on access.
2. **From P5/P6:** the `RetrievalService` (§11.3) is created with its first real consumer (MemoryService or Context Engine) and blends FTS score, `importance`, recency, project scope, and entity links into one ranking.
3. **P13:** an `EmbeddingIndex` implementation adds semantic similarity; the `RetrievalService` combines lexical and vector results — its consumers never change.

---

## 6. Context Architecture

The Context Engine answers one question: *what does the model need to know for this request?* — without ever dumping the database into a prompt.

```ts
buildContext({ query, activeProject, conversation, user }): AssembledContext
```

Assembly pipeline (P6):

```
user input
  → intent signal (question / command / agent task — cheap heuristics first, model later)
  → active project → deterministic ProjectContext (the existing ContextService output:
    tree, stack, deps, TODOs, README, git state)
  → memory + knowledge retrieval via the RetrievalService (§11.3 — FTS,
    importance, recency, project scope, entity links; embeddings from P13)
  → recent conversation window
  → assemble sections under a hard token budget, most-valuable-first, each section
    carrying entity IDs so answers can cite their sources
```

`AssembledContext` is a structured object (ordered sections with provenance), serialized to the prompt at the last moment. The deterministic project context that already ships today is the structural feed — nothing built so far is thrown away.

### 6.1 Provider abstraction

The internal model for messages, tool calls, and streaming deltas is **provider-neutral**. `LLMProvider` is the only surface the Context Engine, assistant, and agent runtime know:

```ts
interface LLMProvider {
  stream(req: LLMRequest): AsyncIterable<LLMDelta>   // internal, provider-neutral types
}
```

Anthropic is the first provider; its adapter translates the internal format to and from the Anthropic API — including the tool-use wire format. Nothing outside the adapter imports a provider SDK.

---

## 7. Agent Architecture

```ts
interface AgentDefinition {
  id: string; name: string; description: string
  systemPrompt: string
  allowedTools: string[]                    // tool names — allowlist, not "all tools"
  memoryScope: 'none' | 'project' | 'global'
  maxIterations: number
  timeoutMs: number
  model?: string
}

interface AgentRun {
  id: string; agentId: string; goal: string; projectId?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'
  startedAt: string; endedAt?: string; iterations: number; error?: string
}
```

The runtime (P8) is a **controlled loop**, never a free-running process:

```
goal → plan → pick tool → PERMISSION GATE → execute → observe result
     → next step or finish
```

Hard guarantees enforced by code:

- `maxIterations` and `timeoutMs` per run; the loop cannot exceed either.
- Cancellation via `AbortController` — the UI can stop any run instantly.
- Every step emits structured events (`agent.plan.created`, `agent.step.started`, `agent.step.completed`, `agent.status.updated`, `tool.started`, …) — the run is fully observable and auditable after the fact.
- **No raw internal model reasoning is ever stored or displayed.** Status and plan events carry user-comprehensible descriptions of what the agent is doing and why an action is needed — never private chain-of-thought text.
- Tool calls the agent is not allowlisted for are rejected before the policy engine is even consulted.
- Errors terminate the run with a persisted `error`; there are no silent retries-forever.

**Single-agent first.** Example roles (Personal, Coding, Research, Project agent) are `AgentDefinition` rows, not separate runtimes. Multi-agent orchestration stays deferred until a single agent demonstrably can't do the job (masterplan Phase-10 stance); the data model (agents as entities, runs logged) already leaves the door open.

---

## 8. Tool Architecture

Tools are the **only** way agents touch the system. Tools call existing services (ProjectService, VaultService, MemoryService, …) — never `fs`/`child_process` directly — so every capability exists exactly once.

```ts
// shared (renderer-visible descriptor — no execute)
interface ToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>   // JSON Schema — provider-neutral
  permission: PermissionLevel
}

// main only (P7, electron/main/services/tools/)
type ToolDefinition = ToolDescriptor & {
  execute(input: unknown, ctx: ToolContext): Promise<unknown>
}

registerTool({ name: 'read_file', description: '…', inputSchema, permission: 'safe', execute })
```

Registry rules:

- Code-defined registry in main; the renderer sees only descriptors.
- `inputSchema` is validated before `execute` runs — malformed model output never reaches a tool body.
- Planned categories: memory, knowledge, projects, filesystem, git, web search, browser, terminal, calendar. First tools (P7) are SAFE and read-only: search memory/knowledge, read project files, get project context.

### 8.1 Command execution (binding)

Non-interactive commands run through one capability service using `execFile` with structured arguments — never a shell string:

```ts
interface CommandRequest {
  executable: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}
```

- `shell: false` by default; arguments are an array — **no string concatenation from model or user input, ever**.
- `cwd` is validated and confined (the `projects:openFile` realpath guard in `ProjectService` is the template).
- Hard timeout and output-size limit per command; cancellation via `AbortSignal`.
- `env` is an explicit allowlist — the full process environment (and its secrets) is never passed through.
- Interactive processes are out of scope here; they require the optional PTY layer (phase PT).
- The JSON-Schema shape is provider-neutral; each provider adapter (§6.1) translates it into its wire format (Anthropic first).

---

## 9. Permission Model

Three user-facing classes, mapped from the masterplan's four internal classes (READ→safe, WRITE/EXECUTE→confirm, DESTRUCTIVE→dangerous):

| Level | Meaning | Examples |
|---|---|---|
| `safe` | Auto-allowed, logged | read file in project scope, search memory/knowledge/web |
| `confirm` | Allow Once, or a **scoped** Always Allow | write/create file, terminal command, git push |
| `dangerous` | Allow Once only, with strong warning — **never** Always Allow | delete files, `git push --force`, system settings |

Decision flow — deterministic code, end to end:

```
tool call → policy engine classifies (level + scope checks, blocklist)
          → persisted grants lookup (scoped "Always Allow": agent + tool + scope)
          → if needed: ApprovalDialog in renderer
            (shows: which agent, which tool, exactly what will happen, why)
            [ Allow Once ] [ Always Allow (scoped) ] [ Deny ]
          → "always" decisions persisted as scoped grants · audit event either way
```

Rules carried over verbatim from masterplan §D: blocklist for catastrophic commands regardless of approval, path confinement for all filesystem access (the `projects:openFile` guard is the template), prompt-injection defense (content from files/web is data, never instructions), append-only audit trail (the `events` table), and *the model can request, only code and the user can grant*.

```ts
type PermissionLevel = 'safe' | 'confirm' | 'dangerous'
type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'

interface PermissionRequest {
  id: string; agentId: string; agentName: string; toolName: string
  level: PermissionLevel
  action: string      // human-readable: what will happen
  reason: string      // why the agent wants it
  input: unknown
}

/** Persisted only for "Always Allow" — and always with a scope. */
interface PermissionGrant {
  id: string
  agentId: string
  toolName: string
  scope: {
    projectId?: string    // valid only inside this project
    pathRoot?: string     // valid only under this directory
    operation?: string    // valid only for this operation variant
  }
  createdAt: string
  expiresAt?: string
}
```

Grant rules: `safe` is auto-allowed and logged. `confirm` supports Allow Once or a **scoped** Always Allow. `dangerous` supports Allow Once only — a persistent grant is never offered or stored. **A grant never widens automatically:** a request outside the stored scope re-prompts, and any scope expansion is an explicit new user decision.

---

## 10. Event Architecture

One envelope for everything that happens:

```ts
interface MindeckEvent<T = unknown> {
  id: string
  type: MindeckEventType     // 'agent.started' | 'tool.completed' | 'memory.created' | …
  ts: string
  actor: { kind: 'user' | 'agent' | 'system'; id?: string }
  subject?: EntityRef     // primary entity concerned
  projectId?: string
  payload: T
}
```

Event type families: `app.*`, `db.*`, `project.*`, `memory.*`, `knowledge.*`, `agent.*` (started / plan.created / step.started / step.completed / status.updated / completed / failed / cancelled), `tool.*` (started/completed/failed/denied), `permission.*` (requested/granted/denied), `automation.*`. There is deliberately no `agent.thinking` — raw model reasoning is never an event payload (§7).

Not every event is stored. Every event type is classified centrally in the **event catalog**:

```ts
type EventPersistence = 'ephemeral' | 'activity' | 'audit'
```

| Class | Persisted? | Examples |
|---|---|---|
| `ephemeral` | never — broadcast only | streaming deltas, scan/reindex progress |
| `activity` | `events` table | agent plan/steps, memory/knowledge changes, project actions |
| `audit` | `events` table, immutable | permission decisions, dangerous tool calls |

Flow: any service → `EventBus.emit()` → (a) in-main subscribers (automations later), (b) persistence per catalog class (`activity`/`audit`; `ephemeral` is never written), (c) broadcast on the single push channel `events:event`. The event store is append-only and exposes **no update or delete methods for audit events**.

Consumers:
- **Agent Activity UI (P9):** renders curated event streams as a calm, technical timeline (the removed mock `CommandTimeline`/`EventLog` components, recoverable from git at `47cddbf`, are the visual template) — not raw logs.
- **Audit:** the audit-classified rows in `events` *are* the audit trail for §9 — append-only, no update/delete API.
- **Automations (P11):** event triggers subscribe on the bus.

---

## 11. Storage Strategy

### 11.1 What lives where

Everything Mindeck keeps lives under one user-visible root, **`~/Mindeck/`** (override: `MINDECK_HOME`) — findable in Finder, identical for `npm run dev` and the packaged app, backed up by copying one folder. Changed 2026-10-02 from the hidden `userData/mindeck/` (which was named after the dev package and would have differed in a release build); on first start the old folder is **copied** to `~/Mindeck/data` and left in place as a backup (`paths.ts → migrateLegacyData`). Chromium's own profile (cache, `localStorage`) stays in `userData`. There is no database: the core keeps files only (§11.5).

| Store | Location | Content | Rebuildable? |
|---|---|---|---|
| Markdown vault | `~/Mindeck/vault` (default; configurable via settings) | the memory notes, Obsidian-compatible (§12.3) | **is** the source of truth |
| JSON | `~/Mindeck/data/` | `settings.json`, `projects.json`, `context/<id>.json`, `agents/`, `conversations/`, `grants.json`, `runs.json` | context cache: yes |
| JSON lines | `~/Mindeck/data/events.jsonl` | the activity log, newest 1000 events (compacted at 2000) | no — history |
| safeStorage | OS keychain | LLM API keys (P6) | — |

### 11.2 Vault & Obsidian compatibility

- Default root `~/Mindeck/vault` — user-visible, so the folder can be opened in Obsidian, synced, and backed up. Path configurable (`settings.vaultRoot`). Created lazily on first write, never at boot.
- Notes are plain Markdown with standard YAML frontmatter (`id`, `type`, `title`, `tags`, `created`, `updated`, `aliases?`, `project?`, `summary?`) and `[[wikilinks]]` in the body — a stock Obsidian vault.
- **Mindeck is the primary system; Obsidian is optional.** External edits are legitimate: files win over the index, and the index is always rebuildable from the files.
- Filenames = the note title, because Obsidian resolves `[[wikilinks]]` by filename (a slug would break every hand-written link). Only characters forbidden by Obsidian or the filesystem are stripped (`\ / : * ? " < > | # ^ [ ]`), ≤ 120 chars, ` 2` suffix on collision; daily notes `YYYY-MM-DD.md`. *(Changed from kebab-case slugs, 2026-10-01.)*

**Knowledge identity (binding):** a note's durable identity is `frontmatter.id` (UUID) — never the title, path, filename, or slug, all of which may change freely. Externally created Markdown files without an `id` are indexed as **unadopted**: readable and searchable, but not linkable as entities. Adoption is an explicit, controlled step that assigns a fresh UUID and writes it back into the frontmatter atomically, preserving the rest of the file byte-for-byte (the exact flow ships with P4). Identity is never derived from the path.

### 11.3 Search & retrieval abstractions

Lexical and vector search are deliberately **not** forced behind one low-level interface — they have different write paths, query shapes, and lifecycles. Three separate abstractions:

```ts
/** Lexical search — SQLite FTS5. First implementation in P2B (memories). */
interface TextSearchIndex {
  search(q: { namespace: string; text: string; topK: number }): Promise<SearchHit[]>
}

/** Vector search — arrives in P13 (sqlite-vec first; pgvector/Qdrant adaptable). */
interface EmbeddingIndex {
  upsert(docs: { id: string; namespace: string; vector: Float32Array }[]): Promise<void>
  query(q: { namespace: string; vector: Float32Array; topK: number }): Promise<SearchHit[]>
  delete(namespace: string, ids: string[]): Promise<void>
}

/** Composition layer — created with its first real consumer (P5/P6). */
interface RetrievalService {
  retrieve(q: RetrievalQuery): Promise<RetrievalResult>
}
```

The `RetrievalService` is where ranking lives: it blends FTS scores, embeddings (from P13), `importance`, recency, project scope, and entity links. It does not exist until MemoryService or the Context Engine actually needs it — no speculative layer.

### 11.4 Migration policy

Files carry a `version` field where their shape may change; readers accept older shapes and fill defaults. Anything whose source of truth is the vault (knowledge index, full-text) can always be dropped and rebuilt.

### 11.5 No database on the user's machine (changed 2026-10-11)

User decision: Mindeck Cloud is the one backend with a database (Postgres, accounts and licenses). The core on the user's machine keeps plain files only — a customer installs a Mac app, never Docker.

- **History:** the activity log is `~/Mindeck/data/events.jsonl` (`EventLog`: the newest 1000 events in memory, appended per event, rewritten with the newest once it reaches 2000 lines). Assistant runs are `~/Mindeck/data/runs.json` (`RunStore`, newest 200).
- **Writes:** `lib/writeAtomic` — temp file + rename, one write at a time per file.
- **History of this decision:** from 2026-10-02 to 2026-10-11 the core used an optional Postgres in Docker (`mindeck-db`) for exactly these two things; it was removed before the launch. Where §4/§5/§12 still mention SQLite or Postgres for the core, read "files"; a future full-text index would be rebuildable from the vault.
- **Server image:** `Dockerfile` builds the Mindeck core (API + web UI, §12.4) for a home server; `npm run docker:up` starts it; its data is the `mindeck-data` volume. The Electron app itself stays a desktop app (and can embed the same server).

---

## 12. Implementation Phases

### 12.1 Masterplan reconciliation

| MASTERPLAN phase | Status | Disposition |
|---|---|---|
| 0 Foundation | ✅ done | baseline, unchanged |
| 1 Projects | ✅ done | absorbed — extended into workspaces (new P3) |
| 2 System Monitor | ✅ done | kept as-is |
| 3 Terminal (node-pty) | not started | **kept as optional phase PT** — nothing depends on it (tools use `execFile`, not a PTY); highest native-module risk; schedule on demand |
| 4 Project Context | ✅ backend done (`871ba6d`) | absorbed → P3 lands the UI; output feeds the Context Engine |
| 5 Session Notes | — | superseded → daily notes (P4) + conversation/decision memories (P5/P6) |
| 6 Memory | — | split → Knowledge Base (P4) + Memory Core (P5) |
| 7 AI Layer | — | absorbed → P6 |
| 8 Tool Actions | — | superseded → P7 (tools + permissions) + P8 (runtime) + P9 (activity); §D security rules carried over verbatim |
| 9 Voice | — | deferred, optional PV (after P6) |
| 10 Multi-Agent | — | deferred; data model keeps the door open |

### 12.2 Definitive phase sequence

One deliberate re-ordering versus the original 14-phase directive: **the Permission System merges with the Tool Registry (P7) and precedes the Agent Runtime (P8)** — permission checks are a stated requirement *inside* the agent loop, so building the runtime first would mean immediate rework.

| Phase | Scope | Definition of done |
|---|---|---|
| **P1 Architecture** | this document | ✅ this commit |
| **P2A Core Foundation** | `paths.ts`; SettingsService; SQLite connection (better-sqlite3, WAL, pragmas); migration runner (`user_version`, pre-migration backup with WAL checkpoint); EventBus base (in-main pub/sub + injectable persistence sink — no-op until P2B); minimal shared core types (`entity` minimal, `events` + catalog, `settings`); dev-only DB health/self-check. **No new IPC channels, renderer untouched** | app boots unchanged; `mindeck.db` created (WAL, FK on, `user_version` 0); migration runner proven by scratch-DB self-check; settings roundtrip; both typechecks green |
| **P2B Core Storage** | migration 001: `entities`, `links`, `events`, `memories` + `memories_fts` (+ sync triggers); repository layer (EntityRepo, LinkRepo, EventRepo, MemoryRepo — persistence only, no business logic); `TextSearchIndex` over `memories_fts`; event persistence sink active (catalog-driven; audit append-only, no update/delete); storage IPC **only where a real UI consumer exists** | memory insert → FTS match → delete roundtrip; link CRUD; events persisted per class; audit rows immutable |
| **P2C Vault Foundation** | VaultService: markdown + YAML frontmatter, slugs, wikilink parsing, vault status, identity rules (§11.2); **no** KnowledgeService, **no** `knowledge_index`/`knowledge_fts` (→ P4) | note write/read roundtrip against a scratch root; vault opens cleanly in Obsidian |
| **P3 Projects as Workspaces** | context UI lands (panel in project detail); projects mirrored into `entities`; project hub aggregating linked memories/knowledge/tasks as they arrive in later phases | opening a project shows its structural context |
| **P4 Knowledge Base** | KnowledgeService (CRUD, wikilink/backlink index, chokidar watcher for external edits, adoption flow for unadopted notes); `knowledge_index` + `knowledge_fts` are created **here** with their first consumer (rebuildable from the vault); Knowledge module UI (explorer, markdown viewer/editor, search, tags, backlinks); nav entry | notes round-trip Mindeck ↔ Obsidian; backlinks live |
| **P5 Memory Core** | MemoryService + pipeline scaffold (deterministic stages); `RetrievalService` is introduced here or in P6 with its first real consumer; Memory module UI (browse, search, create, types) | "remember X" via UI persists a typed, linked, searchable memory |
| **P6 AI Foundation + Context Engine** | `LLMProvider` interface + Anthropic adapter (streaming, keys in safeStorage); `buildContext()`; assistant chat in the Command Center (text only, **no tools**); conversations persisted; memory pipeline stages become model-assisted | asking about the active project gets a context-aware streamed answer |
| **P7 Tool Registry + Permission System** | registry + schema validation; policy engine + grants store; ApprovalDialog (Allow Once / Always / Deny); audit events; first SAFE read-only tools | assistant can search memory/knowledge and read project files, gated and audited |
| **P8 Agent Runtime** | controlled loop (limits, timeout, cancellation); runs persisted; permission-gated tool calls; agent definitions (Personal/Coding/Research as data) | an agent completes a bounded multi-step task and is cancellable |
| **P9 Agent Activity** | Agents module UI: live run timeline from `events:event`, run history, cancel; Command Deck filled with live activity | user watches an agent work step by step |
| **P10 Files** | Files module: scoped browsing/preview (markdown/text/JSON/code) via service + tools; file entities linkable to projects/knowledge | files are first-class, linkable entities |
| **P11 Automations** | Automation model + UI; manual + event triggers via EventBus; simple scheduler (no heavy infra) | "every morning summarize open projects" is expressible and runs |
| **P12 Knowledge Graph** | graph queries over `entities`/`links`; graph view (calm, HUD-styled) | graph renders real relations, click-through to entities |
| **P13 Optimization** | `EmbeddingIndex` implementation (sqlite-vec); `RetrievalService` blends lexical + semantic; perf passes; packaging | semantic search beats FTS on real queries |
| **PT Terminal** *(optional)* | node-pty + TerminalService; xterm goes live | any time after P2A |
| **PV Voice** *(optional)* | SpeechProvider abstraction (STT/TTS) | after P6 |

Each phase ships end-to-end (service + IPC + UI in Mindeck's design language), leaves the app bootable, and touches nothing outside its scope. The detailed P2A execution plan (file list, definition of done, dependencies, risks) is specified; implementation starts on explicit release.

### 12.3 Deviation (2026-10-01): Memory is the Obsidian vault

User decision: the AI memory should *be* an Obsidian vault — notes, `[[wikilinks]]`, graph — not a SQLite store beside one. Knowledge and Memory are therefore one module, and the vault is the source of truth for both.

- **Pulled forward and shipped:** P2C (`VaultService`: frontmatter, wikilinks, status, path confinement, atomic writes), the P4 core (backlinks, tags, search, external-edit watcher, read/edit UI) and a P12-lite graph (wikilink graph, colored by top-level folder or one accent; style persisted in `settings.graphStyle`).
- **Editing (2026-10-02):** the editor shows only the note text (`memory:writeBody` keeps the frontmatter byte-for-byte); the title is the filename and renames in place; connect/disconnect buttons write or remove `[[links]]` (new links go under `## Verbindungen`, disconnecting keeps inline mentions as plain text); notes and folders move by drag & drop. Renames and moves rewrite affected links in other notes (`linkEdit.ts`; planned before the move, while old names still resolve) — name-style links only change when the name does, path-style links follow the path.
- **Obsidian-style editor (2026-10-15):** CodeMirror 6 with Live Preview (`features/memory/editor/`: decorations render headings, emphasis, links, task boxes, rules, code blocks and `![[pictures]]` in place; the cursor's lines show their Markdown), plus Source and Read modes. `[[` / `#` complete notes and tags; clicks follow links (⌘-click on the line being edited), unresolved ones create the note. Pasted/dropped pictures go to `attachments/` (`memory:attach`) and are shown only from the vault (`memory:attachment` → data: URL; read mode moves every `src` to `data-embed`). Daily notes (`memory:daily`, ⌘⇧D, folder + template in `settings.dailyNotes`) and `Templates/` (`{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`) fill in the UI's local time. Search is ranked full text (`search.ts`: folded words, prefix matches, BM25 + title/tag boosts, `"phrase"`, `-word`, `tag:`, `path:`) with snippets and match ranges. Attachment embeds are not links (no ghost nodes).
- **Simplified for now:** the index is in-memory (`MemoryIndex`) and rebuilt from the files at open — no `knowledge_index`/FTS tables yet; `fs.watch` (recursive) instead of chokidar; no adoption flow — Mindeck writes `id`/`type`/`created`/`tags` frontmatter only on notes it creates, and graph links are wikilinks, not `links` rows.
- **Model mapping:** §5's `MemoryEntry` fields map onto frontmatter (`id`, `type`, `tags`, `created`, optional `importance`/`confidence`/`summary`). When P2B/P5 land, SQLite `memories` + FTS become a rebuildable index over the vault, and the memory pipeline writes notes. P6/P7 give the assistant read/write tools over this vault behind the permission gate.

### 12.4 Deviation (2026-10-02): one core for desktop, web and mobile

User decision: Mindeck gets a React Native app, and the Docker deploy must be a working web UI. The core therefore became host-independent and network-capable; P3 and P6–P9 shipped together on top of it.

- **Core, not "main process":** every service runs behind `createCore()` (`electron/main/core/createCore.ts`) with an injected `Platform` (`electron` = native dialogs, Finder, OS trash; `headless` = none of those, deletes go to the vault's `.trash`). The Electron app and `server/main.ts` (standalone, `out/server/index.cjs`, Docker) build the same core.
- **One Router:** `electron/ipc/router.ts` is the single dispatch point for desktop IPC and the network API. Per call: channel exists → caller may use it (`CHANNEL_ACCESS`: `any` / `desktop` = native UI or host apps / `terminal` = remote shells, opt-in) → Zod schema (`src/shared/ipc/schemas.ts`) → handler → `IpcResult`.
- **Network API** (`electron/main/server/HttpServer.ts`, reference: [`docs/API.md`](docs/API.md)): `POST /api/rpc/<channel>`, `WS /api/events`, `POST /api/pair`, `GET /api/health`, plus the built web UI at `/`. Devices pair with one-time codes (10 min, rate-limited) and get bearer tokens; only SHA-256 hashes are stored. No cookies, no CORS. Desktop: opt-in in Settings, 127.0.0.1 unless LAN is switched on. Standalone: always on, configured by environment.
- **Clients:** `src/shared/ipc/transport.ts` (bridge | HTTP + WebSocket, only `fetch`/`WebSocket` — the mobile app reuses it unchanged together with `contract.ts`, `schemas.ts` and `types/`).
- **P2B (partial):** migration 001 = `events` + `agent_runs`. `EventLog` keeps a memory ring and writes to Postgres once connected — since 2026-10-11 to `~/Mindeck/data/events.jsonl` instead (§11.5) — (append-only, catalog-driven classes); events are pushed live (`events:event`). `entities`/`links`/`memories` tables still wait for their first consumer.
- **P6:** `LLMProvider` (provider-neutral, the model's own blocks replayed unchanged) + Anthropic adapter (streaming, `claude-opus-5-5` default, effort, adaptive thinking, cached system prompt, server-side refusal fallback). Key from `ANTHROPIC_API_KEY` or the secret store (OS keychain on desktop, 0600 file on a server), verified before saving, never returned. Context engine = time, user, active project, matching vault notes under a budget, sent as a `<context>` block in the user turn (cache-friendly).
- **P7:** `ToolRegistry` (Zod → JSON Schema) with memory, project (confined to the project root), shell and system tools; `PermissionService` = read runs, write asks (Allow once / Always — persisted per agent + tool / Deny), execute always asks; remote devices only run commands with remote shells enabled; unanswered requests are denied after 10 minutes.
- **P8:** `AssistantService` — controlled loop, per-agent iteration and time limits, cancellation, append-only transcript (dangling tool calls are closed as interrupted), structured `agent.*`/`tool.*`/`permission.*` events, no reasoning stored. Agents are data (`agents.ts`: Assistant, Coding, Research with web search/fetch, Chat).
- **P9:** Agents module (chat, tool cards, inline approvals, run activity), floating approvals in every module, Command Deck.
- **Conversations are JSON files** (`~/Mindeck/data/conversations/`), not Postgres rows: the assistant must work on a desktop without the database container. Runs and events go to Postgres when it is there.
- **Still open:** P5 memory pipeline (model-assisted classification), P10 Files, P11 Automations, P12 graph over `entities`/`links`, P13 embeddings, packaging (electron-builder, signing, auto-update), the mobile app itself.

### 12.5 Editor (2026-10-02)

User decision: an editor "like VS Code" in its own module. Not a VS Code replacement (no extensions, debugger or project-wide IntelliSense) — Monaco, VS Code's editor core, for reading and editing project files; VS Code stays one click away.

- **Core:** `FilesService` (`electron/main/services/files/`) — `files:list` (one folder at a time, dirs first, `.git` hidden, `.gitignore` matches flagged), `files:read` (UTF-8 text; binary and > 5 MB files are reported, not sent), `files:stat` (batch), `files:write` (in place, keeps mode and hard links). Every path goes through `lib/confine.ts` (realpath-checked, shared with the agent's file tools).
- **No silent clobbering:** a write carries the mtime the editor loaded; a newer file on disk fails with `conflict` and the user picks *Load disk version* or *Keep mine*. While the module is visible, open tabs are compared with the disk (every 3 s, on window focus): clean tabs reload by themselves (one undoable edit), dirty ones are flagged, deleted ones marked.
- **Renderer:** `features/editor` — a Monaco editor per editor group, one model per open file (own undo history; view state per editor). The store never copies keystrokes: Monaco's alternative version ids decide "dirty", and the text is read from the model (`BufferHost`) only when saving. Monaco and its workers load lazily (own chunks, bundled by Vite, no CDN); TypeScript semantic checks are off because the editor has no project types.
- **Editor groups (2026-10-15):** the editor area is VS Code's grid of groups (`groups.ts`: a tree of rows and columns, pure functions; the store keeps `grid`, `groups` with their own tab lists, `activeGroup`). Open files (`tabs`) are documents — one Monaco model each, shared by every group that shows it, with a view state per group's editor. Groups are drawn once each and only re-positioned (`EditorGrid`), so splitting or resizing never re-creates an editor; buffers live as long as any editor does. ⌘\\ splits right, ⌘K ⌘\\ down (inside Monaco ⌘K is the AI edit prompt, whose first key ⌘\\ splits instead), ⌘1…⌘9 focus (one past the last splits it), tabs drag between bars and onto an editor's edges. Each project has its own layout: switching projects puts the current one aside, and it is stored per device (`localStorage`, paths only) and restored at the next start. A diff, the git graph, a pull request or a collection takes the place of the group that had the focus.
- **Breadcrumbs and outline:** symbols come from Monaco's own command behind ⇧⌘O (`monaco/symbols.ts`), so every provider counts — the built-in TypeScript/CSS/HTML/JSON services and the language servers (`lsp:symbols` → `textDocument/documentSymbol`). They are read per model version and kept with each group's cursor in `outline.ts`.
- **Access:** reading is `any`; `files:write` is `terminal` — writing project files can run code (hooks, scripts), so remote clients may only when remote shells are allowed. Otherwise the web UI shows files read-only.
- **Build memory:** bundling Monaco and its workers needs ~2.5 GB of Node heap; `build` / `web:build` set `--max-old-space-size=4096` themselves, so CI, the Docker build and small machines behave the same.
- **Leaving with unsaved edits:** the renderer vetoes `beforeunload`; the desktop asks (`will-prevent-unload`). The core is disposed on `will-quit` (not `before-quit`), so a cancelled close keeps it alive.

### 12.6 Agent cockpit (2026-10-03)

User decision: the Agents module works with the AI the user already pays for — not only an API key. Mindeck sells the workspace, not the model.

- **Claude Code** runs as the user's own, unmodified CLI in a PTY (`AgentSessionService` → `TerminalService.spawnProgram`, through the login shell). Interactive use stays on the user's plan; Mindeck never sees or stores Claude credentials (Anthropic's terms: no third-party Claude.ai login, no token handling — running the unmodified binary is fine). Everything Mindeck needs is passed per session on the command line, the user's `~/.claude` is never touched:
  - `--settings`: HTTP hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse(Failure)`, `PermissionRequest`, `Stop`, `TaskCreated/Completed`, `SessionEnd`) and a `curl` relay command hook for `SessionStart`/`Notification` (HTTP hooks don't run there).
  - `--mcp-config`: Mindeck's memory as MCP server; `--allowedTools` pre-allows its read tools; `--append-system-prompt`: a short hint to use it.
  - `--session-id` / `--resume`, `--name`.
  - Inherited Claude Code markers (`CLAUDE_CODE_*`, `CLAUDECODE`, …) are stripped from every PTY's environment, so a `claude` started from Mindeck is never mistaken for a child session.
- **Codex and Gemini** speak ACP (`@agentclientprotocol/sdk`, bundled — it is ESM-only) over stdio: Codex through Zed's adapter (`npx @zed-industries/codex-acp`, the user's Codex sign-in), Gemini as `gemini --experimental-acp`. `session/update` streams text, tool calls and the plan; `session/request_permission` goes to the same gate. Mindeck's MCP server is offered when the agent takes HTTP servers.
- **LocalAgentServer**: always-on, `127.0.0.1` on a random port, Host/Origin must be loopback, a random bearer token per session (`timingSafeEqual`). Routes: `/hooks/<session>`, `/mcp/<session>`. Separate from the opt-in network API.
- **Approvals**: `PermissionRequest` (Claude) and `request_permission` (ACP) both go through `PermissionService.ask` — inline cards, toasts (not for the open chat), Command Deck, desktop notification while Mindeck is in the background. Commands are asked every time; file/memory tools can be allowed for good per agent.
- **Changes**: `GitService` takes a baseline when a session starts (`git stash create` — the working tree is untouched, the user's own earlier edits stay out of the diff). Optional own working folder per session: a git worktree in `~/Mindeck/worktrees` with `node_modules` linked (excluded from diffs/patches); *Take over* applies its changes to the project as uncommitted edits (refuses cleanly on conflicts), *Discard* drops it. Diffs open in Monaco's diff editor.
- **Memory (idea 4)**: the MCP server (`mcp.ts`, minimal stateless JSON-RPC) offers `memory_search/read/list/create_note/append` and `project_context` from the built-in tools; a journal note per session (`Agents/<project>/<date> <title>.md`: task, result, changed files, open plan items) is written after every turn, so the next agent — any vendor — can continue.
- **Sessions** are stored in `~/Mindeck/data/agents` (list + one transcript per session); after a restart they show as ended and can be resumed (Claude Code continues its own transcript).
- **Session header**: the name defaults to the agent's ("Claude Code", "Codex") and is renamed in place (`agents:rename`; the journal heading follows, a journal still named after its agent takes the first message). *VS Code* opens the session's folder — its worktree, if it has one (`agents:openInEditor`, shared `lib/openInVsCode`). The repo link comes from `origin` (`GitService.webUrl`, credentials stripped) and points at the repo, since a worktree's `mindeck/…` branch is local only. *Terminal* shows Claude Code's own PTY; ACP agents have none, so it opens a plain shell in the session's folder instead (`agents:shell`, one per session, ended with it).
- **Tests**: unit tests for every piece (git against real repos, the local server over real HTTP, ACP with an in-process agent and a stdio fixture agent); E2E with `tests/e2e/fake-claude.mjs` (`MINDECK_CLAUDE_BIN`) — chat, approval, diff, journal — so CI needs no account.

### 12.7 Mindeck account & license (2026-10-09)

User decision: Mindeck is sold — a 7-hour trial (active use, per account) and a 79 € lifetime license, both held by **Mindeck Cloud** (private repo `mindeck-cloud`: accounts, Stripe, signed entitlements, admin). The core stays local; the cloud only answers *may this account run Mindeck?*

- **`CloudService`** (`electron/main/services/cloud/`): sign-in/registration as this device (`client: desktop | server`, a stable install id), the session token in the shared `SecretStore` (keychain on desktop — one store instance for all secrets), the rest in `~/Mindeck/data/cloud.json`.
- **Heartbeat & entitlement**: while someone uses Mindeck (desktop: the window visible and focused — or focused in the last 2 min — and the system not idle for 5 min; any connected remote client), the core renews its lease (`POST /v1/license/heartbeat`, ~every 60 s). The cloud charges the trial per interval and returns an Ed25519-signed entitlement; the core verifies it (`entitlement.ts`) with the key baked in at build time (or fetched from `/v1/meta` in dev). Trial lease: 90 s; an expired trial lease stays usable (`paused`) at most 2 h once renewing it failed (a cloud answering 5xx). Lifetime: 14 days offline, and for good with the **offline certificate** (`offlineCertificate` in the heartbeat answer: the entitlement format plus `perpetual: true`, ~100 years) the core keeps in the `SecretStore` and drops when the cloud says the license is inactive (refund). `deriveState` turns that into one `LicenseState`.
- **Enforcement**: the Router refuses every channel but `cloud:*` and `app:info` with `license-required` until `CloudService.allowed()` (so the web UI and the mobile app are gated too, not just the window). The renderer's `LicenseGate` (inside `SessionGate`) shows sign-in / confirm email / trial over / offline; when a license ends mid-session it covers the app (`inert`) instead of unmounting it.
- **Where it applies** (`cloud/config.ts`): the packaged desktop app and a server built with the cloud baked in (`isReleaseBuild()` — a build decision, not `NODE_ENV`) always enforce and always use the cloud baked in at build time (`MINDECK_CLOUD_URL`, `MINDECK_CLOUD_KEY` → `define`; Docker: build args). Dev and test runs are open; `MINDECK_LICENSE=required` turns the gate on, `MINDECK_CLOUD_URL` points elsewhere.
- **Profile**: the account card shows the account, plan, trial time left / offline window, *Buy* (Stripe Checkout in the browser), *Check again*, *Sign out*; the nav's profile tab shows who is signed in.

### 12.8 Packaging & updates (2026-10-09)

- **electron-builder** ([`electron-builder.yml`](electron-builder.yml)): DMG + ZIP for arm64 and x64 (`npm run dist:mac`), hardened runtime with [`build/entitlements.mac.plist`](build/entitlements.mac.plist) (helpers: JIT only; the plugin helper, where the lint worker and tsserver run as utility processes, may load the project's native addons — [`build/sign.cjs`](build/sign.cjs)), Electron's fuses set (never runs as Node: Mindeck's Node programs are utility processes, [`electron/main/lib/nodeProcess.ts`](electron/main/lib/nodeProcess.ts)), icon and DMG background rendered from [`build/brand/`](build/brand/) (`node build/brand/render.cjs`). Downloads keep the same name in every release (`Mindeck-mac-<arch>.dmg`, `Mindeck-Setup.exe`, `Mindeck.AppImage`, `Mindeck.deb`) so the website links `releases/latest/download/…`; a tag `v*` builds and publishes all platforms in one release ([`.github/workflows/release.yml`](.github/workflows/release.yml), secrets in [`docs/RELEASE.md`](docs/RELEASE.md)).
- **node-pty** uses its N-API prebuilds (no compiler, `npmRebuild: false`), unpacked from the asar; renderer-only packages (Monaco, React, xterm, …) are excluded from the app's `node_modules` — they are already in the Vite bundle.
- **Updates:** `UpdateService` (electron-updater, packaged app only) checks GitHub Releases 15 s after start and every 4 h, downloads in the background and offers *Restart & update* (top bar chip, Profile → This core). `update:*` channels are desktop-only and license-free. On macOS this needs a signed app.
- **Signing & notarization** come from environment variables at release time — see [`docs/RELEASE.md`](docs/RELEASE.md).

### 12.9 Browser & Files (2026-10-15)

User decision: Mindeck should be the one app for building things — after Editor, Terminal, Agents and Memory, the browser and the file manager were missing. Plan and reasoning: [`docs/WORKSPACE_PLAN.md`](docs/WORKSPACE_PLAN.md), the long-term picture: [`docs/BROWSER_PLAN.md`](docs/BROWSER_PLAN.md).

**Browser**

- **Split like the rest:** `BrowserService` (`electron/main/services/browser/`) is core — tabs, the active tab, closed tabs, per-site zoom/permissions, history, downloads, dev servers, the agent API. It never touches Electron. The desktop app attaches a `BrowserHost` (`electron/main/platform/browser/host.ts`): one `WebContentsView` per tab over the module's viewport, reporting back through `BrowserHostEvents`. A headless core has no host: `browser:*` channels are `desktop`, and its links open in the system browser.
- **Isolation:** every tab runs in the session `persist:mindeck-browser` (its own cookies and storage, never the Mindeck window's), sandboxed, no preload, no Node. Only the Mindeck window may call the core (`bindIpc` checks the sender frame), and `will-navigate` keeps the window on Mindeck's page. The user agent is plain Chrome's (no `Electron`/`Mindeck` tokens) so sites don't serve fallbacks.
- **Behaves like Chrome:** omnibox (history by frecency, open tabs, inline completion, search engine from Settings; `localhost:5173` and `host:port` load directly), tab strip (pin, mute, duplicate, drag to reorder, reopen closed ⌘⇧T), find in page, zoom per site, print, DevTools, native context menus (open link in new tab, copy, inspect, spelling), downloads with progress (macOS quarantine flag set), permission prompts per origin (camera, mic, notifications, geolocation, screen sharing via the system picker), OAuth popups as real windows, `target=_blank` as tabs, error and crash pages, light/dark following the UI. Shortcuts arrive via `before-input-event`, so they work while a page has focus.
- **Overlays:** native views always draw above HTML. While a Mindeck overlay is open (`useOverlay` in `src/lib/overlay.ts`: selects, the omnibox suggestions, the license gate) the view is replaced by a frozen screenshot (`capturePage`) and restored afterwards; approvals show in a dock above the page instead of toasts.
- **Persistence:** `~/Mindeck/data/browser/` — `session.json` (tabs, restored on start), `sites.json` (zoom, permission decisions), `history.jsonl` (append-only, compacted, capped at 10 000 entries). Cookies and site storage live in Chromium's partition under the app's `userData`.
- **Dev servers:** the terminal's output is scanned for local URLs (`DevServerDetector`); the Terminal header and the new-tab page offer them as one-click chips. The Live Server and every link in chats, notes and Files open as Mindeck tabs (Settings → Browser can send them to the system browser instead).
- **Agents:** `browser_tabs/open/navigate/snapshot/read/screenshot/console/click/type/press` (ToolRegistry, offered over MCP to Claude Code, Codex and Gemini). They see only tabs the user shared (the eye in the toolbar), tabs they opened themselves and local dev servers. A snapshot is the accessibility tree with refs (`snapshot.ts`) — clicks and typing go through CDP (`webContents.debugger`, attached lazily, detached after 60 s idle) on those refs; password fields are never read or typed into. Page text reaches the model wrapped as `<untrusted_web_content>`. Reading is pre-allowed; open/navigate/click/type/press ask for approval like file writes.

**Browser: everyday extras** (package browser-ext)

- **Profiles:** `platform/browser/partitions.ts` maps a tab's `profile` to its partition and sets every partition up the same way (UA, permissions, downloads, blocking): the user's `persist:mindeck-browser`; private tabs (⌘⇧N) in the in-memory `mindeck-private` — no history, no session entry, no closed-tab entry, no remembered site choices, never shared, wiped (`clearStorageData`/cache/auth cache) when the last one closes; tabs agents open (`agentOpen`) in `persist:mindeck-agents` without the user's logins unless Settings → Browser → "Agents may use my logins". Tabs opened from a tab (links, popups, favicons) stay in its partition. Tabs the user shares keep their profile.
- **Blocking** (`services/browser/adblock.ts`): Ghostery's engine (`@ghostery/adblocker`, MPL-2.0 — only the engine; the `-electron` wrapper is not used because it injects a preload into pages) over EasyList, EasyPrivacy and uBlock's lists, plus URLhaus (malware-filter, CC0) for pages. Engines are serialized to `data/browser/adblock/*.bin`, refetched when older than a day (checked hourly), and the old engine keeps working while offline. The host asks the core per request (`session.webRequest.onBeforeRequest` → `BrowserHostEvents.request`); page loads are never blocked by the ad lists, a malware hit cancels the page and the tab shows a warning (`TabError.danger`, `browser:proceed` trusts the host until quit). Element hiding is a user style sheet inserted at `dom-ready` (host rules only — generic DOM-based rules would need a preload). Per-site off switch from the shield in the address bar (`adblock/state.json`), count per page on `BrowserTab.shield`.
- **Chrome extensions** (`services/browser/extensions/*`, `platform/browser/extensions.ts`): installed from the Chrome Web Store (update protocol `clients2.google.com/service/update2/crx`, the CRX3 header's signatures verified like Chrome does, the developer key written to `manifest.key` so the id stays the Web Store's, `_metadata` removed), from an unpacked folder (loaded in place) or copied from a Chrome/Brave/Edge/Vivaldi/Arc profile (`Extensions/<id>/<version>`). Loaded with `session.extensions.loadExtension` into the user's partition only (Electron cannot load into in-memory sessions; the agents' container stays clean). Toolbar icons open `action.default_popup` in a `WebContentsView` of its own (preferred-size mode, closes on blur/Escape/`window.close`). `data/browser/extensions.json` remembers them; Web Store updates every 12 h. `electron-chrome-extensions` was not used: GPL-3 or a paid patron license, incompatible with Mindeck's license. Electron 44 provides `runtime`, `storage.local`, `tabs` (partly), `scripting`, `webRequest`, `management`, `i18n` — not `action`, `alarms`, `contextMenus`, `offscreen`, `declarativeNetRequest`, `notifications`, `webNavigation`, `storage.session`. The manager lists what an extension asks for and which of it Electron lacks. Consequence: Bitwarden (MV3, needs alarms/contextMenus/offscreen/webNavigation) installs and its popup opens, but its service worker is not expected to work fully; uBlock Origin Lite installs but cannot block (no `declarativeNetRequest`) — the built-in blocker covers that. Neither could be run here (no Electron in CI); a real check is open.
- **Pages:** HTML fullscreen puts the tab's view over the whole window (Escape or another tab leaves it); picture in picture from the context menu of a video; `playing` per tab (media-started-playing/paused); HTTP authentication (`login` → `BrowserState.auth` → dialog over the frozen page → `browser:auth`); downloads to a chosen folder or "ask each time", "Save … As" for links, images and media; DRM: known streaming sites and players' console complaints set `BrowserTab.drm`, a bar offers the system browser (no castlabs Electron).

**Browser: tabs like Arc and Edge** (package browser, 2026-10-15)

- **Vertical tabs:** Settings → Browser, the tab menu or ⌘⇧, (Edge's key) put the tabs in a sidebar on the left of the browser (`VerticalTabs.tsx`): pinned tabs as an icon grid on top, then tabs and groups with their titles, the same marks as the strip (sound, private, agents' container, agent, split). It folds to icon width; its width is dragged (the pages frozen meanwhile, like a workspace divider) and kept in `BrowserSettings.verticalTabsWidth`. Tab search (⌘⇧A) stays.
- **Tab groups** (`services/browser/arrangement.ts`, Chrome's model): a group is one run of tabs with a name and a color from the accent tokens (`TAB_GROUP_COLORS`); pinned tabs are never in one, private tabs never share one with others (`BrowserTabGroup.private`). `TabArrangement` keeps the order tidy after every change (`arrange`: pinned first, a group's tabs together where its first tab is; empty groups go). Made from the tab menu ("Add Tab to New Group", "Add Tab to Group ▸") or ⌘⇧G, which opens the group editor (name, color, new tab in group, ungroup, close group); a chip folds and unfolds the group, dragging a tab onto a chip or among a group's tabs moves it in (`browser:move` with `groupId`), elsewhere out. Folding the group on screen shows the next tab outside it; showing a tab of a folded group unfolds it. Tabs opened from a grouped tab join its group, a reopened tab goes back into its group while it is open. Groups are in `session.json` (and wait with the tabs after a crash); private groups never are.
- **Split view** (Edge/Arc): two tabs side by side or stacked (`BrowserSplit`: the pair, the first page's share, `vertical`). From the tab menu ("Split with New Tab", "Open Beside Current Tab"), the toolbar, ⌘⇧D, or by dragging a tab onto an edge of the page (drop zones over the frozen pages). `activeId` is the focused side — the omnibox, the keys and the agents' default tab follow it; clicking into the other page (`focused` from the host) moves the focus there. The renderer measures each pane and sends them with `browser:view` (`panes`); the host lays the two `WebContentsView`s out in them and shows the second only once its pane is known; `freeze` returns a picture per visible tab. The divider keeps each page at least 200 px; HTML fullscreen still covers the window for the one page; closing either tab ends the split (the other takes the focus). Splits are kept in the session. `browser_tabs` tells agents which tabs are on screen.

**Files**

- **`FinderService`** (`electron/main/services/finder/`): places (Home, Desktop, Documents, Downloads, Pictures, Movies, Music — each only if it exists), external drives (`/Volumes`, system volumes filtered), list (one folder at a time, capped, bundles like `.app` shown as files), search (Spotlight `mdfind` on macOS, a bounded walk elsewhere), preview (type by extension; the first 256 KB of text), mkdir/rename/move/copy (never overwrite: `name 2.ext`), trash (OS trash), open with the default app, reveal in Finder. Reading may go anywhere the OS allows; writing only inside Home and mounted drives (realpath of the parent checked). `finder:*` channels are `desktop`.
- **Everyday operations (2026-10-15):** copy/cut/paste inside Mindeck and through the system clipboard (`fileClipboard.ts`: `NSFilenamesPboardType` on macOS, `x-special/gnome-copied-files` + `text/uri-list` on Linux, `FileNameW` read / paths as text on Windows), transfers with a conflict dialog (keep both / skip / replace → the old one to the trash) and progress (`finder:transfer`, `finder:progress`, `finder:cancel`; big files stream, small ones `copyFile`/clone). Undo (⌘Z) for rename, move, copy, new folder; for the trash on all three desktops through one `RestorableTrash` (`platform/trash.ts`): Linux trashes itself into the freedesktop trash; macOS calls `NSFileManager trashItemAtURL:resultingItemURL:` through JXA (`trashMac.ts`, path as `argv`, no Finder automation) and keeps where the item went — putting back is a move, and a refusal by TCC on `~/.Trash` is reported as `full-disk-access` with a link to System Settings (`finder:privacySettings`); Windows recycles with `shell.trashItem` and finds the item again by the `$I` records in `<drive>:\$Recycle.Bin\<SID>` (`trashWindows.ts`, no PowerShell, no localized verbs), putting back = moving `$R…` home and dropping its record. Each side remembers the trashed item's inode/file id, so a different item under that name is never taken back. Undo of a mixed selection restores what can come back; a taken name keeps both ("name 2"), and what was emptied from the trash since is named (`trash-gone`). OS drag and drop: drops from other apps are copied (`webUtils.getPathForFile` in the preload), rows start an OS drag (`files:start-drag` → `webContents.startDrag` with the file's icon) which moves when it comes back. ZIP compress/extract and `.tar`/`.tar.gz` extract in plain JS (`archive.ts`, yazl/yauzl; no `..`/absolute names, no links created, free space checked). Folders are listed in pages of 1000 (names kept 30 s) and rendered windowed; column view, tabs, pinned folders and an info part (created, permissions, owner, folder size) complete it.
- **Pictures without copies:** `mindeck-file://local/<path>` streams a file to the Mindeck window (Range requests, so videos seek; non-media served as `text/plain` + `nosniff`), `mindeck-file://thumb/<path>?size=` returns the OS thumbnail (Quick Look via `nativeImage.createThumbnailFromPath`). The CSP allows the scheme only for `img-src` and `media-src`.
- **Renderer** (`features/files`): sidebar (favorites, Memory vault, projects, drives — drop targets, ⌥ copies), path bar (⌘⇧G / double-click: type a path, `~` works), list with sortable columns or an icon grid, preview pane (Markdown rendered, links open in the browser), context menus, Finder's keys (arrows, ⇧ range, ⌘A, Enter/⌘↓ open, F2 rename, ⌘⌫ trash, ⌘[ / ⌘] / ⌘↑, Space preview, ⌘⇧N). Opening decides: folders in place, text files of a registered project in the Editor, HTML/PDF in the Browser, the rest with its app; "Open Terminal here" (`terminal:create` with `cwd`) and "Ask an agent about it" connect it to the other modules.

