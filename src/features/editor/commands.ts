import type { Dict } from '@/lib/i18n/en'
import { useEditor } from './store'
import { useScm, type PickItem } from './scm'
import { useGitHub } from './github'
import { editorActions } from './actions'
import { useBlame } from './blame'
import { useEditorPrefs } from './prefs'
import { formatBinding, shortcutLabel } from '@/lib/shortcuts'
import { macKeys } from '@/features/workspace/keys'

/** Monaco actions the palette lists under their own (translated) names, with VS Code's keys. */
const CURATED: [id: string, key: keyof Dict['palette']['editor'], keys?: string][] = [
  ['mindeck.formatDocument', 'format', '⇧⌥F'],
  ['editor.action.commentLine', 'comment', '⌘/'],
  ['editor.action.revealDefinition', 'definition', 'F12'],
  ['editor.action.goToReferences', 'references', '⇧F12'],
  ['editor.action.rename', 'rename', 'F2'],
  ['editor.action.quickOutline', 'symbol', '⇧⌘O'],
  ['editor.action.quickFix', 'quickFix', '⌘.'],
  ['editor.foldAll', 'foldAll'],
  ['editor.unfoldAll', 'unfoldAll'],
  ['actions.find', 'find', '⌘F'],
  ['editor.action.startFindReplaceAction', 'replace', '⌥⌘F'],
  ['mindeck.tidyBlankLines', 'tidy']
]

/** Monaco actions the palette leaves out: its own palette, and duplicates of ours. */
const HIDDEN = new Set(['editor.action.quickCommand', 'editor.action.gotoLine', 'editor.action.formatDocument', ...CURATED.map(([id]) => id)])

export interface CommandContext {
  readOnly: boolean
  /** Extra commands from other parts of the editor (the debugger). */
  extra?: PickItem[]
}

/** Focus a field by its label once the pane holding it is on screen. */
function focusLater(label: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.focus())
}

/**
 * What the editor adds to the command palette (⇧⌘P / F1 — features/palette):
 * files, views, git, and Monaco's own editor actions. Writing commands are
 * left out where the core is read-only.
 */
