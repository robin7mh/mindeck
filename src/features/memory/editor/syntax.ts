import type { InlineContext, MarkdownConfig } from '@lezer/markdown'
import { styleTags, tags } from '@lezer/highlight'

/**
 * Obsidian's additions to Markdown for the note editor's parser:
 * `[[Target#Heading|Alias]]` links, `![[bild.png]]` embeds and `#tags` —
 * the same rules the vault indexer uses (`parse.ts`), so what the editor
 * shows as a link is what the graph counts as one.
 */

const BANG = 33
const HASH = 35
const OPEN = 91

/** `[[…]]` or `![[…]]` starting at `pos`: its parts, or null. */
function wiki(cx: InlineContext, next: number, pos: number) {
  if (next !== BANG && next !== OPEN) return null
  const embed = next === BANG
  const start = embed ? pos + 1 : pos
  if (cx.char(start) !== OPEN || cx.char(start + 1) !== OPEN) return null
  const m = /^\[\[([^\]\n|]+)(\|[^\]\n]*)?\]\]/.exec(cx.slice(start, cx.end))
  if (!m) return null
  return { embed, start, target: m[1], alias: m[2], end: start + m[0].length }
}

export const ObsidianSyntax: MarkdownConfig = {
  defineNodes: ['WikiLink', 'WikiEmbed', 'WikiMark', 'WikiTarget', 'WikiAlias', 'Tag'],
  props: [styleTags({ 'WikiLink WikiEmbed': tags.link, WikiMark: tags.processingInstruction, Tag: tags.labelName })],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        const w = wiki(cx, next, pos)
        if (!w) return -1
        const targetFrom = w.start + 2
        const targetTo = targetFrom + w.target.length
        const children = [cx.elt('WikiMark', pos, targetFrom), cx.elt('WikiTarget', targetFrom, targetTo)]
        if (w.alias) children.push(cx.elt('WikiAlias', targetTo, targetTo + w.alias.length))
        children.push(cx.elt('WikiMark', w.end - 2, w.end))
        return cx.addElement(cx.elt(w.embed ? 'WikiEmbed' : 'WikiLink', pos, w.end, children))
      }
    },
    {
      name: 'Tag',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== HASH) return -1
        // A tag starts a word (start of line, after a space, "(" or ",") — not `a#b`, not `##`.
        if (pos > cx.offset && !/[\s(,]/.test(String.fromCharCode(cx.char(pos - 1)))) return -1
        const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(cx.slice(pos, cx.end))
        return m ? cx.addElement(cx.elt('Tag', pos, pos + m[0].length)) : -1
      }
    }
  ]
}
