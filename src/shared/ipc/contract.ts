// The single source of truth for renderer↔main IPC.
// Main handlers, the preload allowlist, and the renderer client all derive
// their types from IpcChannels — add a capability here exactly once.
//
// Pure module (no DOM/Node/Electron) so it compiles under both tsconfigs.

import type { Project } from '@shared/types/project'
import type { SystemSnapshot } from '@shared/types/system'
import type { ProjectContext, ContextProgress } from '@shared/types/context'
import type {
  DailyNotesSettings,
  GraphStyle,
  MemoryChanged,
  MemoryGraph,
  Note,
  NoteMeta,
  SearchHit,
  VaultAttachment,
  VaultStatus
} from '@shared/types/memory'
import type {
  TerminalAttach,
  TerminalData,
  TerminalExit,
  TerminalInfo,
  TerminalReveal,
  TerminalSettings,
  TerminalShell,
  TerminalSnapshot
} from '@shared/types/terminal'
import type { FileContent, FileEntry, FileStat } from '@shared/types/files'
import type {
  LspCodeFix,
  LspCompletion,
  LspCompletionDetails,
  LspDiagnostic,
  LspHover,
  LspLocation,
  LspRange,
  LspRename,
  LspSignature,
  LspSymbol
} from '@shared/types/lsp'
import type { DebugAction, DebugBreakpoint, DebugOutput, DebugSession, DebugVariable } from '@shared/types/debug'
import type { LanguageStatus, RuntimeInfo, ToolProgress } from '@shared/types/languages'
import type { LiveServerStatus, SassResult } from '@shared/types/live'
import type { SftpEntry, SftpProgress, SftpTarget } from '@shared/types/sftp'
import type { SyncStatus, SyncUi } from '@shared/types/sync'
import type { RemoteConnection, SshHost } from '@shared/types/remote'
import type { LintResult } from '@shared/types/lint'
import type { TestItem, TestRunState } from '@shared/types/tests'
import type { MongoCollection, MongoConnection, MongoDatabase, MongoDocuments, MongoIndex, MongoQuery } from '@shared/types/mongo'
import type { GitHubStatus, MergeMethod, PullCreate, PullDetail, PullFileDiff, PullFilter, PullListState, PullSummary, ReviewAction } from '@shared/types/github'
import type { EditorSettings, MigrationResult, MigrationSource, Snippet } from '@shared/types/migrate'
import type { ScmBlame, ScmBranch, ScmCommit, ScmCommitDetail, ScmCommitFile, ScmDiffTarget, ScmStash, ScmStatus } from '@shared/types/scm'
import type { SearchEngine, SearchProgress, TextSearchQuery } from '@shared/types/search'
import type {
  AgentAvailability,
  AgentMessageUpdate,
  AgentSession,
  AgentSessionDetail,
  AgentInput,
  CreateSessionRequest,
  FileChange,
  SessionBranch,
  SessionConfigure,
  FileDiff
} from '@shared/types/agents'
import type {
  AppInfo,
  Device,
  DeviceRole,
  DirListing,
  PairingCode,
  ServerConfig,
  ServerStatus,
  UpdateStatus
} from '@shared/types/server'
import type { KernelInfo, NotebookEvent } from '@shared/types/notebook'
import type {
  AgentInfo,
  AgentRun,
  AiDelta,
  AiMessageUpdate,
  AiSettings,
  AiStatus,
  ApprovalDecision,
  Conversation,
  ConversationSummary,
  InlineCompleteRequest,
  InlineDelta,
  InlineEditRequest,
  PermissionGrant,
  PermissionRequest,
  SendRequest,
  ToolInfo
} from '@shared/types/ai'
import type { MindeckEvent } from '@shared/types/events'
import type { CloudAccount, CloudStatus, PushSettings } from '@shared/types/cloud'
import type {
  BrowserCommand,
  BrowserFind,
  BrowserGo,
  BrowserPane,
  BrowserSettings,
  BrowserSplit,
  BrowserState,
  BrowserSuggestion,
  BrowserTab,
  BrowserTabGroup,
  BrowserTool,
  HistoryEntry,
  TabGroupColor,
  ViewBounds,
  WorkspaceKey
} from '@shared/types/browser'
import type {
  FinderEntry,
  FinderInfo,
  FinderListing,
  FinderPlaces,
  FinderPreview,
  FinderProgress,
  FolderSize,
  TransferRequest,
  TransferResult,
  TrashedItem,
  UntrashResult
} from '@shared/types/finder'
import type { BookmarkFolder, BookmarkNode, ImportProgress, ImportRequest, ImportResult, ImportSource } from '@shared/types/browserData'
import type { BrowserExtension, ChromiumProfile, ExtensionInstall, ExtensionUpdateReport } from '@shared/types/browserExtensions'
import type { CloseBehavior, DesktopStatus, RendererError } from '@shared/types/desktop'

/** A position in a project file, for the lsp:* queries. */
export interface LspAt {
  projectId: string
  path: string
  line: number
  offset: number
}

/** Every IPC call resolves to this — errors never cross the bridge as throws. */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

/** Renderer→main request/response channels. `request: void` means no payload. */
export interface IpcChannels {
  'projects:list': { request: void; response: Project[] }
  'projects:pickFolder': { request: void; response: { path: string } | null }
  'projects:add': { request: { path: string }; response: Project }
  'projects:remove': { request: { id: string }; response: void }
  'projects:refresh': { request: { id: string }; response: Project }
  /** `git pull --ff-only` in the project, then fresh detection. */
  'projects:pull': { request: { id: string }; response: Project }
  'projects:openInEditor': { request: { id: string }; response: void }
  /** GitHub Desktop's name when it is installed on the desktop, else null. */
  'projects:githubDesktop': { request: void; response: string | null }
  'projects:openInGitHubDesktop': { request: { id: string }; response: void }
  'projects:openFile': { request: { id: string; file: string; line?: number }; response: void }
  /** Trust a project (its own tools may run, see Project.trusted) — or restrict it again. */
  'projects:trust': { request: { id: string; trusted: boolean }; response: Project }

  'system:subscribe': { request: void; response: void }
  'system:unsubscribe': { request: void; response: void }
  'system:snapshot': { request: void; response: SystemSnapshot }
  'system:user': { request: void; response: { name: string; firstName: string } }

  'context:get': { request: { projectId: string }; response: ProjectContext | null }
  'context:reindex': { request: { projectId: string }; response: ProjectContext }

