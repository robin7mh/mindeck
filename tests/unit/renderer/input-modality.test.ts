import { afterEach, describe, expect, it } from 'vitest'
import { trackInputModality } from '@/lib/inputModality'

const input = () => document.documentElement.dataset.input
const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

afterEach(() => {
  delete document.documentElement.dataset.input
})

describe('input modality (for the focus rings)', () => {
  it('a click or tap makes it the pointer; Tab the keyboard; a typed key after a click leaves it the pointer', () => {
    const stop = trackInputModality()
    expect(input()).toBeUndefined() // nothing yet: rings as the browser decides
    document.dispatchEvent(new Event('pointerdown'))
    expect(input()).toBe('pointer')
    key('b') // a letter or a shortcut is no keyboard navigation
    key('Enter')
    expect(input()).toBe('pointer')
    key('Tab')
    expect(input()).toBe('keyboard')
    document.dispatchEvent(new Event('pointerdown'))
    expect(input()).toBe('pointer')

    // stopped: nothing changes it any more
    stop()
    key('Tab')
    expect(input()).toBe('pointer')
  })
})
