import { Facet, StateEffect, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { isImageTarget } from '@shared/types/memory'

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode']

/**
 * Obsidian's Live Preview for CodeMirror: Markdown renders where it is
 * written — headings in size, **bold** bold, links as links, task boxes as
 * checkboxes, pictures as pictures — while the lines the cursor is on show
 * their Markdown, so it can be edited as text. Only the visible part of the
 * note is decorated.
 */

/** What the editor asks the note view. */
export interface LiveHooks {
  /** Is there a note behind this link target? (Unresolved links look different.) */
  resolves(target: string): boolean
  /** A picture from the vault as a data: URL; null when there is none. */
  image(target: string): Promise<string | null>
  /** Follow a `[[link]]`. */
  openNote(target: string): void
  /** Follow a web link. */
  openUrl(url: string): void
}

const NO_HOOKS: LiveHooks = { resolves: () => true, image: async () => null, openNote: () => {}, openUrl: () => {} }

export const liveHooks = Facet.define<LiveHooks, LiveHooks>({ combine: (values) => values[0] ?? NO_HOOKS })

/** Dispatch when what the hooks answer changed (a note was created, renamed …). */
export const refreshLive = StateEffect.define<null>()

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-md-checkbox'
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      // `[ ]` ↔ `[x]` — found from the DOM, so it is right however the text moved.
      const at = view.posAtDOM(box)
      view.dispatch({ changes: { from: at + 1, to: at + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
  ignoreEvent() {
    return true
  }
}

/** Bullets and rules are one shared decoration each — CodeMirror sees they are unchanged by identity. */
class BulletWidget extends WidgetType {
  toDOM() {
    const dot = document.createElement('span')
    dot.className = 'cm-md-bullet'
    dot.textContent = '•'
    return dot
  }
}

class RuleWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('span')
    hr.className = 'cm-md-hr'
    return hr
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly alt: string,
    readonly width?: number
  ) {
    super()
  }
  eq(other: ImageWidget) {
    return other.target === this.target && other.alt === this.alt && other.width === this.width
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-embed'
    const img = document.createElement('img')
    img.alt = this.alt
    if (this.width) img.width = this.width
    wrap.append(img)
    void view.state
      .facet(liveHooks)
      .image(this.target)
      .catch(() => null)
      .then((url) => {
        if (url) {
          img.src = url
          // A picture changes the line's height.
          img.onload = () => view.requestMeasure()
        } else {
          wrap.classList.add('cm-md-embed-missing')
          wrap.textContent = this.alt
        }
      })
    return wrap
  }
}

const hide = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })
const rule = Decoration.replace({ widget: new RuleWidget() })
const mark = (cls: string, attributes?: Record<string, string>) => Decoration.mark({ class: cls, ...(attributes ? { attributes } : {}) })

