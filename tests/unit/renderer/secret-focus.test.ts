import { afterEach, describe, expect, it } from 'vitest'
import { SECRET_FOCUS } from '../../../electron/main/services/browser/secretFocus'

/** What the page answers when a paired device wants to type. */
const secret = () => (0, eval)(SECRET_FOCUS) as boolean

function field(html: string, root: ParentNode & Node = document.body): HTMLElement {
  const box = document.createElement('div')
  box.innerHTML = html
  root.appendChild(box)
  const el = box.firstElementChild as HTMLElement
  el.focus()
  return el
}

describe('the focused field a paired device types into', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('is fine for text, search and nothing focused', () => {
    expect(secret()).toBe(false)
    field('<input type="text" autocomplete="username">')
    expect(secret()).toBe(false)
    field('<textarea></textarea>')
    expect(secret()).toBe(false)
    field('<input>')
    expect(secret()).toBe(false)
  })

  it('is a secret for passwords, one-time codes and card numbers', () => {
    for (const html of ['<input type="password">', '<input type="PASSWORD">', '<input autocomplete="one-time-code">', '<input autocomplete="section-a current-password">', '<input autocomplete="new-password">', '<input autocomplete="cc-number">', '<input autocomplete="cc-csc">']) {
      field(html)
      expect(secret(), html).toBe(true)
    }
  })

  it('looks into shadow roots and frames of the same site; a frame of another site counts as a secret', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    field('<input type="password">', shadow)
    expect(secret()).toBe(true)

    document.body.innerHTML = ''
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const inner = frame.contentDocument!
    const input = inner.createElement('input')
    inner.body.appendChild(input)
    frame.focus()
    input.focus()
    expect(secret()).toBe(false)
    input.type = 'password'
    expect(secret()).toBe(true)

    let other: () => Document | null = () => null
    Object.defineProperty(frame, 'contentDocument', { get: () => other() })
    expect(secret()).toBe(true)
    other = () => {
      throw new Error('cross-origin')
    }
    expect(secret()).toBe(true)
  })
})