  'memory:status': { request: void; response: VaultStatus }
  'memory:createVault': { request: void; response: VaultStatus }
  'memory:pickVault': { request: void; response: VaultStatus | null }
  'memory:list': { request: void; response: NoteMeta[] }
  'memory:read': { request: { path: string }; response: Note }
  'memory:write': { request: { path: string; raw: string }; response: NoteMeta }
  /** `template`: a template note to start from; `now`: the UI's local time ("2026-10-15T09:30:00") for its dates. */
  'memory:create': { request: { title: string; folder?: string; template?: string; now?: string }; response: NoteMeta }
  'memory:trash': { request: { path: string }; response: void }
  'memory:graph': { request: void; response: MemoryGraph }
  'memory:search': { request: { query: string }; response: SearchHit[] }
  'memory:setGraphStyle': { request: GraphStyle; response: GraphStyle }
  'memory:reveal': { request: void; response: void }
  'memory:folders': { request: void; response: string[] }
  'memory:writeBody': { request: { path: string; body: string }; response: NoteMeta }
  'memory:createFolder': { request: { parent: string; name: string }; response: string }
  'memory:rename': { request: { path: string; title: string }; response: NoteMeta }
  'memory:move': { request: { path: string; folder: string }; response: NoteMeta }
  'memory:moveFolder': { request: { folder: string; into: string }; response: string }
  'memory:link': { request: { from: string; to: string }; response: NoteMeta }
  'memory:unlink': { request: { from: string; to: string }; response: NoteMeta }
  /** Today's daily note — created from the daily template the first time. */
  'memory:daily': { request: { now?: string }; response: NoteMeta }
  'memory:setDailyNotes': { request: DailyNotesSettings; response: DailyNotesSettings }
  /** A template's body filled in for `title` (for "Insert template"). */
  'memory:renderTemplate': { request: { path: string; title: string; now?: string }; response: string }
  /** Save a pasted/dropped picture (base64) under `attachments/`; `link` goes into `![[…]]`. */
  'memory:attach': { request: { name: string; data: string }; response: { path: string; link: string } }
  /** A picture a note shows, resolved like Obsidian (relative to `from`, the note) — from the vault only. */
  'memory:attachment': { request: { target: string; from?: string }; response: VaultAttachment }

  /** In a project, in `cwd` (an absolute folder, e.g. from Files), else in Home. */
  /** A shell in a project, a folder or Home — with a profile (`terminal:shells` or the user's), else the default one. */
  'terminal:create': { request: { projectId?: string; cwd?: string; cols?: number; rows?: number; profileId?: string }; response: TerminalInfo }
  'terminal:list': { request: void; response: TerminalInfo[] }
  'terminal:attach': { request: { id: string }; response: TerminalAttach }
  'terminal:write': { request: { id: string; data: string }; response: void }
  'terminal:resize': { request: { id: string; cols: number; rows: number }; response: void }
  'terminal:kill': { request: { id: string }; response: void }
  /** The shells installed on this machine (zsh, bash, fish, pwsh · cmd, WSL on Windows). */
  'terminal:shells': { request: void; response: TerminalShell[] }
  'terminal:settings': { request: void; response: TerminalSettings }
  'terminal:configure': { request: Partial<TerminalSettings>; response: TerminalSettings }
  /** The tabs, layout and recent output, saved for the next start. */
  'terminal:persist': { request: TerminalSnapshot; response: void }
  /** What `terminal:persist` saved last (null: nothing, or restoring is off). */
  'terminal:restore': { request: void; response: TerminalSnapshot | null }

  'files:list': { request: { projectId: string; dir?: string }; response: FileEntry[] }
  'files:read': { request: { projectId: string; path: string }; response: FileContent }
  'files:stat': { request: { projectId: string; paths: string[] }; response: (FileStat | null)[] }
  'files:write': {
    request: { projectId: string; path: string; content: string; expectedMtime?: number }
    response: FileStat
  }
  'files:create': { request: { projectId: string; path: string; kind: 'file' | 'dir' }; response: void }
  'files:rename': { request: { projectId: string; from: string; to: string }; response: void }
  /** Into the trash (desktop: the OS trash), never deleted outright. */
  'files:delete': { request: { projectId: string; path: string }; response: void }

  'scm:status': { request: { projectId: string }; response: ScmStatus }
  'scm:init': { request: { projectId: string }; response: ScmStatus }
  'scm:stage': { request: { projectId: string; paths: string[] }; response: void }
  'scm:unstage': { request: { projectId: string; paths: string[] }; response: void }
  /** Untracked files are deleted — the UI asks first. */
  'scm:discard': { request: { projectId: string; paths: string[] }; response: void }
  'scm:commit': { request: { projectId: string; message: string; amend?: boolean; all?: boolean }; response: void }
  'scm:fetch': { request: { projectId: string }; response: void }
  'scm:pull': { request: { projectId: string }; response: void }
  'scm:push': { request: { projectId: string }; response: void }
  'scm:branches': { request: { projectId: string }; response: ScmBranch[] }
  'scm:checkout': { request: { projectId: string; name: string }; response: void }
  'scm:createBranch': { request: { projectId: string; name: string }; response: void }
  'scm:log': { request: { projectId: string; limit?: number }; response: ScmCommit[] }
  'scm:show': { request: { projectId: string; hash: string }; response: ScmCommitDetail }
  'scm:diff': { request: { projectId: string; path: string; target: ScmDiffTarget }; response: FileDiff }
  /** The staged text of a file (the gutter's baseline); null when untracked or not in a repo. */
  'scm:original': { request: { projectId: string; path: string }; response: string | null }
  /** Every file of the project, for quick open (⌘P). */
  'scm:files': { request: { projectId: string }; response: string[] }
  /** Give up the merge / rebase / cherry-pick / revert in progress. */
  'scm:abort': { request: { projectId: string }; response: void }
  /** Go on with it once the conflicts are resolved and staged. */
  'scm:continue': { request: { projectId: string }; response: void }
  'scm:stashes': { request: { projectId: string }; response: ScmStash[] }
  'scm:stash': { request: { projectId: string; message?: string; untracked?: boolean }; response: void }
  /** `pop`: drop the stash once applied. Stashes are named by hash (their positions shift). */
  'scm:applyStash': { request: { projectId: string; hash: string; pop?: boolean }; response: void }
  'scm:dropStash': { request: { projectId: string; hash: string }; response: void }
  'scm:stashFiles': { request: { projectId: string; hash: string }; response: ScmCommitFile[] }
  /** Who last changed each line; `text` = the editor's buffer (unsaved edits are uncommitted lines). */
  'scm:blame': { request: { projectId: string; path: string; text?: string }; response: ScmBlame }

  /**
   * Project-wide search (⇧⌘F): results stream as `search:progress` events
   * under the client's `id`; a new search or `search:cancel` stops it.
   */
  'search:start': { request: { id: string; projectId: string; query: TextSearchQuery }; response: { engine: SearchEngine } }
  'search:cancel': { request: { id: string }; response: void }

