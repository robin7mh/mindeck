import DOMPurify, { type Config } from 'dompurify'

/**
 * The one sanitizer for every piece of foreign HTML Mindeck shows: Markdown
 * from notes, READMEs, PR comments, agent answers and notebooks. DOMPurify
 * already strips scripts, handlers and `javascript:` / `data:` links; on top
 * of that nothing may restyle or overlay the app (an injected `<style>` is
 * global, a `style=` or a borrowed Tailwind class can paint over an approval
 * card) and nothing may ask for input (a fake sign-in form).
 */

/** Classes Mindeck's own Markdown pipeline sets (wikilinks, tags, pictures, code languages). */
const OWN_CLASSES = new Set(['wikilink', 'unresolved', 'embed', 'md-tag', 'missing'])
const ownClass = (c: string) => OWN_CLASSES.has(c) || /^language-[\w+#.-]+$/.test(c)

/** Elements that style, embed, navigate or take input. */
const FORBID_TAGS = ['style', 'link', 'meta', 'base', 'form', 'button', 'textarea', 'select', 'option', 'optgroup', 'datalist', 'output', 'fieldset', 'iframe', 'frame', 'frameset', 'object', 'embed', 'dialog']
/** Attributes that style, focus, submit, clobber the DOM or open a top layer. */
const FORBID_ATTR = ['style', 'id', 'name', 'tabindex', 'autofocus', 'accesskey', 'action', 'formaction', 'form', 'popover', 'popovertarget', 'contenteditable']

const MARKDOWN: Config = { USE_PROFILES: { html: true }, FORBID_TAGS, FORBID_ATTR }

const markdownPurifier = DOMPurify(window)
markdownPurifier.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName !== 'class') return
  data.attrValue = data.attrValue.split(/\s+/).filter(ownClass).join(' ')
  if (!data.attrValue) data.keepAttr = false
})

/**
 * Sanitized Markdown HTML as a detached `<body>`, for callers that still mark
 * things up (no new markup from the input). Inputs survive only as disabled
 * checkboxes (GFM task lists); links open outside, without an opener.
 */
export function sanitizeToBody(html: string): HTMLElement {
  const body = markdownPurifier.sanitize(html, { ...MARKDOWN, RETURN_DOM: true }) as HTMLElement
  body.querySelectorAll('input').forEach((input) => {
    if (input.type !== 'checkbox') input.remove()
    else input.disabled = true
  })
  body.querySelectorAll('a[href]').forEach((a) => {
    if (a.getAttribute('href')!.startsWith('#')) return
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })
  return body
}

/** Sanitized Markdown HTML as a string. */
export function sanitizeHtml(html: string): string {
  return sanitizeToBody(html).innerHTML
}

// A notebook's HTML output lives in a frame of its own: its own CSS (pandas'
// `<style scoped>`, `class="dataframe"`) stays, but nothing that embeds,
// redirects or submits does.
const framePurifier = DOMPurify(window)
const FRAME: Config = {
  USE_PROFILES: { html: true },
  FORCE_BODY: true,
  FORBID_TAGS: ['iframe', 'frame', 'frameset', 'object', 'embed', 'meta', 'link', 'base', 'form', 'button', 'input', 'textarea', 'select', 'dialog'],
  FORBID_ATTR: ['action', 'formaction', 'autofocus', 'popover', 'popovertarget']
}

/** Sanitized HTML for a sandboxed output frame. */
export function sanitizeFrameHtml(html: string): string {
  return framePurifier.sanitize(html, FRAME)
}
