/**
 * Whether the focused field takes a secret — a password, a one-time code, a
 * card number — or sits in a frame of another site (which the page cannot
 * look into): a paired device does not type there.
 */
export const SECRET_FOCUS = `(() => {
  const inner = (el) => { while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el }
  let el = inner(document.activeElement)
  while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
    let doc = null
    try { doc = el.contentDocument } catch {}
    if (!doc) return true
    el = inner(doc.activeElement)
  }
  if (!el || el.tagName !== 'INPUT') return false
  const type = (el.getAttribute('type') || '').toLowerCase()
  const auto = (el.getAttribute('autocomplete') || '').toLowerCase()
  return type === 'password' || /\\b(one-time-code|current-password|new-password|cc-number|cc-csc)\\b/.test(auto)
})()`