  /** TypeScript intelligence (the project's tsserver). Positions are 1-based. */
  /** `language`: the file's language (registry id), whether or not its server runs. */
  'lsp:open': { request: { projectId: string; path: string; text: string }; response: { available: boolean; language?: string } }
  'lsp:change': { request: { projectId: string; path: string; text: string }; response: void }
  'lsp:close': { request: { projectId: string; path: string }; response: void }
  'lsp:diagnostics': { request: { projectId: string; paths: string[] }; response: Record<string, LspDiagnostic[]> }
  'lsp:hover': { request: LspAt; response: LspHover | null }
  'lsp:completions': { request: LspAt & { trigger?: string }; response: LspCompletion[] }
  'lsp:completionDetails': { request: LspAt & { name: string; source?: string; data?: unknown }; response: LspCompletionDetails | null }
  'lsp:definition': { request: LspAt; response: LspLocation[] }
  'lsp:references': { request: LspAt; response: LspLocation[] }
  'lsp:rename': { request: LspAt & { newName: string }; response: LspRename }
  'lsp:signature': { request: LspAt; response: LspSignature | null }
  'lsp:codeFixes': { request: { projectId: string; path: string; range: LspRange; errorCodes: number[] }; response: LspCodeFix[] }
  /** A file's symbols from its language server (the outline, breadcrumbs); TypeScript's come from Monaco itself. */
  'lsp:symbols': { request: { projectId: string; path: string }; response: LspSymbol[] }

  /** Run & Debug: a program under Node's inspector or its language's debug adapter (one session at a time); `build` runs first. */
  'debug:start': {
    request: { projectId: string; program: string; args?: string[]; stopOnEntry?: boolean; breakpoints: DebugBreakpoint[]; build?: string; inspectChild?: boolean; module?: string; goTest?: boolean }
    response: DebugSession
  }
  'debug:stop': { request: void; response: void }
  'debug:session': { request: void; response: DebugSession | null }
  'debug:control': { request: { action: DebugAction }; response: void }
  'debug:setBreakpoints': { request: { projectId: string; breakpoints: DebugBreakpoint[] }; response: void }
  'debug:variables': { request: { objectId: string }; response: DebugVariable[] }
  'debug:evaluate': { request: { expression: string; frameId?: string }; response: DebugVariable }

  /** Language servers and debuggers on this machine (Settings → Languages). */
  'tools:status': { request: void; response: LanguageStatus[] }
  'tools:install': { request: { id: string; part: 'server' | 'debugger' }; response: LanguageStatus }
  /** Node, npm and git on this machine (the onboarding's checklist). */
  'tools:runtimes': { request: void; response: RuntimeInfo[] }

  /** Moving over from VS Code / Cursor: what's there (read only), and taking it over. */
  'migrate:scan': { request: void; response: MigrationSource[] }
  'migrate:apply': { request: { app: string }; response: MigrationResult }
  /** The editor's preferences, keybindings and snippets. */
  'editor:settings': { request: void; response: { settings: EditorSettings; snippets: Snippet[] } }
  'editor:update': { request: Partial<EditorSettings>; response: EditorSettings }
  /** ESLint and Prettier from the project's node_modules (they run the project's config code: remote shells only). */
  'lint:file': { request: { projectId: string; path: string; text: string }; response: LintResult }
  'lint:fix': { request: { projectId: string; path: string; text: string }; response: string | null }
  'lint:restart': { request: void; response: void }
  'format:document': { request: { projectId: string; path: string; text: string; prettier?: boolean; options?: Record<string, string | number | boolean> }; response: string | null }
  /** The test explorer: tests found without running anything; runs and debugs with the project's runner (project code: remote shells only). */
  'tests:discover': { request: { projectId: string }; response: TestItem[] }
  'tests:state': { request: { projectId: string }; response: TestRunState }
  'tests:run': { request: { projectId: string; id?: string }; response: TestRunState }
  'tests:cancel': { request: { projectId: string }; response: void }
  'tests:debug': { request: { projectId: string; id: string; breakpoints: DebugBreakpoint[] }; response: DebugSession }
  'notebook:kernels': { request: { projectId: string }; response: KernelInfo }
  'notebook:setup': { request: { projectId: string }; response: string }
  'notebook:start': { request: { projectId: string; path: string; kernel: string }; response: void }
  'notebook:execute': { request: { projectId: string; path: string; cell: string; code: string }; response: void }
  'notebook:interrupt': { request: { projectId: string; path: string }; response: void }
  'notebook:restart': { request: { projectId: string; path: string }; response: void }
  'notebook:shutdown': { request: { projectId: string; path: string }; response: void }

  /** Live Server: a project served on 127.0.0.1 with reload on change; `page` opens in the browser. */
  'liveServer:status': { request: void; response: LiveServerStatus[] }
  'liveServer:start': { request: { projectId: string; page?: string }; response: LiveServerStatus }
  'liveServer:stop': { request: { projectId: string }; response: void }
  /** Live Sass Compiler: a saved .scss / .sass file (a partial: every file), or all of them. */
  'sass:compile': { request: { projectId: string; path: string }; response: SassResult }
  'sass:compileAll': { request: { projectId: string }; response: SassResult }

  /** SFTP as configured in .vscode/sftp.json. */
  'sftp:targets': { request: { projectId: string }; response: SftpTarget[] }
  'sftp:list': { request: { projectId: string; target: string; dir?: string }; response: SftpEntry[] }
  'sftp:upload': { request: { projectId: string; target: string; paths: string[] }; response: number }
  'sftp:download': { request: { projectId: string; target: string; paths: string[] }; response: string[] }
  'sftp:sync': { request: { projectId: string; target: string; direction: 'up' | 'down' }; response: number }
  /** GitHub pull requests through the user's gh CLI. */
  'github:status': { request: { projectId: string }; response: GitHubStatus }
  'github:list': { request: { projectId: string; filter?: PullFilter; state?: PullListState }; response: PullSummary[] }
  'github:view': { request: { projectId: string; number: number }; response: PullDetail }
  'github:fileDiff': { request: { projectId: string; number: number; path: string }; response: PullFileDiff }
  'github:checkout': { request: { projectId: string; number: number }; response: void }
  'github:create': { request: { projectId: string } & PullCreate; response: { number: number; url: string } }
  'github:merge': { request: { projectId: string; number: number; method: MergeMethod; deleteBranch?: boolean }; response: void }
  'github:comment': { request: { projectId: string; number: number; body: string }; response: void }
  'github:review': { request: { projectId: string; number: number; action: ReviewAction; body?: string }; response: void }
  /** MongoDB: saved connections (strings stay in the core), databases, collections, documents as Extended JSON. */
  'mongo:connections': { request: void; response: MongoConnection[] }
  'mongo:add': { request: { name: string; uri: string }; response: MongoConnection }
  'mongo:remove': { request: { id: string }; response: void }
  'mongo:databases': { request: { id: string }; response: MongoDatabase[] }
  'mongo:collections': { request: { id: string; db: string }; response: MongoCollection[] }
  'mongo:createCollection': { request: { id: string; db: string; name: string }; response: void }
  'mongo:dropCollection': { request: { id: string; db: string; name: string }; response: void }
  'mongo:find': { request: { id: string; db: string; collection: string; query?: MongoQuery }; response: MongoDocuments }
  'mongo:insert': { request: { id: string; db: string; collection: string; document: string }; response: string }
  'mongo:replace': { request: { id: string; db: string; collection: string; docId: string; document: string }; response: void }
  'mongo:delete': { request: { id: string; db: string; collection: string; docId: string }; response: void }
  'mongo:aggregate': { request: { id: string; db: string; collection: string; pipeline: string }; response: string[] }
  'mongo:indexes': { request: { id: string; db: string; collection: string }; response: MongoIndex[] }
  /** Remote-SSH and Dev Containers: Mindeck's core on another machine / in a container, in a window of its own. */
  'remote:hosts': { request: void; response: SshHost[] }
  'remote:list': { request: void; response: RemoteConnection[] }
  'remote:ssh': { request: { target: string }; response: RemoteConnection }
  'remote:container': { request: { projectId: string }; response: RemoteConnection }
  'remote:hasContainer': { request: { projectId: string }; response: boolean }
  'remote:disconnect': { request: { id: string }; response: void }

