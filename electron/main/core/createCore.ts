import { mkdir } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { AppInfo, CoreMode, ServerConfig } from '@shared/types/server'
import type { TerminalData, TerminalExit } from '@shared/types/terminal'
import type { MindeckPaths } from '../lib/paths'
import type { Platform } from '../platform/types'
import { openInVsCode } from '../lib/openInVsCode'
import { Router } from '../../ipc/router'
import { registerProjectIpc } from '../../ipc/projects.ipc'
import { registerSystemIpc } from '../../ipc/system.ipc'
import { registerContextIpc } from '../../ipc/context.ipc'
import { registerMemoryIpc } from '../../ipc/memory.ipc'
import { registerTerminalIpc } from '../../ipc/terminal.ipc'
import { registerFilesIpc } from '../../ipc/files.ipc'
import { registerScmIpc } from '../../ipc/scm.ipc'
import { registerSearchIpc } from '../../ipc/search.ipc'
import { registerLspIpc } from '../../ipc/lsp.ipc'
import { registerDebugIpc } from '../../ipc/debug.ipc'
import { registerToolsIpc } from '../../ipc/tools.ipc'
import { registerMigrateIpc } from '../../ipc/migrate.ipc'
import { registerLiveIpc } from '../../ipc/live.ipc'
import { registerSftpIpc } from '../../ipc/sftp.ipc'
import { SftpService } from '../services/sftp/SftpService'
import { registerGitHubIpc } from '../../ipc/github.ipc'
import { GitHubService, loginShellGh } from '../services/github/GitHubService'
import { registerMongoIpc } from '../../ipc/mongo.ipc'
import { MongoService } from '../services/mongo/MongoService'
import { SyncService } from '../services/cloud/SyncService'
import { registerRemoteIpc } from '../../ipc/remote.ipc'
import { RemoteService } from '../services/remote/RemoteService'
import { bakedBundleHashes, bundleSource } from '../services/remote/bundle'
import { registerLintIpc } from '../../ipc/lint.ipc'
import { bundledPrettier, LintService } from '../services/lint/LintService'
import { registerNotebookIpc } from '../../ipc/notebook.ipc'
import { NotebookService } from '../services/notebook/NotebookService'
import { registerTestsIpc } from '../../ipc/tests.ipc'
import { TestService } from '../services/tests/TestService'
import { LiveServerService } from '../services/live/LiveServerService'
import { SassService } from '../services/live/SassService'
import { registerAgentsIpc } from '../../ipc/agents.ipc'
import { registerBrowserIpc } from '../../ipc/browser.ipc'
import { registerFinderIpc } from '../../ipc/finder.ipc'
import { BrowserService } from '../services/browser/BrowserService'
import { FinderService, spotlightFor } from '../services/finder/FinderService'
import { BROWSER_TOOLS, browserTools } from '../services/ai/tools/browser'
import { TERMINAL_TOOLS, terminalTools } from '../services/ai/tools/terminal'
import { EventHub } from './EventHub'
import { ProjectRegistry } from '../services/projects/registry'
import { ProjectService } from '../services/projects/ProjectService'
import { WorkspaceTrust } from '../services/projects/trust'
import { SystemService } from '../services/system/SystemService'
import { ContextStore } from '../services/context/contextStore'
import { ContextService } from '../services/context/ContextService'
import { VaultService } from '../services/memory/VaultService'
import { TerminalService } from '../services/terminal/TerminalService'
import { SettingsService } from '../services/settings/SettingsService'
import { FsService } from '../services/fs/FsService'
import { FilesService } from '../services/files/FilesService'
import { ScmService } from '../services/scm/ScmService'
import { SearchService } from '../services/search/SearchService'
import { LspService } from '../services/lsp/LspService'
import { DebugService } from '../services/debug/DebugService'
import { ToolsService } from '../services/tools/ToolsService'
import { MigrateService, appDataDir } from '../services/migrate/MigrateService'
import { AuthService } from '../services/auth/AuthService'
import { EventBus } from '../services/events/EventBus'
import { EventLog } from '../services/events/EventLog'
import { ServerController } from '../server/ServerController'
import { Certificates } from '../server/Certificates'
import { RemoteAccess } from '../server/RemoteAccess'
import { RemoteScope } from '../server/RemoteScope'
import { RemoteActivity } from '../server/RemoteActivity'
import { SecretStore, type Cipher } from '../services/ai/SecretStore'
import { AiService, type ProviderFactory } from '../services/ai/AiService'
import { InlineService } from '../services/ai/InlineService'
import { ConversationStore } from '../services/ai/ConversationStore'
import { RunStore } from '../services/ai/RunStore'
import { PermissionService } from '../services/ai/PermissionService'
import { ContextBuilder } from '../services/ai/ContextBuilder'
import { AssistantService } from '../services/ai/AssistantService'
import { ToolRegistry } from '../services/ai/tools/registry'
import { builtinTools } from '../services/ai/tools/builtin'
import { GitService } from '../services/git/GitService'
import { LocalAgentServer } from '../services/agents/LocalAgentServer'
import { AgentSessionService } from '../services/agents/AgentSessionService'
import { createMcpHandler, MEMORY_TOOLS } from '../services/agents/mcp'
import { vaultJournal } from '../services/agents/journal'
import { acpSpawner } from '../services/agents/acp'
import { CloudService } from '../services/cloud/CloudService'
import { PushService } from '../services/cloud/PushService'
import { cloudConfig, type CloudConfig } from '../services/cloud/config'
import { isLicenseFree } from '@shared/types/cloud'

