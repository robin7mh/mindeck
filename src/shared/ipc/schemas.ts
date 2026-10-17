// Runtime validation for every request payload (MASTERPLAN §D: Zod at the
// boundary). The desktop IPC and the network API both validate here before a
// handler runs — over the network the payload is untrusted input.
// Pure module (no DOM/Node/Electron) so it compiles under every tsconfig.

import { z } from 'zod'
import { GRAPH_COLORS } from '@shared/types/memory'
import { EFFORTS } from '@shared/types/ai'
import { SEARCH_ENGINES, TAB_GROUP_COLORS, VERTICAL_TABS_WIDTH } from '@shared/types/browser'
import { DEVICE_ROLES } from '@shared/types/server'
import { CLOSE_BEHAVIORS } from '@shared/types/desktop'
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_REFS } from '@shared/types/composer'
import { TERMINAL_CURSORS, TERMINAL_LIMITS } from '@shared/types/terminal'
import { EXTENSION_SOURCES } from '@shared/types/browserExtensions'
import type { IpcChannel, IpcChannels } from './contract'

const id = z.string().min(1).max(200)
const path = z.string().min(1).max(4096)
const notePath = z.string().min(1).max(1024)
const title = z.string().max(500)
const text = (max: number) => z.string().max(max)
const prNumber = z.number().int().positive()
const mongoName = z.string().min(1).max(255)
const none = z.void()
const email = z.string().trim().min(3).max(254)
/** The UI's wall-clock time, "2026-10-15T09:30:00" (no zone — the date the user sees). */
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/)

const pos = z.object({ line: z.number().int().min(1), offset: z.number().int().min(1) })
const at = z.object({ projectId: id, path, line: z.number().int().min(1), offset: z.number().int().min(1) })

const breakpoint = z.object({ path, line: z.number().int().min(1) })

/** CSS pixels of the Mindeck window (the web view's place). */
const px = z.number().finite().min(-100_000).max(100_000)
const viewBounds = z.object({ x: px, y: px, width: px.min(0), height: px.min(0) })
/** One file or folder name — no separators, not `.` or `..` (the service checks again). */
const fileName = z.string().trim().min(1).max(255)
const paths = z.array(path).min(1).max(1000)
/** A moment as ms since 1970. */
const epochMs = z.number().finite().min(0).max(8.64e15)
/** A stash, by its full commit hash. */
const stashHash = z.string().regex(/^[0-9a-f]{40}$/i)
/** Include / exclude globs of a project search. */
const globs = z.array(z.string().min(1).max(500)).max(100).optional()

/** A model or mode id an agent offers. */
const optionId = z.string().min(1).max(200)
/** `@` references and images of a message to an agent (the service checks paths and sizes again). */
const composerRef = z.object({ kind: z.enum(['file', 'folder', 'note', 'tab']), path, label: text(500).optional() })
const composerImage = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.enum(IMAGE_TYPES),
  data: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
})

/** An absolute folder: `/…`, `~`-less, or a Windows drive / UNC path. */
const absolute = path.refine((p) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p), 'must be an absolute path')
const range = ([min, max]: readonly [number, number]) => z.number().finite().min(min).max(max)
const terminalProfile = z.object({
  id: z.string().regex(/^custom-[\w-]{1,64}$/),
  name: z.string().trim().min(1).max(80),
  command: z.string().trim().min(1).max(4096),
  args: z.array(text(4096)).max(64),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200), text(8192)).refine((e) => Object.keys(e).length <= 64),
  cwd: absolute.optional()
})
const terminalSettings = z
  .object({
    fontFamily: z.string().trim().min(1).max(200),
    fontSize: range(TERMINAL_LIMITS.fontSize),
    lineHeight: range(TERMINAL_LIMITS.lineHeight),
    cursorStyle: z.enum(TERMINAL_CURSORS),
    cursorBlink: z.boolean(),
    scrollback: range(TERMINAL_LIMITS.scrollback).int(),
    bufferKb: range(TERMINAL_LIMITS.bufferKb).int(),
    copyOnSelect: z.boolean(),
    gpu: z.boolean(),
    restore: z.boolean(),
    shellIntegration: z.boolean(),
    defaultProfile: text(200),
    profiles: z.array(terminalProfile).max(TERMINAL_LIMITS.profiles)
  })
  .partial()