  'app:info': { request: void; response: AppInfo }
  /** Folders on the core's machine; paired devices see the shared folders only (no `path` = the first). */
  'fs:dirs': { request: { path?: string }; response: DirListing }
  'memory:setVault': { request: { path: string }; response: VaultStatus }

  'server:status': { request: void; response: ServerStatus }
  'server:configure': { request: Partial<ServerConfig>; response: ServerStatus }
  /** A one-time code; the device that redeems it gets `role` (default `member`). */
  'server:createPairingCode': { request: { role?: DeviceRole }; response: PairingCode }
  'server:devices': { request: void; response: Device[] }
  /** Admins remove any device; every device may remove itself (unpair). */
  'server:revokeDevice': { request: { id: string }; response: void }
  'server:setDeviceRole': { request: { id: string; role: DeviceRole }; response: Device[] }

  'ai:status': { request: void; response: AiStatus }
  'ai:setKey': { request: { key: string }; response: AiStatus }
  'ai:clearKey': { request: void; response: AiStatus }
  'ai:configure': { request: Partial<AiSettings>; response: AiStatus }
  'ai:agents': { request: void; response: AgentInfo[] }
  'ai:tools': { request: void; response: ToolInfo[] }
  'ai:conversations': { request: void; response: ConversationSummary[] }
  'ai:conversation': { request: { id: string }; response: Conversation }
  'ai:send': { request: SendRequest; response: { conversationId: string; messageId: string } }
  'ai:cancel': { request: { conversationId: string }; response: void }
  'ai:deleteConversation': { request: { id: string }; response: void }
  'ai:runs': { request: { limit?: number }; response: AgentRun[] }
  'ai:inlineComplete': { request: InlineCompleteRequest; response: string }
  'ai:inlineEdit': { request: InlineEditRequest; response: string }
  'ai:inlineCancel': { request: { requestId: string }; response: void }

  'permission:pending': { request: void; response: PermissionRequest[] }
  'permission:respond': { request: { id: string; decision: ApprovalDecision }; response: void }
  'permission:grants': { request: void; response: PermissionGrant[] }
  /** Exactly one grant: `projectId` as in `permission:grants` (none = outside projects). */
  'permission:revoke': { request: { agentId: string; toolName: string; projectId?: string }; response: void }

  'events:recent': { request: { limit?: number; conversationId?: string }; response: MindeckEvent[] }

  'agents:detect': { request: void; response: AgentAvailability[] }
  'agents:list': { request: void; response: AgentSession[] }
  'agents:get': { request: { id: string }; response: AgentSessionDetail }
  'agents:create': { request: CreateSessionRequest; response: AgentSession }
  'agents:send': { request: AgentInput & { id: string }; response: void }
  'agents:configure': { request: SessionConfigure & { id: string }; response: AgentSession }
  'agents:pushSettings': { request: void; response: PushSettings }
  'agents:setPushSettings': { request: { enabled: boolean }; response: PushSettings }
  'agents:interrupt': { request: { id: string }; response: void }
  'agents:stop': { request: { id: string }; response: void }
  'agents:resume': { request: { id: string }; response: AgentSession }
  'agents:remove': { request: { id: string }; response: void }
  'agents:changes': { request: { id: string }; response: FileChange[] }
  'agents:branch': { request: { id: string }; response: SessionBranch | null }
  'agents:diff': { request: { id: string; path: string }; response: FileDiff }
  'agents:accept': { request: { id: string }; response: { files: number } }
  'agents:discard': { request: { id: string }; response: void }
  'agents:rename': { request: { id: string; title: string }; response: AgentSession }
  'agents:shell': { request: { id: string }; response: { terminalId: string } }
  'agents:openInEditor': { request: { id: string }; response: void }

  'cloud:status': { request: void; response: CloudStatus }
  'cloud:login': { request: { email: string; password: string }; response: CloudStatus }
  'cloud:register': {
    request: { email: string; password: string; name?: string; locale: 'de' | 'en' }
    response: CloudStatus
  }
  'cloud:logout': { request: void; response: CloudStatus }
  'cloud:refresh': { request: void; response: CloudStatus }
  'cloud:resendVerification': { request: void; response: void }
  'cloud:forgotPassword': { request: { email: string }; response: void }
  'cloud:checkout': { request: void; response: { url: string } }
  /** Settings Sync through the account (Profile): status, save to the account (force: over a newer copy), load from it. */
  /** A follower core (Remote-SSH, Dev Container) takes the desktop's entitlement over. */
  /** `revokedKids`: the signing key ids the desktop knows to be revoked (the follower never asks the cloud). */
  'cloud:adopt': { request: { token: string; account: CloudAccount; revokedKids?: string[] }; response: CloudStatus }
  /** A follower core's install id: the desktop asks Mindeck Cloud for a lease bound to it (BE-SEC-09). */
  'cloud:installId': { request: void; response: { installId: string } }
  'cloud:syncStatus': { request: void; response: SyncStatus }
  'cloud:syncPush': { request: SyncUi & { force?: boolean }; response: SyncStatus }
  'cloud:syncPull': { request: void; response: SyncUi }

  'update:status': { request: void; response: UpdateStatus }
  'update:check': { request: void; response: UpdateStatus }
  'update:install': { request: void; response: void }

  /** The desktop app: logs, diagnostics, what closing the window does, the keychain. */
  'desktop:status': { request: void; response: DesktopStatus }
  'desktop:configure': { request: { closeBehavior: CloseBehavior }; response: DesktopStatus }
  'desktop:openLogs': { request: void; response: void }
  /** Version, OS and the latest errors as text for a bug report — no secrets or tokens. */
  'desktop:diagnostics': { request: void; response: string }
  /** The renderer reports an error it caught (an error boundary, an uncaught error) for the log. */
  'desktop:reportError': { request: RendererError; response: void }