export interface CoreOptions {
  mode: CoreMode
  version: string
  paths: MindeckPaths
  platform: Platform
  /** Standalone server: fixed config from the environment. Desktop: from settings. */
  serverConfig?: ServerConfig
  /** Built web UI the network API serves at `/`. */
  webRoot?: string
  /** An own TLS certificate for the network API (PEM files) instead of the self-signed one. */
  tlsFiles?: { cert: string; key: string }
  /** Encrypts stored secrets (desktop: OS keychain via Electron safeStorage). */
  cipher?: Cipher
  /** Injected LLM provider factory (tests). */
  providerFactory?: ProviderFactory
  /** Tell the user an agent needs them (desktop: a notification while the window is in the background). */
  notify?: (title: string, body: string) => void
  /** Mindeck Cloud: address, entitlement key, whether a license is required. Default: dev settings. */
  cloud?: CloudConfig & { fetch?: typeof fetch }
  /** Someone looks at Mindeck (desktop: its window has focus) — then no push goes to the phone. */
  isFocused?: () => boolean
  /** Someone is at this machine (desktop: not idle). Remote clients count as use, too. */
  isUserActive?: () => boolean
}

export interface Core {
  router: Router
  hub: EventHub
  events: EventBus
  settings: SettingsService
  system: SystemService
  terminal: TerminalService
  vault: VaultService
  server: ServerController
  auth: AuthService
  assistant: AssistantService
  agents: AgentSessionService
  cloud: CloudService
  /** The browser's core; the desktop app attaches its web views (`browser.attach`). */
  browser: BrowserService
  info(): AppInfo
  dispose(): Promise<void>
}

/**
 * Builds the Mindeck core — every service, wired and registered on one Router —
 * independent of its host. The Electron app binds the Router to its window's
 * IPC; the standalone server (and the desktop's optional embedded server)
 * exposes the same Router over HTTP + WebSocket.
 */