const terminalSnapshot = z.object({
  layout: z.enum(['single', 'cols', 'rows', 'grid']),
  active: z.number().int().min(0).max(100),
  tabs: z
    .array(
      z.object({
        title,
        cwd: path,
        projectId: id.optional(),
        profileId: id.optional(),
        scrollback: text(512 * 1024)
      })
    )
    .max(12),
  savedAt: z.string().max(64)
})

type Schemas = { [K in IpcChannel]: z.ZodType<IpcChannels[K]['request']> }

/** Request schema per channel. Unknown object keys are stripped. */
export const REQUEST_SCHEMAS: Schemas = {
  'projects:list': none,
  'projects:pickFolder': none,
  'projects:add': z.object({ path }),
  'projects:remove': z.object({ id }),
  'projects:refresh': z.object({ id }),
  'projects:pull': z.object({ id }),
  'projects:openInEditor': z.object({ id }),
  'projects:githubDesktop': none,
  'projects:openInGitHubDesktop': z.object({ id }),
  'projects:openFile': z.object({ id, file: path, line: z.number().int().min(0).optional() }),
  'projects:trust': z.object({ id, trusted: z.boolean() }),

  'system:subscribe': none,
  'system:unsubscribe': none,
  'system:snapshot': none,
  'system:user': none,

  'context:get': z.object({ projectId: id }),
  'context:reindex': z.object({ projectId: id }),

  'memory:status': none,
  'memory:createVault': none,
  'memory:pickVault': none,
  'memory:list': none,
  'memory:read': z.object({ path: notePath }),
  'memory:write': z.object({ path: notePath, raw: text(6 * 1024 * 1024) }),
  'memory:create': z.object({ title, folder: text(1024).optional(), template: notePath.optional(), now: localTime.optional() }),
  'memory:trash': z.object({ path: notePath }),
  'memory:graph': none,
  'memory:search': z.object({ query: text(1000) }),
  'memory:setGraphStyle': z.object({ mode: z.enum(['colorful', 'single']), color: z.enum(GRAPH_COLORS) }),
  'memory:reveal': none,
  'memory:folders': none,
  'memory:writeBody': z.object({ path: notePath, body: text(6 * 1024 * 1024) }),
  'memory:createFolder': z.object({ parent: text(1024), name: title }),
  'memory:rename': z.object({ path: notePath, title }),
  'memory:move': z.object({ path: notePath, folder: text(1024) }),
  'memory:moveFolder': z.object({ folder: text(1024), into: text(1024) }),
  'memory:link': z.object({ from: notePath, to: notePath }),
  'memory:unlink': z.object({ from: notePath, to: notePath }),
  'memory:daily': z
    .object({ now: localTime.optional() })
    .optional()
    .transform((v) => v ?? {}),
  'memory:setDailyNotes': z.object({ folder: text(1024), template: text(1024) }),
  'memory:renderTemplate': z.object({ path: notePath, title, now: localTime.optional() }),
  'memory:attach': z.object({ name: z.string().trim().min(1).max(255), data: z.string().max(28 * 1024 * 1024) }),
  'memory:attachment': z.object({ target: z.string().min(1).max(1024), from: notePath.optional() }),
  'memory:setVault': z.object({ path }),

  'terminal:create': z
    .object({ projectId: id.optional(), cwd: path.optional(), cols: z.number().optional(), rows: z.number().optional(), profileId: id.optional() })
    .optional()
    .transform((v) => v ?? {}),
  'terminal:list': none,
  'terminal:attach': z.object({ id }),
  'terminal:write': z.object({ id, data: text(1024 * 1024) }),
  'terminal:resize': z.object({ id, cols: z.number(), rows: z.number() }),
  'terminal:kill': z.object({ id }),
  'terminal:shells': none,
  'terminal:settings': none,
  'terminal:configure': terminalSettings,
  'terminal:persist': terminalSnapshot,
  'terminal:restore': none,

  'files:list': z.object({ projectId: id, dir: text(4096).optional() }),
  'files:read': z.object({ projectId: id, path }),
  'files:stat': z.object({ projectId: id, paths: z.array(path).max(200) }),
  'files:write': z.object({ projectId: id, path, content: text(6 * 1024 * 1024), expectedMtime: z.number().optional() }),
  'files:create': z.object({ projectId: id, path, kind: z.enum(['file', 'dir']) }),
  'files:rename': z.object({ projectId: id, from: path, to: path }),
  'files:delete': z.object({ projectId: id, path }),

  'scm:status': z.object({ projectId: id }),
  'scm:init': z.object({ projectId: id }),
  'scm:stage': z.object({ projectId: id, paths: z.array(path).min(1).max(5000) }),
  'scm:unstage': z.object({ projectId: id, paths: z.array(path).min(1).max(5000) }),
  'scm:discard': z.object({ projectId: id, paths: z.array(path).min(1).max(5000) }),
  'scm:commit': z.object({ projectId: id, message: text(20_000), amend: z.boolean().optional(), all: z.boolean().optional() }),
  'scm:fetch': z.object({ projectId: id }),
  'scm:pull': z.object({ projectId: id }),
  'scm:push': z.object({ projectId: id }),
  'scm:branches': z.object({ projectId: id }),
  'scm:checkout': z.object({ projectId: id, name: z.string().min(1).max(250) }),
  'scm:createBranch': z.object({ projectId: id, name: z.string().min(1).max(250) }),
  'scm:log': z.object({ projectId: id, limit: z.number().int().min(1).max(2000).optional() }),
  'scm:show': z.object({ projectId: id, hash: z.string().regex(/^[0-9a-f]{4,40}$/i) }),
  'scm:diff': z.object({
    projectId: id,
    path,
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('unstaged') }),
      z.object({ kind: z.literal('staged') }),
      z.object({ kind: z.literal('commit'), hash: z.string().regex(/^[0-9a-f]{4,40}$/i), from: path.optional() }),
      z.object({ kind: z.literal('stash'), hash: stashHash, from: path.optional(), untracked: z.boolean().optional() })
    ])
  }),
  'scm:original': z.object({ projectId: id, path }),
  'scm:files': z.object({ projectId: id }),
  'scm:abort': z.object({ projectId: id }),
  'scm:continue': z.object({ projectId: id }),
  'scm:stashes': z.object({ projectId: id }),
  'scm:stash': z.object({ projectId: id, message: text(2000).optional(), untracked: z.boolean().optional() }),
  'scm:applyStash': z.object({ projectId: id, hash: stashHash, pop: z.boolean().optional() }),
  'scm:dropStash': z.object({ projectId: id, hash: stashHash }),
  'scm:stashFiles': z.object({ projectId: id, hash: stashHash }),
  'scm:blame': z.object({ projectId: id, path, text: text(6 * 1024 * 1024).optional() }),

  'search:start': z.object({
    id,
    projectId: id,
    query: z.object({
      pattern: z.string().min(1).max(2000),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      wholeWord: z.boolean().optional(),
      include: globs,
      exclude: globs,
      skip: z.array(path).max(1000).optional()
    })
  }),
  'search:cancel': z.object({ id }),

  'lsp:open': z.object({ projectId: id, path, text: text(6 * 1024 * 1024) }),
  'lsp:change': z.object({ projectId: id, path, text: text(6 * 1024 * 1024) }),
  'lsp:close': z.object({ projectId: id, path }),
  'lsp:diagnostics': z.object({ projectId: id, paths: z.array(path).max(200) }),
  'lsp:hover': at,
  'lsp:completions': at.extend({ trigger: z.string().max(2).optional() }),
  'lsp:completionDetails': at.extend({ name: z.string().max(1000), source: z.string().max(4096).optional(), data: z.unknown().optional() }),
  'lsp:definition': at,
  'lsp:references': at,
  'lsp:rename': at.extend({ newName: z.string().min(1).max(1000) }),
  'lsp:signature': at,
  'lsp:codeFixes': z.object({ projectId: id, path, range: z.object({ start: pos, end: pos }), errorCodes: z.array(z.number().int()).max(100) }),
  'lsp:symbols': z.object({ projectId: id, path }),

  'debug:start': z.object({
    projectId: id,
    program: path,
    args: z.array(text(4096)).max(100).optional(),
    stopOnEntry: z.boolean().optional(),
    breakpoints: z.array(breakpoint).max(1000),
    build: text(4096).optional(),
    inspectChild: z.boolean().optional(),
    module: z.string().regex(/^[\w.]+$/).max(200).optional(),
    goTest: z.boolean().optional()
  }),
  'debug:stop': none,
  'debug:session': none,
  'debug:control': z.object({ action: z.enum(['continue', 'pause', 'stepOver', 'stepInto', 'stepOut']) }),
  'debug:setBreakpoints': z.object({ projectId: id, breakpoints: z.array(breakpoint).max(1000) }),
  'debug:variables': z.object({ objectId: z.string().min(1).max(500) }),
  'debug:evaluate': z.object({ expression: text(10_000), frameId: z.string().max(500).optional() }),

  'tools:status': none,
  'tools:install': z.object({ id: z.string().min(1).max(50), part: z.enum(['server', 'debugger']) }),
  'tools:runtimes': none,

  'migrate:scan': none,
  'migrate:apply': z.object({ app: z.string().min(1).max(50) }),
  'editor:settings': none,
  'editor:update': z.record(z.string(), z.unknown()),
  'lint:file': z.object({ projectId: id, path, text: text(5_000_000) }),
  'lint:fix': z.object({ projectId: id, path, text: text(5_000_000) }),
  'lint:restart': none,
  'format:document': z.object({ projectId: id, path, text: text(5_000_000), prettier: z.boolean().optional(), options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }),
  'tests:discover': z.object({ projectId: id }),
  'tests:state': z.object({ projectId: id }),
  'tests:run': z.object({ projectId: id, id: text(10_000).optional() }),
  'tests:cancel': z.object({ projectId: id }),
  'tests:debug': z.object({ projectId: id, id: text(10_000).min(1), breakpoints: z.array(breakpoint).max(1000) }),

  'notebook:kernels': z.object({ projectId: id }),
  'notebook:setup': z.object({ projectId: id }),
  'notebook:start': z.object({ projectId: id, path, kernel: z.string().regex(/^[\w.+-]{1,100}$/) }),
  'notebook:execute': z.object({ projectId: id, path, cell: id, code: z.string().max(1_000_000) }),
  'notebook:interrupt': z.object({ projectId: id, path }),
  'notebook:restart': z.object({ projectId: id, path }),
  'notebook:shutdown': z.object({ projectId: id, path }),
  'liveServer:status': none,
  'liveServer:start': z.object({ projectId: id, page: path.optional() }),
  'liveServer:stop': z.object({ projectId: id }),
  'sass:compile': z.object({ projectId: id, path }),
  'sass:compileAll': z.object({ projectId: id }),

  'sftp:targets': z.object({ projectId: id }),
  'sftp:list': z.object({ projectId: id, target: z.string().min(1).max(300), dir: text(4096).optional() }),
  'sftp:upload': z.object({ projectId: id, target: z.string().min(1).max(300), paths: z.array(path).min(1).max(5000) }),
  'sftp:download': z.object({ projectId: id, target: z.string().min(1).max(300), paths: z.array(text(4096)).min(1).max(5000) }),
  'sftp:sync': z.object({ projectId: id, target: z.string().min(1).max(300), direction: z.enum(['up', 'down']) }),
  'github:status': z.object({ projectId: id }),
  'github:list': z.object({ projectId: id, filter: z.enum(['mine', 'review', 'all']).optional(), state: z.enum(['open', 'closed', 'merged', 'all']).optional() }),
  'github:view': z.object({ projectId: id, number: prNumber }),
  'github:fileDiff': z.object({ projectId: id, number: prNumber, path }),
  'github:checkout': z.object({ projectId: id, number: prNumber }),
  'github:create': z.object({ projectId: id, title: z.string().trim().min(1).max(256), body: text(65_536), base: z.string().min(1).max(255).optional(), draft: z.boolean().optional() }),
  'github:merge': z.object({ projectId: id, number: prNumber, method: z.enum(['merge', 'squash', 'rebase']), deleteBranch: z.boolean().optional() }),
  'github:comment': z.object({ projectId: id, number: prNumber, body: z.string().trim().min(1).max(65_536) }),
  'github:review': z.object({ projectId: id, number: prNumber, action: z.enum(['approve', 'request-changes', 'comment']), body: text(65_536).optional() }),
  'mongo:connections': none,
  'mongo:add': z.object({ name: z.string().trim().max(200), uri: z.string().trim().min(10).max(4096) }),
  'mongo:remove': z.object({ id }),
  'mongo:databases': z.object({ id }),
  'mongo:collections': z.object({ id, db: mongoName }),
  'mongo:createCollection': z.object({ id, db: mongoName, name: mongoName }),
  'mongo:dropCollection': z.object({ id, db: mongoName, name: mongoName }),
  'mongo:find': z.object({
    id,
    db: mongoName,
    collection: mongoName,
    query: z
      .object({ filter: text(100_000).optional(), sort: text(10_000).optional(), projection: text(10_000).optional(), limit: z.number().int().min(1).max(1000).optional(), skip: z.number().int().min(0).optional() })
      .optional()
  }),
  'mongo:insert': z.object({ id, db: mongoName, collection: mongoName, document: text(16_000_000) }),
  'mongo:replace': z.object({ id, db: mongoName, collection: mongoName, docId: text(10_000), document: text(16_000_000) }),
  'mongo:delete': z.object({ id, db: mongoName, collection: mongoName, docId: text(10_000) }),
  'mongo:aggregate': z.object({ id, db: mongoName, collection: mongoName, pipeline: text(100_000) }),
  'mongo:indexes': z.object({ id, db: mongoName, collection: mongoName }),
  'remote:hosts': none,
  'remote:list': none,
  'remote:ssh': z.object({ target: z.string().trim().min(1).max(300).regex(/^[\w.@:%+\-[\]]+$/, 'A host name, or user@host[:port]') }),
  'remote:container': z.object({ projectId: id }),
  'remote:hasContainer': z.object({ projectId: id }),
  'remote:disconnect': z.object({ id: z.string().min(1).max(5000) }),

  'app:info': none,
  'fs:dirs': z
    .object({ path: path.optional() })
    .optional()
    .transform((v) => v ?? {}),

  'server:status': none,
  'server:configure': z.object({
    enabled: z.boolean().optional(),
    lan: z.boolean().optional(),
    tls: z.boolean().optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    remoteTerminal: z.boolean().optional(),
    remoteRoots: z.array(path).max(50).optional()
  }),
  'server:createPairingCode': z
    .object({ role: z.enum(DEVICE_ROLES).optional() })
    .optional()
    .transform((v) => v ?? {}),
  'server:devices': none,
  'server:revokeDevice': z.object({ id }),
  'server:setDeviceRole': z.object({ id, role: z.enum(DEVICE_ROLES) }),

  'ai:status': none,
  'ai:setKey': z.object({ key: z.string().min(1).max(500) }),
  'ai:clearKey': none,
  'ai:configure': z.object({
    model: z.string().min(1).max(100).optional(),
    cloudModel: z.string().min(1).max(100).optional(),
    effort: z.enum(EFFORTS).optional(),
    inline: z.boolean().optional(),
    inlineModel: z.string().min(1).max(100).optional()
  }),
  'ai:agents': none,
  'ai:tools': none,
  'ai:conversations': none,
  'ai:conversation': z.object({ id }),
  'ai:send': z.object({
    conversationId: id.optional(),
    agentId: id.optional(),
    projectId: id.optional(),
    text: z.string().trim().min(1).max(100_000)
  }),
  'ai:cancel': z.object({ conversationId: id }),
  'ai:deleteConversation': z.object({ id }),
  'ai:runs': z
    .object({ limit: z.number().int().min(1).max(200).optional() })
    .optional()
    .transform((v) => v ?? {}),
  'ai:inlineComplete': z.object({
    requestId: id,
    path: z.string().max(4096),
    language: z.string().max(100),
    prefix: z.string().max(100_000),
    suffix: z.string().max(100_000)
  }),
  'ai:inlineEdit': z.object({
    requestId: id,
    path: z.string().max(4096),
    language: z.string().max(100),
    before: z.string().max(500_000),
    selection: z.string().max(200_000),
    after: z.string().max(500_000),
    instruction: z.string().trim().min(1).max(4000)
  }),
  'ai:inlineCancel': z.object({ requestId: id }),

  'permission:pending': none,
  'permission:respond': z.object({ id, decision: z.enum(['once', 'always', 'deny']) }),
  'permission:grants': none,
  'permission:revoke': z.object({ agentId: id, toolName: id, projectId: id.optional() }),

  'agents:detect': none,
  'agents:list': none,
  'agents:get': z.object({ id }),
  'agents:create': z.object({
    kind: z.enum(['claude-code', 'codex', 'gemini']),
    projectId: id,
    title: text(200).optional(),
    isolated: z.boolean().optional(),
    prompt: text(100_000).optional(),
    model: optionId.optional(),
    mode: optionId.optional()
  }),
  'agents:send': z.object({
    id,
    text: text(100_000),
    refs: z.array(composerRef).max(MAX_REFS).optional(),
    images: z.array(composerImage).max(MAX_IMAGES).optional()
  }),
  'agents:configure': z.object({ id, model: optionId.optional(), mode: optionId.optional() }),
  'agents:pushSettings': none,
  'agents:setPushSettings': z.object({ enabled: z.boolean() }),
  'agents:interrupt': z.object({ id }),
  'agents:stop': z.object({ id }),
  'agents:resume': z.object({ id }),
  'agents:remove': z.object({ id }),
  'agents:changes': z.object({ id }),
  'agents:branch': z.object({ id }),
  'agents:diff': z.object({ id, path }),
  'agents:accept': z.object({ id }),
  'agents:discard': z.object({ id }),
  'agents:rename': z.object({ id, title: z.string().trim().min(1).max(200) }),
  'agents:shell': z.object({ id }),
  'agents:openInEditor': z.object({ id }),

  'cloud:status': none,
  'cloud:login': z.object({ email, password: z.string().min(1).max(200) }),
  'cloud:register': z.object({
    email,
    password: z.string().min(10).max(200),
    name: z.string().trim().min(1).max(100).optional(),
    locale: z.enum(['de', 'en'])
  }),
  'cloud:logout': none,
  'cloud:refresh': none,
  'cloud:resendVerification': none,
  'cloud:forgotPassword': z.object({ email }),
  'cloud:checkout': none,
  'cloud:installId': none,
  'cloud:adopt': z.object({ token: z.string().min(10).max(10_000), account: z.object({ email: z.string().max(320), name: z.string().max(200).nullable() }) }),
  'cloud:syncStatus': none,
  'cloud:syncPush': z.object({ appearance: z.unknown().optional(), locale: z.enum(['de', 'en']).optional(), force: z.boolean().optional() }),
  'cloud:syncPull': none,

  'update:status': none,
  'update:check': none,
  'update:install': none,

  'desktop:status': none,
  'desktop:configure': z.object({ closeBehavior: z.enum(CLOSE_BEHAVIORS) }),
  'desktop:openLogs': none,
  'desktop:diagnostics': none,
  'desktop:reportError': z.object({
    kind: z.enum(['module', 'app', 'error', 'rejection']),
    module: text(64).optional(),
    message: text(2000),
    stack: text(16_000).optional(),
    componentStack: text(16_000).optional()
  }),

  'browser:extensions': none,
  'browser:extensions:install': z.discriminatedUnion('source', [
    z.object({ source: z.literal(EXTENSION_SOURCES[0]), input: z.string().trim().min(1).max(2048) }),
    z.object({ source: z.literal(EXTENSION_SOURCES[1]), path: path.optional() }),
    z.object({ source: z.literal(EXTENSION_SOURCES[2]), path })
  ]),
  'browser:extensions:profiles': none,
  'browser:extensions:update': z.object({ id, enabled: z.boolean() }),
  'browser:extensions:remove': z.object({ id }),
  'browser:extensions:checkUpdates': none,
  'browser:extensions:popup': z.object({ id, anchor: viewBounds }),
  'browser:auth': z.object({ id, username: text(1024).optional(), password: text(4096).optional() }),
  'browser:proceed': z.object({ id }),
  'browser:dismissDrm': z.object({ id }),
  'browser:pickDownloadDir': none,

  'browser:state': none,
  'browser:open': z
    .object({ url: text(8192).optional(), background: z.boolean().optional(), private: z.boolean().optional() })
    .optional()
    .transform((v) => v ?? {}),
  'browser:close': z.object({ id }),
  'browser:activate': z.object({ id }),
  'browser:navigate': z.object({ id, input: text(8192) }),
  'browser:go': z.object({ id, action: z.enum(['back', 'forward', 'reload', 'hardReload', 'stop']) }),
  'browser:update': z.object({ id, pinned: z.boolean().optional(), muted: z.boolean().optional(), shared: z.boolean().optional() }),
  'browser:move': z.object({ id, index: z.number().int().min(0).max(10_000), groupId: id.nullable().optional() }),
  'browser:duplicate': z.object({ id }),
  'browser:reopen': none,
  'browser:zoom': z.object({ id, zoom: z.enum(['in', 'out', 'reset']) }),
  'browser:find': z.object({ id, text: text(1000), forward: z.boolean().optional(), next: z.boolean().optional() }),
  'browser:findStop': z.object({ id }),
  'browser:tool': z.object({ id, tool: z.enum(['tabMenu', 'pageMenu', 'devtools', 'print', 'handoff', 'shield']) }),
  'browser:view': z.object({ bounds: viewBounds.nullable(), focused: z.boolean().optional(), panes: z.array(z.object({ id, bounds: viewBounds })).max(2).optional() }),
  'browser:freeze': none,
  'browser:unfreeze': none,
  'browser:suggest': z.object({ text: text(2000) }),
  'browser:history': z
    .object({ query: text(500).optional(), limit: z.number().int().min(1).max(500).optional() })
    .optional()
    .transform((v) => v ?? {}),
  'browser:clearHistory': none,
  'browser:download': z.object({ id, action: z.enum(['open', 'reveal', 'cancel', 'remove']) }),
  'browser:permission': z.object({ id, allow: z.boolean(), remember: z.boolean().optional() }),
  'browser:settings': none,
  'browser:configure': z.object({
    searchEngine: z.enum(SEARCH_ENGINES).optional(),
    openLinksInMindeck: z.boolean().optional(),
    adblock: z.boolean().optional(),
    malwareProtection: z.boolean().optional(),
    agentsUseLogins: z.boolean().optional(),
    askDownloadLocation: z.boolean().optional(),
    downloadDir: text(4096).optional(),
    searchSuggestions: z.boolean().optional(),
    bookmarksBar: z.boolean().optional(),
    verticalTabs: z.boolean().optional(),
    verticalTabsWidth: z.number().int().min(VERTICAL_TABS_WIDTH.min).max(VERTICAL_TABS_WIDTH.max).optional(),
    verticalTabsCollapsed: z.boolean().optional()
  }),
  'browser:ui': z.object({ theme: z.enum(['dark', 'light', 'system']), locale: z.enum(['de', 'en']) }),
  'browser:searchSuggest': z.object({ text: text(2000) }),
  'browser:historyList': z
    .object({ query: text(500).optional(), before: epochMs.optional(), limit: z.number().int().min(1).max(1000).optional() })
    .optional()
    .transform((v) => v ?? {}),
  'browser:historyDelete': z
    .object({ urls: z.array(text(8192)).max(10_000).optional(), from: epochMs.optional(), to: epochMs.optional() })
    .refine((v) => !!v.urls?.length || v.from !== undefined || v.to !== undefined, 'Say which pages to forget'),
  'browser:bookmarks': none,
  'browser:bookmarkAdd': z.object({ parentId: id.optional(), index: z.number().int().min(0).max(100_000).optional(), title, url: text(8192).min(1).optional() }),
  'browser:bookmarkUpdate': z.object({ id, title: title.optional(), url: text(8192).min(1).optional() }),
  'browser:bookmarkMove': z.object({ id, parentId: id, index: z.number().int().min(0).max(100_000) }),
  'browser:bookmarkRemove': z.object({ ids: z.array(id).min(1).max(10_000) }),
  'browser:bookmarksExport': none,
  'browser:bookmarksImport': z.object({ html: text(20_000_000) }),
  'browser:importSources': none,
  'browser:import': z.object({ sourceId: text(4096).min(1), kinds: z.array(z.enum(['bookmarks', 'history', 'settings'])).min(1).max(3) }),
  'browser:restoreSession': z.object({ restore: z.boolean() }),
  'browser:group': z.object({ ids: z.array(id).min(1).max(500), title: text(100).optional(), color: z.enum(TAB_GROUP_COLORS).optional() }),
  'browser:groupUpdate': z.object({ id, title: text(100).optional(), color: z.enum(TAB_GROUP_COLORS).optional(), collapsed: z.boolean().optional() }),
  'browser:ungroup': z.object({ id }),
  'browser:groupClose': z.object({ id }),
  'browser:split': z.object({ id, with: id.optional(), vertical: z.boolean().optional() }),
  'browser:splitUpdate': z.object({ id, ratio: z.number().min(0).max(1).optional(), vertical: z.boolean().optional(), swap: z.boolean().optional() }),
  'browser:unsplit': z.object({ id }),

  'finder:places': none,
  'finder:list': z
    .object({ path: path.optional(), hidden: z.boolean().optional(), offset: z.number().int().min(0).optional() })
    .optional()
    .transform((v) => v ?? {}),
  'finder:search': z.object({ path, query: z.string().trim().min(1).max(200) }),
  'finder:preview': z.object({ path }),
  'finder:mkdir': z.object({ parent: path, name: fileName }),
  'finder:rename': z.object({ path, name: fileName }),
  'finder:trash': z.object({ paths: paths }),
  'finder:move': z.object({ paths: paths, dest: path }),
  'finder:copy': z.object({ paths: paths, dest: path }),
  'finder:untrash': z.object({ items: z.array(z.object({ path, restore: path })).min(1).max(1000) }),
  'finder:privacySettings': none,
  'finder:conflicts': z.object({ paths: paths, dest: path }),
  'finder:transfer': z.object({
    id,
    paths: paths,
    dest: path,
    mode: z.enum(['copy', 'move']),
    choices: z.record(z.string().max(255), z.enum(['replace', 'keep', 'skip'])).optional()
  }),
  'finder:cancel': z.object({ id }),
  'finder:restore': z.object({ moves: z.array(z.object({ from: path, to: path })).min(1).max(1000) }),
  'finder:info': z.object({ path }),
  'finder:folderSize': z.object({ path, id }),
  'finder:compress': z.object({ paths: paths, id }),
  'finder:extract': z.object({ path, id }),
  'finder:clipboardWrite': z.object({ paths: paths, cut: z.boolean() }),
  'finder:clipboardRead': none,
  'finder:open': z.object({ path }),
  'finder:reveal': z.object({ path }),

  'events:recent': z
    .object({ limit: z.number().int().min(1).max(500).optional(), conversationId: id.optional() })
    .optional()
    .transform((v) => v ?? {})
}

/**
 * Validates a request. `void` channels accept undefined/null (a JSON body of
 * `null` from a remote client). Returns the parsed payload or a readable error.
 */
export function parseRequest<K extends IpcChannel>(
  channel: K,
  payload: unknown
): { ok: true; data: IpcChannels[K]['request'] } | { ok: false; message: string } {
  const res = REQUEST_SCHEMAS[channel].safeParse(payload === null ? undefined : payload)
  if (res.success) return { ok: true, data: res.data as IpcChannels[K]['request'] }
  const issue = res.error.issues[0]
  const where = issue.path.length ? `${issue.path.join('.')}: ` : ''
  return { ok: false, message: `Invalid request for ${channel} — ${where}${issue.message}` }
}