  /** The browser's everyday extras: Chrome extensions, a page's login, a malware warning passed, DRM, downloads. */
  'browser:extensions': { request: void; response: BrowserExtension[] }
  /** Install from the Web Store, a folder (no path: ask for one; null when the user cancels) or another browser's profile. */
  'browser:extensions:install': { request: ExtensionInstall; response: BrowserExtension | null }
  /** Chrome, Brave, Edge … profiles on this computer and their extensions. */
  'browser:extensions:profiles': { request: void; response: ChromiumProfile[] }
  'browser:extensions:update': { request: { id: string; enabled: boolean }; response: BrowserExtension }
  'browser:extensions:remove': { request: { id: string }; response: void }
  'browser:extensions:checkUpdates': { request: void; response: ExtensionUpdateReport }
  /** The extension's toolbar popup, under its icon (`anchor`: the icon's place in the window). */
  'browser:extensions:popup': { request: { id: string; anchor: ViewBounds }; response: void }
  /** Answer a page's login (HTTP authentication); no user name cancels. */
  'browser:auth': { request: { id: string; username?: string; password?: string }; response: void }
  /** Open a page Mindeck stopped as dangerous anyway. */
  'browser:proceed': { request: { id: string }; response: void }
  /** Hide the "needs DRM" bar of a tab. */
  'browser:dismissDrm': { request: { id: string }; response: void }
  /** Choose the downloads folder (the native picker); null when the user cancels. */
  'browser:pickDownloadDir': { request: void; response: BrowserSettings | null }

  /** The Mindeck browser: tabs are web views in the desktop window (architecture §12.9). */
  'browser:state': { request: void; response: BrowserState }
  /** A new tab: `url` is what was typed (an address or search words); empty = the new-tab page. */
  /** `private`: a private tab (nothing kept). */
  'browser:open': { request: { url?: string; background?: boolean; private?: boolean }; response: BrowserTab }
  'browser:close': { request: { id: string }; response: void }
  'browser:activate': { request: { id: string }; response: void }
  /** Load what was typed into the address bar (an address, or search words). */
  'browser:navigate': { request: { id: string; input: string }; response: void }
  'browser:go': { request: { id: string; action: BrowserGo }; response: void }
  'browser:update': { request: { id: string; pinned?: boolean; muted?: boolean; shared?: boolean }; response: void }
  /** Reorder a tab; `groupId` puts it into that group (null: out of any group, absent: as it is). */
  'browser:move': { request: { id: string; index: number; groupId?: string | null }; response: void }
  'browser:duplicate': { request: { id: string }; response: BrowserTab }
  /** Bring back the most recently closed tab. */
  'browser:reopen': { request: void; response: BrowserTab | null }
  'browser:zoom': { request: { id: string; zoom: 'in' | 'out' | 'reset' }; response: number }
  'browser:find': { request: { id: string; text: string; forward?: boolean; next?: boolean }; response: void }
  'browser:findStop': { request: { id: string }; response: void }
  /** Native tab / page menu, DevTools, print, or hand the page to the system browser. */
  'browser:tool': { request: { id: string; tool: BrowserTool }; response: void }
  /** Where the web view sits in the window; null hides it (the module is not on screen). */
  'browser:view': { request: { bounds: ViewBounds | null; focused?: boolean; panes?: BrowserPane[] }; response: void }
  /** A picture of the visible page while a menu or dialog covers it (the view itself hides); null if none. */
  'browser:freeze': { request: void; response: Record<string, string> | null }
  'browser:unfreeze': { request: void; response: void }
  'browser:suggest': { request: { text: string }; response: BrowserSuggestion[] }
  'browser:history': { request: { query?: string; limit?: number }; response: HistoryEntry[] }
  'browser:clearHistory': { request: void; response: void }
  'browser:download': { request: { id: string; action: 'open' | 'reveal' | 'cancel' | 'remove' }; response: void }
  /** Answer a page's request (camera, notifications, …); `remember` keeps it for the site. */
  'browser:permission': { request: { id: string; allow: boolean; remember?: boolean }; response: void }
  'browser:settings': { request: void; response: BrowserSettings }
  'browser:configure': { request: Partial<BrowserSettings>; response: BrowserSettings }
  /** The UI's look and language: pages follow its light/dark mode, menus speak its language. */
  'browser:ui': { request: { theme: 'dark' | 'light' | 'system'; locale: 'de' | 'en' }; response: void }
  /** What the search engine suggests for the words typed (empty when the user turned it off). */
  'browser:searchSuggest': { request: { text: string }; response: BrowserSuggestion[] }
  /** The history page: newest first, visited before `before` (ms since 1970), matching `query`. */
  'browser:historyList': { request: { query?: string; before?: number; limit?: number }; response: HistoryEntry[] }
  /** Forget pages by address, or every page visited in [from, to) (ms); how many went. */
  'browser:historyDelete': { request: { urls?: string[]; from?: number; to?: number }; response: number }
  /** The bookmarks: the bar's folder, then Other bookmarks. */
  'browser:bookmarks': { request: void; response: BookmarkFolder[] }
  /** A bookmark (with `url`) or a folder (without), into `parentId` (default: the bar) at `index`. */
  'browser:bookmarkAdd': { request: { parentId?: string; index?: number; title: string; url?: string }; response: BookmarkNode }
  'browser:bookmarkUpdate': { request: { id: string; title?: string; url?: string }; response: void }
  'browser:bookmarkMove': { request: { id: string; parentId: string; index: number }; response: void }
  'browser:bookmarkRemove': { request: { ids: string[] }; response: number }
  /** All bookmarks as a Netscape bookmark file (HTML). */
  'browser:bookmarksExport': { request: void; response: string }
  /** Bookmarks from a Netscape bookmark file; how many were new. */
  'browser:bookmarksImport': { request: { html: string }; response: number }
  /** Other browsers' profiles on this machine to import from. */
  'browser:importSources': { request: void; response: ImportSource[] }
  /** Take bookmarks, history and the search engine over from one of them (progress: the `browser:import` event). */
  'browser:import': { request: ImportRequest; response: ImportResult }
  /** After a crash: bring the last session's tabs back, or let them go. */
  'browser:restoreSession': { request: { restore: boolean }; response: void }
  /** Tab groups: make one of these tabs, rename/recolor/fold it, dissolve it, close all its tabs. */
  'browser:group': { request: { ids: string[]; title?: string; color?: TabGroupColor }; response: BrowserTabGroup }
  'browser:groupUpdate': { request: { id: string; title?: string; color?: TabGroupColor; collapsed?: boolean }; response: void }
  'browser:ungroup': { request: { id: string }; response: void }
  'browser:groupClose': { request: { id: string }; response: void }
  /** Split view: `id` on the left (top), `with` beside it — a new tab when absent. */
  'browser:split': { request: { id: string; with?: string; vertical?: boolean }; response: BrowserSplit }
  'browser:splitUpdate': { request: { id: string; ratio?: number; vertical?: boolean; swap?: boolean }; response: void }
  'browser:unsplit': { request: { id: string }; response: void }