export async function createCore(opts: CoreOptions): Promise<Core> {
  const { paths, platform } = opts
  // Only the user may look into Mindeck's data (transcripts, grants, tokens).
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })

  const settings = new SettingsService(paths.settingsFile)
  await settings.init()

  const hub = new EventHub()

  // Every MindeckEvent: kept in the EventLog (the newest in memory and in a file
  // in the data folder) and pushed live to every client for the activity timeline.
  const eventLog = new EventLog(paths.eventsFile)
  await eventLog.load()
  const events = new EventBus({ sink: eventLog, broadcast: (event) => hub.publish('events:event', event) })
  const runs = new RunStore(paths.runsFile)
  await runs.load()

  const projects = new ProjectService(new ProjectRegistry(paths.dataDir), platform)
  await projects.init()
  // Workspace trust (BE-SEC-01): a project's own tools run only once the user trusts it.
  const trust = new WorkspaceTrust(() => projects.list())

  const system = new SystemService((snapshot) => hub.publish('system:tick', snapshot))

  const context = new ContextService({
    store: new ContextStore(paths.dataDir),
    resolvePath: (id) => projects.getProjectPath(id),
    onProgress: (progress) => hub.publish('context:progress', progress)
  })

  // Memory = Obsidian-compatible markdown vault; created lazily, never at boot.
  const vault = new VaultService({
    settings,
    platform,
    defaultRoot: paths.defaultVaultRoot,
    onChange: (change) => hub.publish('memory:changed', change)
  })

  // The browser (§12.9): tabs, history and sessions here; the desktop app attaches the web views.
  const browser = new BrowserService({
    dir: join(paths.dataDir, 'browser'),
    settings,
    publish: (channel, payload) => hub.publish(channel, payload),
    openExternal: platform.openExternal,
    appForUrl: platform.appForUrl,
    openPath: platform.openPath,
    revealPath: platform.revealPath,
    pickFolder: platform.pickFolder,
    // The Chromium inside Electron (the Web Store serves extensions per Chrome version).
    chromeVersion: process.versions.chrome,
    // Other browsers' profiles are the desktop user's; a headless core has none to import.
    ...(platform.kind === 'desktop' ? { importEnv: { home: homedir(), platform: process.platform, env: process.env } } : {})
  })
  await browser.init()

  // Interactive shells for the user (phase PT) — not an agent tool (§8.1). Their
  // output also tells the browser which dev servers just started.
  const terminal: TerminalService = new TerminalService({
    emit: (channel, payload) => {
      hub.publish(channel, payload as never)
      if (channel === 'terminal:exit') return browser.devServers.exit((payload as TerminalExit).id)
      if (channel !== 'terminal:data') return
      const { id, data } = payload as TerminalData
      browser.devServers.feed({ id, projectId: terminal.info(id)?.projectId }, data)
    },
    resolveProject: (id) => projects.list().find((p) => p.id === id),
    settings,
    dir: paths.dataDir
  })

  const fs = new FsService()
  // The editor's project files — paths resolve against the project registry.
  // Deleted project files go to the OS trash (a headless core keeps its own in the data folder).
  const fileTrash = join(paths.dataDir, 'file-trash')
  const files = new FilesService(
    (id) => projects.getProjectPath(id),
    (abs) => platform.trashItem(abs, fileTrash)
  )
  const scm = new ScmService((id) => projects.getProjectPath(id), undefined, (root) => trust.folder(root))
  // Language servers and debuggers Mindeck installs live in its data folder.
  const devTools = new ToolsService({ dir: join(paths.dataDir, 'tools'), publish: hub.publish.bind(hub, 'tools:progress') })
  const lsp = new LspService({
    resolveRoot: (id) => projects.getProjectPath(id),
    trusted: (id) => trust.project(id),
    node: platform.node,
    servers: { tools: devTools, onDiagnostics: hub.publish.bind(hub, 'lsp:diagnostics') }
  })
  // Trusted (or restricted again): TypeScript switches to the project's own (or Mindeck's), other servers restart.
  projects.onTrustChange((p) => void lsp.retrust(p.id))
  const debug = new DebugService({
    resolveRoot: (id) => projects.getProjectPath(id),
    publish: (channel, payload) => hub.publish(channel, payload as never),
    tools: devTools,
    lsp,
    node: platform.node
  })
  // A headless core has no desktop to give roles: its first paired device is admin.
  const auth = new AuthService(paths.devicesFile, undefined, opts.mode === 'server')

  // The router asks the server controller whether remote shells are allowed,
  // the cloud whether Mindeck is licensed, and RemoteAccess what a device may
  // reach (only ever called per request, after all of them exist).
  // What paired devices may reach: the shared folders and the desktop's projects, never keys or system folders.
  const remoteAccess = new RemoteAccess({
    roots: () => controller.remoteRoots(),
    projects: () => projects.list(),
    remoteShell: () => controller.remoteTerminal(),
    dirs: (path) => fs.dirs(path),
    protectedDirs: [paths.dataDir]
  })
  // …and what they see of the core's activity: sessions, conversations, approvals and events of those projects only.
  const conversations = new ConversationStore(paths.dataDir)
  const browserTab = (id: string) => browser.state().tabs.find((t) => t.id === id)
  const webUrl = (input: string) => browser.webUrl(input)
  const remoteScope = new RemoteScope({
    access: remoteAccess,
    sessionProject: (id) => agents.projectOf(id),
    conversationProject: (id) => conversations.projectOf(id),
    pending: () => permissions.list(),
    browserTab,
    webUrl
  })
  // What devices do with the browser and the files: the audit log, and the desktop's sign that one uses the browser.
  const remoteActivity = new RemoteActivity({
    devices: () => auth.devices(),
    log: (type, deviceId, payload) => events.emit(type, { actor: { kind: 'device', id: deviceId }, payload }),
    inUse: (devices) => browser.setRemote(devices),
    browserTab,
    webUrl
  })

  const router = new Router({
    remoteTerminal: () => controller.remoteTerminal(),
    licensed: (channel) => isLicenseFree(channel) || cloud.allowed(),
    guard: (channel, payload) => remoteScope.guard(channel, payload),
    shape: (channel, data) => remoteScope.result(channel, data),
    observe: (channel, payload, data, ctx) => remoteActivity.observe(channel, payload, data, ctx)
  })

  const controller: ServerController = new ServerController({
    mode: opts.mode,
    version: opts.version,
    router,
    hub,
    auth,
    settings: opts.serverConfig ? undefined : settings,
    fixedConfig: opts.serverConfig,
    webRoot: opts.webRoot,
    certificates: new Certificates({ dir: paths.tlsDir, files: opts.tlsFiles }),
    onClients: (count) => {
      system.setRemoteClients(count)
      cloud.setRemoteClients(count)
    },
    scope: remoteScope.event.bind(remoteScope)
  })

  const info = (): AppInfo => ({
    mode: opts.mode,
    version: opts.version,
    platform: process.platform,
    hostname: hostname(),
    remoteTerminal: controller.remoteTerminal()
  })

  // The assistant: provider, context engine, tools behind the permission gate.
  // One store for every secret (LLM key, cloud session) — one writer per file.
  const secrets = new SecretStore(paths.secretsFile, opts.cipher)
  // Without a key of one's own, the assistant asks Mindeck Cloud (signed in, with the account's AI credit).
  const ai = new AiService({
    settings,
    secrets,
    factory: opts.providerFactory,
    cloud: { baseUrl: `${(opts.cloud ?? cloudConfig(false)).url}/ai`, token: () => cloud.sessionToken(), info: () => cloud.aiInfo() }
  })

  // The Mindeck account: sign-in, the trial clock and the license (Mindeck Cloud).
  const cloudCfg: CloudConfig & { fetch?: typeof fetch } = opts.cloud ?? cloudConfig(false)
  const cloud: CloudService = new CloudService({
    baseUrl: cloudCfg.url,
    publicKey: cloudCfg.publicKey,
    enforced: cloudCfg.enforced,
    follower: cloudCfg.follower,
    client: opts.mode,
    version: opts.version,
    deviceName: hostname(),
    platform: process.platform,
    file: paths.cloudFile,
    secrets,
    isUserActive: opts.isUserActive,
    onStatus: (status) => hub.publish('cloud:status', status),
    fetch: cloudCfg.fetch
  })
  await cloud.init()
  const permissions = new PermissionService({
    file: paths.grantsFile,
    events,
    onRequest: (req) => hub.publish('permission:request', req),
    onResolved: (res) => hub.publish('permission:resolved', res)
  })
  const tools = new ToolRegistry([...builtinTools({ vault, projects, context, system }), ...browserTools(browser), ...terminalTools({ terminal, projects })])
  const assistant = new AssistantService({
    ai,
    store: conversations,
    runs,
    tools,
    permissions,
    events,
    context: new ContextBuilder({
      user: () => system.user(),
      projects: () => projects.list(),
      projectContext: (id) => context.get(id),
      vaultStatus: () => vault.status(),
      search: (q) => vault.search(q)
    }),
    publish: (channel, payload) => hub.publish(channel, payload),
    remoteShell: () => controller.remoteTerminal(),
    remoteAccess
  })

  // The agent cockpit: the user's own coding agents (Claude Code), each in a
  // PTY, reporting back through hooks and reading Mindeck's memory over MCP —
  // both on a this-computer-only endpoint with a token per session.
  // Pushes to the phone (Mindeck Cloud) when an agent needs the user and Mindeck is in the background.
  const push = new PushService({
    baseUrl: cloudCfg.url,
    token: () => cloud.sessionToken(),
    settings,
    focused: opts.isFocused ?? (() => false),
    fetch: cloudCfg.fetch
  })
  const local: LocalAgentServer = new LocalAgentServer({
    hook: (id, body, signal) => agents.handleHook(id, body, signal),
    mcp: (id, body) => agents.handleMcp(id, body)
  })
  const agents: AgentSessionService = new AgentSessionService({
    dir: paths.agentsDir,
    // Pasted images in the data folder (0700), not in a /tmp other users share.
    tempDir: join(paths.agentsDir, 'images'),
    worktreesDir: paths.worktreesDir,
    terminal,
    git: new GitService({ trusted: (dir) => trust.folder(dir) }),
    server: local,
    permissions,
    events,
    projects: (id) => projects.list().find((p) => p.id === id),
    publish: (channel, payload) => hub.publish(channel, payload),
    // The browser lives in the desktop window, and so do the terminals an agent's commands show up in:
    // only a desktop core offers them to agents. Their write tools pass Mindeck's own approval, whatever the agent's settings.
    mcp: createMcpHandler(tools, opts.version, opts.mode === 'desktop' ? [...MEMORY_TOOLS, ...BROWSER_TOOLS, ...TERMINAL_TOOLS] : MEMORY_TOOLS, permissions),
    journal: vaultJournal(vault),
    notify: opts.notify,
    push: (notice) => push.send(notice),
    vaultRoot: async () => (await vault.status()).root,
    // npx in a folder of Mindeck's: never the adapter (or registry) a cloned repository brings.
    spawnAcp: acpSpawner(join(paths.agentsDir, 'npm')),
    claudeBin: process.env.MINDECK_CLAUDE_BIN || undefined,
    openFolder: (path) => openInVsCode(path, platform)
  })
  await Promise.all([agents.init(), local.start()])

  registerProjectIpc(router, projects, remoteAccess)
  registerSystemIpc(router, system)
  registerContextIpc(router, context)
  registerMemoryIpc(router, vault)
  registerTerminalIpc(router, terminal)
  registerFilesIpc(router, files)
  registerScmIpc(router, scm)
  const search = new SearchService({ resolveRoot: (id) => projects.getProjectPath(id), publish: hub.publish.bind(hub, 'search:progress') })
  registerSearchIpc(router, search, remoteAccess)
  registerLspIpc(router, lsp)
  registerDebugIpc(router, debug)
  registerToolsIpc(router, devTools)
  registerMigrateIpc(router, new MigrateService({ home: homedir(), appData: appDataDir(), settings, snippetsFile: join(paths.dataDir, 'snippets.json') }))
  const editorSettings = () => settings.get().editor
  const liveServer = new LiveServerService({
    resolveRoot: (id) => projects.getProjectPath(id),
    settings: () => editorSettings()?.liveServer,
    // Pages open in Mindeck's own browser (the system's when the user prefers it, or without a window).
    open: async (url) => {
      if (!browser.openFromApp(url)) await platform.openExternal?.(url)
    },
    publish: hub.publish.bind(hub, 'liveServer:changed')
  })
  registerSftpIpc(router, new SftpService({ resolveRoot: (id) => projects.getProjectPath(id), trusted: (id) => trust.project(id), publish: hub.publish.bind(hub, 'sftp:progress') }))
  registerGitHubIpc(router, new GitHubService({ resolveRoot: (id) => projects.getProjectPath(id), trusted: (dir) => trust.folder(dir), gh: loginShellGh }))
  const mongo = new MongoService({ secrets })
  registerMongoIpc(router, mongo)
  registerLiveIpc(router, liveServer, new SassService((id) => projects.getProjectPath(id), () => editorSettings()?.sass))
  registerAgentsIpc(router, agents, push)
  registerBrowserIpc(router, browser)
  registerFinderIpc(
    router,
    new FinderService({
      alsoWritable: [paths.homeDir],
      openPath: platform.openPath,
      revealPath: platform.revealPath,
      openExternal: platform.openExternal,
      trash: (path) => platform.trashItem(path, dirname(path)),
      restorableTrash: platform.restorableTrash,
      clipboard: platform.fileClipboard,
      spotlight: spotlightFor(process.platform),
      progress: hub.publish.bind(hub, 'finder:progress')
    })
  )
  router.register('app:info', () => info())
  router.register('fs:dirs', ({ path }, ctx) => (ctx.transport === 'remote' ? remoteAccess.dirs(path) : fs.dirs(path)))
  router.register('server:status', () => controller.status())
  router.register('server:configure', async ({ remoteRoots, ...patch }) =>
    controller.configure(remoteRoots ? { ...patch, remoteRoots: await remoteAccess.validateRoots(remoteRoots) } : patch)
  )
  router.register('server:createPairingCode', ({ role }) => controller.createPairingCode(role))
  router.register('server:devices', () => controller.devices())
  router.register('server:revokeDevice', ({ id }, ctx) => {
    // Unpairing itself is every device's right; removing others is an admin's.
    if (ctx.transport === 'remote' && ctx.role !== 'admin' && id !== ctx.deviceId) {
      throw Object.assign(new Error('Removing other devices needs the admin role'), { code: 'admin-only' })
    }
    remoteActivity.release(id)
    return controller.revoke(id)
  })
  router.register('server:setDeviceRole', ({ id, role }) => {
    if (role !== 'admin') remoteActivity.release(id)
    return controller.setDeviceRole(id, role)
  })
  router.register('server:setDeviceBrowser', ({ id, browser }) => {
    if (!browser) remoteActivity.release(id)
    return controller.setDeviceBrowser(id, browser)
  })
  router.register('ai:status', () => ai.status())
  router.register('ai:setKey', ({ key }) => ai.setKey(key))
  router.register('ai:clearKey', () => ai.clearKey())
  router.register('ai:configure', (patch) => ai.configure(patch))
  router.register('ai:agents', () => assistant.agents())
  router.register('ai:tools', () => tools.info())
  router.register('ai:conversations', () => assistant.conversations())
  router.register('ai:conversation', ({ id }) => assistant.conversation(id))
  router.register('ai:send', (req, ctx) => assistant.send(req, ctx))
  router.register('ai:cancel', ({ conversationId }) => assistant.cancel(conversationId))
  router.register('ai:deleteConversation', ({ id }) => assistant.remove(id))
  router.register('ai:runs', ({ limit }) => assistant.runs(limit))
  const inline = new InlineService({ ai, publish: hub.publish.bind(hub, 'ai:inlineDelta') })
  router.register('ai:inlineComplete', (req) => inline.complete(req))
  router.register('ai:inlineEdit', (req, ctx) => inline.edit(req, ctx))
  router.register('ai:inlineCancel', ({ requestId }) => inline.cancel(requestId))
  // "Always allow" is the desktop's to give: devices are not offered it.
  router.register('permission:pending', (_req, ctx) => permissions.list().map((r) => (ctx.transport === 'remote' ? { ...r, allowAlways: false } : r)))
  router.register('permission:respond', ({ id, decision }, ctx) =>
    permissions.respond(id, decision, ctx.transport === 'remote' ? { deviceId: ctx.deviceId, shells: controller.remoteTerminal() } : undefined)
  )
  router.register('permission:grants', () => permissions.grants())
  router.register('permission:revoke', ({ agentId, toolName, projectId }) => permissions.revoke(agentId, toolName, projectId))
  router.register('events:recent', (q) => eventLog.recent(q))
  router.register('cloud:status', () => cloud.status())
  router.register('cloud:login', (req) => cloud.login(req))
  router.register('cloud:register', (req) => cloud.register(req))
  router.register('cloud:logout', () => cloud.logout())
  router.register('cloud:refresh', () => cloud.refresh())
  router.register('cloud:resendVerification', () => cloud.resendVerification())
  router.register('cloud:forgotPassword', (req) => cloud.forgotPassword(req))
  router.register('cloud:checkout', () => cloud.checkout())
  router.register('cloud:adopt', ({ token, account, revokedKids }) => cloud.adopt(token, account, revokedKids))
  router.register('cloud:installId', () => ({ installId: cloud.installId() }))
  // Settings Sync: the account keeps one copy of the editor settings, snippets, look and language.
  const sync = new SyncService({ cloud, settings, snippetsFile: join(paths.dataDir, 'snippets.json') })
  router.register('cloud:syncStatus', () => sync.status())
  router.register('cloud:syncPush', ({ force, ...ui }) => sync.push(ui, force))
  router.register('cloud:syncPull', () => sync.pull())
  // Remote-SSH and Dev Containers: this core starts Mindeck elsewhere and opens a window on it.
  const remote = new RemoteService({
    version: opts.version,
    licensed: cloudCfg.enforced,
    deviceName: hostname(),
    bundle: bundleSource({ version: opts.version, dir: join(paths.dataDir, 'remote'), devDir: join(__dirname, '..', 'remote'), sha256: bakedBundleHashes() }),
    secrets,
    entitlement: cloud.entitlement.bind(cloud),
    followerLease: cloud.followerLease.bind(cloud),
    openWindow: opts.platform.openRemoteWindow,
    publish: (list) => {
      hub.publish('remote:changed', list)
      cloud.setRemoteSessions(list.filter((c) => c.state === 'ready').length)
    },
    sshConfig: process.env.MINDECK_SSH_CONFIG || undefined,
    node: platform.node
  })
  registerRemoteIpc(router, remote, (id) => projects.getProjectPath(id))
  // ESLint and Prettier: the project's own, in a worker per project.
  const lint = new LintService({ resolveRoot: (id) => projects.getProjectPath(id), trusted: (id) => trust.project(id), prettier: bundledPrettier(), node: platform.node })
  registerLintIpc(router, lint)
  // The test explorer: the project's runners, Mindeck's debugger.
  const notebooks = new NotebookService({ resolveRoot: (id) => projects.getProjectPath(id), trusted: (id) => trust.project(id), publish: hub.publish.bind(hub, 'notebook:event') })
  registerNotebookIpc(router, notebooks)
  registerTestsIpc(router, new TestService({ resolveRoot: (id) => projects.getProjectPath(id), publish: hub.publish.bind(hub, 'tests:changed'), debug: debug.start.bind(debug) }))

  events.emit('app.started', { payload: { version: opts.version, mode: opts.mode } })

  return {
    router,
    hub,
    events,
    settings,
    system,
    terminal,
    vault,
    server: controller,
    auth,
    assistant,
    agents,
    cloud,
    browser,
    info,
    async dispose() {
      cloud.dispose()
      await assistant.dispose()
      await agents.dispose()
      await local.close()
      system.dispose()
      vault.dispose()
      lsp.dispose()
      liveServer.dispose()
      debug.dispose()
      await mongo.dispose()
      remote.dispose()
      remoteActivity.dispose()
      lint.dispose()
      search.dispose()
      notebooks.dispose()
      terminal.killAll()
      await terminal.saved()
      await browser.dispose()
      await controller.stop()
      await eventLog.flush()
    }
  }
}