export function buildCommands(t: Dict, { readOnly, extra = [] }: CommandContext): PickItem[] {
  const p = t.palette
  const editor = () => useEditor.getState()
  const scm = () => useScm.getState()
  const write = (items: PickItem[]) => (readOnly ? [] : items)
  const status = scm().status
  const repo = !!status?.repo
  const actions = editorActions()

  const pane = (id: 'files' | 'outline' | 'search' | 'scm' | 'graph' | 'prs', label: string, keys?: string): PickItem => ({ id: `view.${id}`, label: `${p.view}: ${label}`, keys, run: () => scm().setPane(id) })
  const prefs = () => useEditorPrefs.getState()
  const mac = macKeys()
  // Editor groups: ⌘1…⌘9 focus one (one past the last splits it).
  const groups = editor().groups.length
  const focusGroups: PickItem[] = Array.from({ length: Math.min(groups + 1, 9) }, (_, i) => ({
    id: `view.focusGroup${i + 1}`,
    label: `${p.view}: ${p.focusGroup(i + 1)}`,
    keys: formatBinding(`mod+${i + 1}`, mac),
    run: () => editor().focusGroupAt(i)
  }))

  const git: PickItem[] = !status
    ? []
    : !repo
      ? write([{ id: 'git.init', label: `Git: ${t.scm.init}`, run: () => scm().init() }])
      : [
          ...write([
            {
              id: 'git.commit',
              label: `Git: ${t.scm.commit}`,
              run: () => {
                scm().setPane('scm')
                focusLater(t.scm.message)
              }
            },
            { id: 'git.pull', label: `Git: ${t.scm.pull}`, run: () => scm().pull() },
            { id: 'git.push', label: `Git: ${t.scm.push}`, run: () => scm().push() },
            { id: 'git.fetch', label: `Git: ${t.scm.fetch}`, run: () => scm().fetch() },
            { id: 'git.sync', label: `Git: ${p.sync}`, run: () => scm().sync() },
            {
              id: 'git.checkout',
              label: `Git: ${p.checkout}`,
              run: () =>
                scm().openPick({
                  placeholder: p.pickBranch,
                  items: scm().branches.map((b) => ({ id: b.name, label: b.name, detail: b.current ? p.current : b.remote ? t.scm.remote : undefined, run: () => scm().checkout(b.name) }))
                })
            },
            {
              id: 'git.branch',
              label: `Git: ${p.createBranch}`,
              run: () => scm().openPick({ placeholder: t.scm.branchName, items: [], onText: (name) => scm().createBranch(name) })
            },
            { id: 'git.stash', label: `Git: ${t.stash.palette}`, run: () => scm().openPick({ placeholder: t.stash.message, items: [], onText: (message) => scm().stash(message, false) }) },
            { id: 'git.stashUntracked', label: `Git: ${t.stash.paletteUntracked}`, run: () => scm().openPick({ placeholder: t.stash.message, items: [], onText: (message) => scm().stash(message, true) }) },
            {
              id: 'github.create',
              label: `GitHub: ${t.github.create}`,
              run: () => {
                scm().setPane('prs')
                useGitHub.getState().setCreating(true)
              }
            }
          ]),
          pane('graph', t.scm.panes.graph),
          pane('prs', t.scm.panes.prs),
          {
            id: 'git.blame',
            label: `Git: ${t.blame.toggle}`,
            run: () => {
              const id = editor().focusedId()
              if (id) useBlame.getState().toggle(id)
            }
          },
          {
            id: 'git.inlineBlame',
            label: `Git: ${t.blame.toggleInline}`,
            run: () => useEditorPrefs.getState().update({ inlineBlame: useEditorPrefs.getState().settings.inlineBlame === false })
          }
        ]

  const editorItems: PickItem[] = !actions
    ? []
    : (() => {
        const supported = actions.list()
        const ids = new Set(supported.map((a) => a.id))
        return [
          ...CURATED.filter(([id]) => ids.has(id)).map(([id, key, keys]) => ({ id, label: `${p.editorCategory}: ${p.editor[key]}`, keys, run: () => actions.run(id) })),
          ...supported.filter((a) => !HIDDEN.has(a.id)).map((a) => ({ id: a.id, label: `${p.editorCategory}: ${a.label}`, run: () => actions.run(a.id) }))
        ]
      })()

  return [
    ...write([
      { id: 'file.new', label: `${p.file}: ${t.explorer.newFile}`, run: () => (scm().setPane('files'), editor().startNaming('file')) },
      { id: 'file.newFolder', label: `${p.file}: ${t.explorer.newFolder}`, run: () => (scm().setPane('files'), editor().startNaming('dir')) },
      { id: 'file.save', label: `${p.file}: ${t.common.save}`, keys: '⌘S', run: () => editor().save() },
      { id: 'file.saveAll', label: `${p.file}: ${p.saveAll}`, keys: '⌥⌘S', run: () => editor().saveAll() }
    ]),
    { id: 'file.close', label: `${p.file}: ${p.closeEditor}`, run: () => editor().focusedId() && editor().requestClose(editor().focusedId()!) },
    { id: 'go.file', label: `${p.go}: ${t.scm.quickOpen}`, keys: '⌘P', run: () => scm().setQuickOpen(true) },
    { id: 'go.line', label: `${p.go}: ${p.goToLine}`, keys: '⌃G', run: () => scm().setQuickOpen(true, ':') },
    { id: 'view.split', label: `${p.view}: ${p.split}`, keys: shortcutLabel('editor.split', mac), run: () => editor().split('right') },
    { id: 'view.splitDown', label: `${p.view}: ${p.splitDown}`, keys: shortcutLabel('editor.splitDown', mac), run: () => editor().split('down') },
    ...(groups > 1 ? [{ id: 'view.closeGroup', label: `${p.view}: ${p.closeGroup}`, run: () => editor().closeGroup() }] : []),
    ...focusGroups,
    { id: 'view.minimap', label: `${p.view}: ${p.toggleMinimap}`, run: () => prefs().update({ minimap: prefs().settings.minimap === false }) },
    { id: 'view.stickyScroll', label: `${p.view}: ${p.toggleStickyScroll}`, run: () => prefs().update({ stickyScroll: prefs().settings.stickyScroll === false }) },
    pane('files', t.explorer.title),
    pane('outline', t.scm.panes.outline),
    pane('search', t.scm.panes.search, '⇧⌘F'),
    pane('scm', t.scm.panes.scm, '⇧⌘G'),
    ...git,
    ...extra,
    ...editorItems
  ]
}