  /** Files: the machine's files, like Finder (absolute paths; writes only under Home and /Volumes). */
  'finder:places': { request: void; response: FinderPlaces }
  /** A page of a folder's entries from `offset`; no `path` = Home. */
  'finder:list': { request: { path?: string; hidden?: boolean; offset?: number }; response: FinderListing }
  'finder:search': { request: { path: string; query: string }; response: FinderEntry[] }
  'finder:preview': { request: { path: string }; response: FinderPreview }
  /** Returns the new folder's path. */
  'finder:mkdir': { request: { parent: string; name: string }; response: string }
  /** Returns the new path. */
  'finder:rename': { request: { path: string; name: string }; response: string }
  /** Into the trash, never deleted outright; `restore` set where Mindeck can undo it. */
  'finder:trash': { request: { paths: string[] }; response: TrashedItem[] }
  /** Undo a trash (only items with `restore`): what came back where, and what had left the trash. */
  'finder:untrash': { request: { items: { path: string; restore: string }[] }; response: UntrashResult }
  /** macOS: opens System Settings at Full Disk Access (needed to take things out of the Trash). */
  'finder:privacySettings': { request: void; response: void }
  /** Returns the new paths. */
  'finder:move': { request: { paths: string[]; dest: string }; response: string[] }
  'finder:copy': { request: { paths: string[]; dest: string }; response: string[] }
  /** Names already taken in `dest` — the conflict dialog's questions. */
  'finder:conflicts': { request: { paths: string[]; dest: string }; response: string[] }
  /** Copy or move with conflict choices; progress via `finder:progress`. */
  'finder:transfer': { request: TransferRequest; response: TransferResult }
  /** Stop a running transfer, archive or size count. */
  'finder:cancel': { request: { id: string }; response: void }
  /** Undo for rename/move: each `from` back to exactly `to`. */
  'finder:restore': { request: { moves: { from: string; to: string }[] }; response: void }
  'finder:info': { request: { path: string }; response: FinderInfo }
  'finder:folderSize': { request: { path: string; id: string }; response: FolderSize }
  /** Returns the new archive's path. */
  'finder:compress': { request: { paths: string[]; id: string }; response: string }
  /** Returns what was extracted. */
  'finder:extract': { request: { path: string; id: string }; response: string }
  /** Files onto the system clipboard (Finder / Explorer can paste them). */
  'finder:clipboardWrite': { request: { paths: string[]; cut: boolean }; response: void }
  /** Files copied in Finder / Explorer. */
  'finder:clipboardRead': { request: void; response: string[] }
  /** With the app the OS opens it with. */
  'finder:open': { request: { path: string }; response: void }
  /** Show it in the OS file manager. */
  'finder:reveal': { request: { path: string }; response: void }
}

export type IpcChannel = keyof IpcChannels

/**
 * Who may call a channel:
 * - `any`      — every transport (desktop IPC and paired remote clients)
 * - `desktop`  — only the desktop app's own window: native dialogs, opening
 *                things on the host, and the server's own configuration
 * - `terminal` — desktop, or remote clients when remote shells are enabled
 *                (shells, and writing project files — both can run code)
 * - `admin`    — desktop, or paired devices with the admin role: other
 *                devices, the AI key, the Mindeck account, global settings
 * - `trusted`  — desktop, admin devices, or any device while remote shells
 *                are enabled: data beyond the shared folders (databases)
 *
 * Paired devices also only reach shared folders, and approve changes and
 * commands only with remote shells (see RemoteAccess and PermissionService).
 */
export type ChannelAccess = 'any' | 'desktop' | 'terminal' | 'admin' | 'trusted'