/** Line numbers the selection touches — those show their Markdown. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l += 1) lines.add(l)
  }
  return lines
}

/** The decorations for `from`–`to` of the document. */
export function decorate(state: EditorState, from: number, to: number): Range<Decoration>[] {
  const { doc } = state
  const hooks = state.facet(liveHooks)
  const activeSet = activeLines(state)
  const active = (a: number, b: number) => {
    for (let l = doc.lineAt(a).number; l <= doc.lineAt(b).number; l += 1) if (activeSet.has(l)) return true
    return false
  }
  const out: Range<Decoration>[] = []
  const lineClass = (a: number, b: number, cls: string) => {
    for (let l = doc.lineAt(a).number; l <= doc.lineAt(b).number; l += 1) out.push(Decoration.line({ class: cls }).range(doc.line(l).from))
  }
  /** Hide `a`–`b` plus one following space (`## `, `> `, `- `). */
  const hideWithSpace = (a: number, b: number) => out.push(hide.range(a, doc.sliceString(b, b + 1) === ' ' ? b + 1 : b))
  const text = (n: SyntaxNode) => doc.sliceString(n.from, n.to)
  /** Replacing across a line break is not possible from a plugin — such constructs stay as text. */
  const oneLine = (n: SyntaxNode) => doc.lineAt(n.from).number === doc.lineAt(n.to).number

  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const node = ref.node
      const name = node.name
      const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name)
      if (heading) {
        out.push(Decoration.line({ class: `cm-md-h${heading[1]}` }).range(doc.lineAt(node.from).from))
        return
      }
      switch (name) {
        case 'HeaderMark':
          if (node.parent!.name.startsWith('ATX') && !active(node.from, node.to)) {
            if (node.from === doc.lineAt(node.from).from) hideWithSpace(node.from, node.to)
            else out.push(hide.range(node.from, node.to))
          }
          return
        case 'Emphasis':
          out.push(mark('cm-md-em').range(node.from, node.to))
          return
        case 'StrongEmphasis':
          out.push(mark('cm-md-strong').range(node.from, node.to))
          return
        case 'Strikethrough':
          out.push(mark('cm-md-strike').range(node.from, node.to))
          return
        case 'InlineCode':
          out.push(mark('cm-md-code').range(node.from, node.to))
          return
        case 'EmphasisMark':
        case 'StrikethroughMark':
          if (!active(node.from, node.to)) out.push(hide.range(node.from, node.to))
          return
        case 'CodeMark': {
          const block = node.parent!
          if (!active(block.from, block.to)) out.push(hide.range(node.from, node.to))
          return
        }
        case 'FencedCode':
        case 'CodeBlock':
          lineClass(node.from, node.to, 'cm-md-codeblock')
          return
        case 'CodeInfo':
          out.push(mark('cm-md-codeinfo').range(node.from, node.to))
          return
        case 'Blockquote':
          lineClass(node.from, node.to, 'cm-md-quote')
          return
        case 'QuoteMark':
          if (!active(node.from, node.to)) hideWithSpace(node.from, node.to)
          return
        case 'ListMark': {
          const item = node.parent!
          if (item.parent!.name !== 'BulletList' || active(node.from, node.to)) return
          // A task shows its checkbox instead of the dash.
          if (item.getChild('Task')) hideWithSpace(node.from, node.to)
          else out.push(bullet.range(node.from, node.to))
          return
        }
        case 'TaskMarker': {
          const checked = /x/i.test(text(node))
          // GFM wants a space after the box, so the task's text is never empty.
          if (checked) out.push(mark('cm-md-done').range(node.to, node.parent!.to))
          if (!active(node.from, node.to)) out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to))
          return
        }
        case 'HorizontalRule':
          if (!active(node.from, node.to)) out.push(rule.range(node.from, node.to))
          return
        case 'Link': {
          const marks = node.getChildren('LinkMark')
          const url = node.getChild('URL')
          if (!url || marks.length < 2) return
          const attrs = { 'data-href': text(url) }
          if (active(node.from, node.to) || !oneLine(node)) out.push(mark('cm-md-link', attrs).range(node.from, node.to))
          else {
            out.push(hide.range(marks[0].from, marks[0].to))
            out.push(mark('cm-md-link', { ...attrs, 'data-live': '1' }).range(marks[0].to, marks[1].from))
            out.push(hide.range(marks[1].from, node.to))
          }
          return false
        }
        case 'URL':
          // A bare address (GFM autolink) or <address>.
          if (node.parent!.name !== 'Link' && node.parent!.name !== 'Image') {
            out.push(mark('cm-md-link', { 'data-href': text(node), 'data-live': '1' }).range(node.from, node.to))
          }
          return
        case 'Image': {
          const url = node.getChild('URL')
          const marks = node.getChildren('LinkMark')
          if (!url || active(node.from, node.to) || !oneLine(node)) return
          const alt = doc.sliceString(marks[0].to, marks[1].from)
          out.push(Decoration.replace({ widget: new ImageWidget(text(url), alt) }).range(node.from, node.to))
          return false
        }
        case 'WikiLink':
        case 'WikiEmbed': {
          const target = node.getChild('WikiTarget')!
          const alias = node.getChild('WikiAlias')
          const [open, close] = node.getChildren('WikiMark')
          const goal = text(target).trim()
          const isActive = active(node.from, node.to)
          if (name === 'WikiEmbed' && isImageTarget(goal)) {
            if (isActive) return false
            // `![[bild.png|300]]`: the number is the width.
            const width = alias ? Number(text(alias).slice(1)) || undefined : undefined
            out.push(Decoration.replace({ widget: new ImageWidget(goal, goal, width) }).range(node.from, node.to))
            return false
          }
          const cls = hooks.resolves(goal) ? 'cm-md-wikilink' : 'cm-md-wikilink cm-md-unresolved'
          if (isActive) {
            out.push(mark(cls, { 'data-target': goal }).range(node.from, node.to))
            return false
          }
          out.push(hide.range(open.from, open.to))
          if (alias) {
            out.push(hide.range(target.from, alias.from + 1))
            out.push(mark(cls, { 'data-target': goal, 'data-live': '1' }).range(alias.from + 1, alias.to))
          } else {
            out.push(mark(cls, { 'data-target': goal, 'data-live': '1' }).range(target.from, target.to))
          }
          out.push(hide.range(close.from, close.to))
          return false
        }
        case 'Tag':
          out.push(mark('cm-md-tag').range(node.from, node.to))
          return
      }
    }
  })
  return out
}

function build(view: EditorView): DecorationSet {
  const ranges = view.visibleRanges.flatMap(({ from, to }) => decorate(view.state, from, to))
  return Decoration.set(ranges, true)
}

/** The plugin: rebuilt on every transaction (typing, the cursor, a refresh) and on scrolling. */
export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(u: ViewUpdate) {
      if (u.viewportChanged || u.transactions.length > 0) this.decorations = build(u.view)
    }
  },
  { decorations: (v) => v.decorations }
)

/**
 * Following links: a click on a rendered link opens it, ⌘/Ctrl-click opens
 * one on a line being edited too. Plain clicks into Markdown text still edit.
 */
export const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-target], [data-href]')
    if (!el || !(el.dataset.live || e.metaKey || e.ctrlKey) || e.button !== 0) return false
    e.preventDefault()
    const hooks = view.state.facet(liveHooks)
    if (el.dataset.target) hooks.openNote(el.dataset.target)
    else hooks.openUrl(el.dataset.href!)
    return true
  }
})