/** Every channel classified exactly once — a new channel without one is a type error. */
export const CHANNEL_ACCESS: Record<IpcChannel, ChannelAccess> = {
  'projects:list': 'any',
  'projects:pickFolder': 'desktop',
  'projects:add': 'any',
  'projects:remove': 'any',
  'projects:refresh': 'any',
  'projects:pull': 'terminal',
  'projects:openInEditor': 'desktop',
  'projects:githubDesktop': 'desktop',
  'projects:openInGitHubDesktop': 'desktop',
  'projects:openFile': 'desktop',
  // Trusting lets the project's own code run (tsserver, ESLint, git config): never a member device.
  'projects:trust': 'admin',
  'system:subscribe': 'any',
  'system:unsubscribe': 'any',
  'system:snapshot': 'any',
  'system:user': 'any',
  'context:get': 'any',
  'context:reindex': 'any',
  'memory:status': 'any',
  'memory:createVault': 'any',
  'memory:pickVault': 'desktop',
  'memory:list': 'any',
  'memory:read': 'any',
  'memory:write': 'any',
  'memory:create': 'any',
  'memory:trash': 'any',
  'memory:graph': 'any',
  'memory:search': 'any',
  'memory:setGraphStyle': 'any',
  'memory:reveal': 'desktop',
  'memory:folders': 'any',
  'memory:writeBody': 'any',
  'memory:createFolder': 'any',
  'memory:rename': 'any',
  'memory:move': 'any',
  'memory:moveFolder': 'any',
  'memory:link': 'any',
  'memory:unlink': 'any',
  'memory:daily': 'any',
  // Settings of the desktop user's vault (and the vault itself, below): an admin's to change.
  'memory:setDailyNotes': 'admin',
  'memory:renderTemplate': 'any',
  'memory:attach': 'any',
  'memory:attachment': 'any',
  'memory:setVault': 'admin',
  'terminal:create': 'terminal',
  'terminal:list': 'terminal',
  'terminal:attach': 'terminal',
  'terminal:write': 'terminal',
  'terminal:resize': 'terminal',
  'terminal:kill': 'terminal',
  'terminal:shells': 'terminal',
  'terminal:settings': 'terminal',
  // Profiles name programs to run: only the desktop sets them up.
  'terminal:configure': 'desktop',
  'terminal:persist': 'desktop',
  'terminal:restore': 'desktop',
  'files:list': 'any',
  'files:read': 'any',
  'files:stat': 'any',
  'files:write': 'terminal',
  'files:create': 'terminal',
  'files:rename': 'terminal',
  'files:delete': 'terminal',
  'scm:status': 'any',
  'scm:init': 'terminal',
  'scm:stage': 'terminal',
  'scm:unstage': 'terminal',
  'scm:discard': 'terminal',
  'scm:commit': 'terminal',
  'scm:fetch': 'terminal',
  'scm:pull': 'terminal',
  'scm:push': 'terminal',
  'scm:branches': 'any',
  'scm:checkout': 'terminal',
  'scm:createBranch': 'terminal',
  'scm:log': 'any',
  'scm:show': 'any',
  'scm:diff': 'any',
  'scm:original': 'any',
  'scm:files': 'any',
  'scm:abort': 'terminal',
  'scm:continue': 'terminal',
  'scm:stashes': 'any',
  'scm:stash': 'terminal',
  'scm:applyStash': 'terminal',
  'scm:dropStash': 'terminal',
  'scm:stashFiles': 'any',
  'scm:blame': 'any',
  // Reading project files, like files:read.
  'search:start': 'any',
  'search:cancel': 'any',
  // Starting tsserver runs the project's own TypeScript (and its tsconfig plugins): a shell's power.
  'lsp:open': 'terminal',
  'lsp:change': 'terminal',
  'lsp:close': 'terminal',
  'lsp:diagnostics': 'terminal',
  'lsp:hover': 'terminal',
  'lsp:completions': 'terminal',
  'lsp:completionDetails': 'terminal',
  'lsp:definition': 'terminal',
  'lsp:references': 'terminal',
  'lsp:rename': 'terminal',
  'lsp:signature': 'terminal',
  'lsp:codeFixes': 'terminal',
  'lsp:symbols': 'terminal',
  // Debugging runs the project's code.
  'debug:start': 'terminal',
  'debug:stop': 'terminal',
  'debug:session': 'terminal',
  'debug:control': 'terminal',
  'debug:setBreakpoints': 'terminal',
  'debug:variables': 'terminal',
  'debug:evaluate': 'terminal',
  'tools:status': 'any',
  // Installing runs package managers on the core's machine.
  'tools:install': 'terminal',
  'tools:runtimes': 'any',
  // Reads the desktop user's own VS Code folders.
  'migrate:scan': 'desktop',
  'migrate:apply': 'desktop',
  'editor:settings': 'any',
  'editor:update': 'terminal',
  'lint:file': 'terminal',
  'lint:fix': 'terminal',
  'lint:restart': 'terminal',
  'format:document': 'terminal',
  'tests:discover': 'any',
  'tests:state': 'any',
  'tests:run': 'terminal',
  'tests:cancel': 'terminal',
  'tests:debug': 'terminal',
  'notebook:kernels': 'terminal',
  'notebook:setup': 'terminal',
  'notebook:start': 'terminal',
  'notebook:execute': 'terminal',
  'notebook:interrupt': 'terminal',
  'notebook:restart': 'terminal',
  'notebook:shutdown': 'terminal',
  'liveServer:status': 'any',
  // Serving and compiling write / expose project files on the core's machine.
  'liveServer:start': 'terminal',
  'liveServer:stop': 'terminal',
  'sass:compile': 'terminal',
  'sass:compileAll': 'terminal',
  'sftp:targets': 'any',
  // Talking to servers with the project's credentials, writing files: a shell's power.
  'sftp:list': 'terminal',
  'sftp:upload': 'terminal',
  'sftp:download': 'terminal',
  'sftp:sync': 'terminal',
  // Reading pull requests is harmless; acting on them (checkout changes files, the rest writes to GitHub) needs remote shells.
  'github:status': 'any',
  'github:list': 'any',
  'github:view': 'any',
  'github:fileDiff': 'any',
  'github:checkout': 'terminal',
  'github:create': 'terminal',
  'github:merge': 'terminal',
  'github:comment': 'terminal',
  'github:review': 'terminal',
  // Databases are not in the shared folders: reading them is for admins (or with remote shells); changing them needs remote shells.
  'mongo:connections': 'trusted',
  'mongo:databases': 'trusted',
  'mongo:collections': 'trusted',
  'mongo:find': 'trusted',
  'mongo:indexes': 'trusted',
  'mongo:add': 'terminal',
  'mongo:remove': 'terminal',
  'mongo:createCollection': 'terminal',
  'mongo:dropCollection': 'terminal',
  'mongo:insert': 'terminal',
  'mongo:replace': 'terminal',
  'mongo:delete': 'terminal',
  'mongo:aggregate': 'terminal',
  // Opening windows and ssh / docker on this machine: the desktop app only.
  'remote:hosts': 'desktop',
  'remote:list': 'desktop',
  'remote:ssh': 'desktop',
  'remote:container': 'desktop',
  'remote:hasContainer': 'desktop',
  'remote:disconnect': 'desktop',
  'app:info': 'any',
  'fs:dirs': 'any',
  'server:status': 'any',
  'server:configure': 'desktop',
  // Pairing more devices and changing roles keeps a device in: admins only.
  'server:createPairingCode': 'admin',
  'server:devices': 'any',
  'server:revokeDevice': 'any',
  'server:setDeviceRole': 'admin',
  'ai:status': 'any',
  'ai:setKey': 'admin',
  'ai:clearKey': 'admin',
  // Model, cloud model and effort hold for everyone (and cost the user): an admin's to change.
  'ai:configure': 'admin',
  'ai:agents': 'any',
  'ai:tools': 'any',
  'ai:conversations': 'any',
  'ai:conversation': 'any',
  'ai:send': 'any',
  'ai:cancel': 'any',
  'ai:deleteConversation': 'any',
  'ai:runs': 'any',
  // Inline AI is for editing files (a shell's power remotely) — and spends the user's AI credit.
  'ai:inlineComplete': 'terminal',
  'ai:inlineEdit': 'terminal',
  'ai:inlineCancel': 'any',
  'permission:pending': 'any',
  'permission:respond': 'any',
  'permission:grants': 'any',
  'permission:revoke': 'admin',
  'events:recent': 'any',
  // Agents run programs on this machine: starting or driving them is a shell's power.
  'agents:detect': 'any',
  'agents:list': 'any',
  'agents:get': 'any',
  'agents:create': 'terminal',
  'agents:send': 'terminal',
  'agents:configure': 'terminal',
  'agents:pushSettings': 'any',
  // The owner's pushes: an admin's to switch off.
  'agents:setPushSettings': 'admin',
  'agents:interrupt': 'terminal',
  'agents:stop': 'terminal',
  'agents:resume': 'terminal',
  'agents:remove': 'terminal',
  'agents:changes': 'any',
  'agents:branch': 'any',
  'agents:diff': 'any',
  'agents:accept': 'terminal',
  'agents:discard': 'terminal',
  'agents:rename': 'terminal',
  'agents:shell': 'terminal',
  'agents:openInEditor': 'desktop',
  // The Mindeck account: a headless core is signed in from its web UI (its first device is admin).
  'cloud:status': 'any',
  'cloud:login': 'admin',
  'cloud:register': 'admin',
  'cloud:logout': 'admin',
  'cloud:refresh': 'any',
  'cloud:resendVerification': 'any',
  // A reset mail to any address: not something every device may send.
  'cloud:forgotPassword': 'admin',
  'cloud:checkout': 'any',
  'cloud:adopt': 'admin',
  'cloud:installId': 'admin',
  'cloud:syncStatus': 'any',
  // Overwriting the account's settings copy (or this core's settings from it): admins only.
  'cloud:syncPush': 'admin',
  'cloud:syncPull': 'admin',
  // The desktop app updates itself; nothing a remote client should trigger.
  'update:status': 'desktop',
  'update:check': 'desktop',
  'update:install': 'desktop',
  // The desktop app around the core: its own window, logs and keychain.
  'desktop:status': 'desktop',
  'desktop:configure': 'desktop',
  'desktop:openLogs': 'desktop',
  'desktop:diagnostics': 'desktop',
  'desktop:reportError': 'desktop',
  'browser:extensions': 'desktop',
  'browser:extensions:install': 'desktop',
  'browser:extensions:profiles': 'desktop',
  'browser:extensions:update': 'desktop',
  'browser:extensions:remove': 'desktop',
  'browser:extensions:checkUpdates': 'desktop',
  'browser:extensions:popup': 'desktop',
  'browser:auth': 'desktop',
  'browser:proceed': 'desktop',
  'browser:dismissDrm': 'desktop',
  'browser:pickDownloadDir': 'desktop',
  // The browser lives in the desktop window — and its tabs are the user's private pages.
  'browser:state': 'desktop',
  'browser:open': 'desktop',
  'browser:close': 'desktop',
  'browser:activate': 'desktop',
  'browser:navigate': 'desktop',
  'browser:go': 'desktop',
  'browser:update': 'desktop',
  'browser:move': 'desktop',
  'browser:duplicate': 'desktop',
  'browser:reopen': 'desktop',
  'browser:zoom': 'desktop',
  'browser:find': 'desktop',
  'browser:findStop': 'desktop',
  'browser:tool': 'desktop',
  'browser:view': 'desktop',
  'browser:freeze': 'desktop',
  'browser:unfreeze': 'desktop',
  'browser:suggest': 'desktop',
  'browser:history': 'desktop',
  'browser:clearHistory': 'desktop',
  'browser:download': 'desktop',
  'browser:permission': 'desktop',
  'browser:settings': 'desktop',
  'browser:configure': 'desktop',
  'browser:ui': 'desktop',
  'browser:searchSuggest': 'desktop',
  'browser:historyList': 'desktop',
  'browser:historyDelete': 'desktop',
  'browser:bookmarks': 'desktop',
  'browser:bookmarkAdd': 'desktop',
  'browser:bookmarkUpdate': 'desktop',
  'browser:bookmarkMove': 'desktop',
  'browser:bookmarkRemove': 'desktop',
  'browser:bookmarksExport': 'desktop',
  'browser:bookmarksImport': 'desktop',
  'browser:importSources': 'desktop',
  'browser:import': 'desktop',
  'browser:restoreSession': 'desktop',
  'browser:group': 'desktop',
  'browser:groupUpdate': 'desktop',
  'browser:ungroup': 'desktop',
  'browser:groupClose': 'desktop',
  'browser:split': 'desktop',
  'browser:splitUpdate': 'desktop',
  'browser:unsplit': 'desktop',
  // The whole disk, beyond projects and the vault: the desktop app only.
  'finder:places': 'desktop',
  'finder:list': 'desktop',
  'finder:search': 'desktop',
  'finder:preview': 'desktop',
  'finder:mkdir': 'desktop',
  'finder:rename': 'desktop',
  'finder:trash': 'desktop',
  'finder:move': 'desktop',
  'finder:copy': 'desktop',
  'finder:untrash': 'desktop',
  'finder:privacySettings': 'desktop',
  'finder:conflicts': 'desktop',
  'finder:transfer': 'desktop',
  'finder:cancel': 'desktop',
  'finder:restore': 'desktop',
  'finder:info': 'desktop',
  'finder:folderSize': 'desktop',
  'finder:compress': 'desktop',
  'finder:extract': 'desktop',
  'finder:clipboardWrite': 'desktop',
  'finder:clipboardRead': 'desktop',
  'finder:open': 'desktop',
  'finder:reveal': 'desktop'
}

/** Runtime allowlist — the preload rejects any channel not in this set. */
export const IPC_CHANNELS = Object.keys(CHANNEL_ACCESS) as readonly IpcChannel[]

/** Main→renderer push events (channel → payload). */
export interface IpcEvents {
  'system:tick': SystemSnapshot
  'context:progress': ContextProgress
  'memory:changed': MemoryChanged
  'terminal:data': TerminalData
  'terminal:exit': TerminalExit
  /** A session's folder changed (the shell reported it): new folder, label and title. */
  'terminal:info': TerminalInfo
  /** An agent started a command in a terminal: show that terminal (and the Terminal module). */
  'terminal:reveal': TerminalReveal
  'ai:delta': AiDelta
  'ai:inlineDelta': InlineDelta
  'ai:message': AiMessageUpdate
  'ai:conversationsChanged': { reason: 'created' | 'updated' | 'deleted'; id: string }
  'permission:request': PermissionRequest
  'permission:resolved': { id: string; decision: ApprovalDecision }
  'events:event': MindeckEvent
  'agents:changed': { session?: AgentSession; removed?: string }
  'agents:message': AgentMessageUpdate
  'cloud:status': CloudStatus
  'update:status': UpdateStatus
  'debug:session': DebugSession
  'debug:output': DebugOutput
  /** A language server published new diagnostics — the editor asks for them again. */
  'lsp:diagnostics': { projectId: string }
  'tools:progress': ToolProgress
  'liveServer:changed': LiveServerStatus[]
  'sftp:progress': SftpProgress
  'remote:changed': RemoteConnection[]
  'tests:changed': TestRunState
  /** Results of a project-wide search, in batches. */
  'search:progress': SearchProgress
  'notebook:event': NotebookEvent
  'browser:state': BrowserState
  'browser:find': BrowserFind
  /** A shortcut or menu (maybe pressed while a page had the focus) for the Mindeck UI. */
  'browser:command': { command: BrowserCommand; key?: WorkspaceKey; id?: string }
  /** Something opened a tab for the user (a link in a chat, the Live Server): show the browser. */
  'browser:reveal': { tabId: string }
  /** The bookmarks changed (the whole tree). */
  'browser:bookmarks': BookmarkFolder[]
  /** An import moved on to the next kind of data. */
  'browser:import': ImportProgress
  /** A copy, archive or size count moving on. */
  'finder:progress': FinderProgress
}

export type IpcEvent = keyof IpcEvents

/** Runtime allowlist for event channels the preload may forward. */
export const IPC_EVENTS: readonly IpcEvent[] = [
  'system:tick',
  'context:progress',
  'memory:changed',
  'terminal:data',
  'terminal:exit',
  'terminal:info',
  'terminal:reveal',
  'ai:delta',
  'ai:inlineDelta',
  'ai:message',
  'ai:conversationsChanged',
  'permission:request',
  'permission:resolved',
  'events:event',
  'agents:changed',
  'agents:message',
  'cloud:status',
  'update:status',
  'debug:session',
  'debug:output',
  'lsp:diagnostics',
  'tools:progress',
  'liveServer:changed',
  'sftp:progress',
  'remote:changed',
  'tests:changed',
  'search:progress',
  'notebook:event',
  'browser:state',
  'browser:find',
  'browser:command',
  'browser:reveal',
  'browser:bookmarks',
  'browser:import',
  'finder:progress'
]

/** Push events remote clients only receive when remote shells are enabled. */
export const TERMINAL_EVENTS: readonly IpcEvent[] = ['terminal:data', 'terminal:exit', 'terminal:info', 'terminal:reveal', 'debug:session', 'debug:output', 'notebook:event']

/** Push events that never leave the desktop window (the browser's tabs are private pages; Remote-SSH windows are the desktop's own). */
export const DESKTOP_EVENTS: readonly IpcEvent[] = ['browser:state', 'browser:find', 'browser:command', 'browser:reveal', 'browser:bookmarks', 'browser:import', 'finder:progress', 'remote:changed']
