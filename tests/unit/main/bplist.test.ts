import { describe, expect, it } from 'vitest'
import { parseBplist } from '../../../electron/main/services/browser/import/bplist'
import { bplist, layout } from './bplist-writer'

/** Written by Apple's `plutil -convert binary1` (macOS 27) — not by this repo's writer. */
const REFERENCE =
  'YnBsaXN0MDDcAQIDBAUGBwgJCgsMDQ4PEBESExQVGBkaVHJlYWxVYXNjaWlUbG9uZ1VzbWFsbFNiaWdVdXRmMTZUZGF0ZVRkYXRhVGxpc3RTeWVzUm5vWG5lZ2F0aXZlIz/4AAAAAAAAVlNhZmFyaV8QJ2Egc3RyaW5nIGxvbmdlciB0aGFuIGZpZnRlZW4gY2hhcmFjdGVycxAHEwAAAAEAAAAAZgBDAGEAZgDpACAmFTNByEuikAAAAEMAAQKiFhdRYRABCQgT//////////4IISYsMTc7QUZLUFRXYGlwmpylsru/wsTGx8gAAAAAAAABAQAAAAAAAAAbAAAAAAAAAAAAAAAAAAAA0Q=='

describe('binary property lists', () => {
  it('reads what Apple writes: strings (ASCII, UTF-16, long), ints, a real, a date, data, booleans, arrays', () => {
    expect({ ...(parseBplist(Buffer.from(REFERENCE, 'base64')) as object) }).toEqual({
      ascii: 'Safari',
      utf16: 'Café ☕',
      long: 'a string longer than fifteen characters',
      small: 7,
      big: 4294967296,
      negative: -2,
      real: 1.5,
      date: new Date('2026-11-01T10:00:00Z'),
      data: Buffer.from([0, 1, 2]),
      yes: true,
      no: false,
      list: ['a', 1]
    })
  })

  it('null and fill as null, a 4-byte real; dictionaries carry no prototype ("__proto__" is just a key)', () => {
    const float = Buffer.alloc(5)
    float[0] = 0x22
    float.writeFloatBE(0.25, 1)
    expect(parseBplist(layout([Buffer.from([0xa3, 0, 1, 0, 2, 0, 3]), Buffer.from([0x00]), Buffer.from([0x0f]), float]))).toEqual([null, null, 0.25])
    const dict = parseBplist(bplist({ __proto__x: 1, ['__proto__']: { polluted: true } })) as Record<string, unknown>
    expect(Object.getPrototypeOf(dict)).toBeNull()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses what is not one, or is broken: header, trailer, references, bounds, lengths, nesting, types it doesn’t read', () => {
    const ok = bplist({ a: 'b' })
    const broken = (patch: (b: Buffer) => void) => {
      const b = Buffer.from(ok)
      patch(b)
      return () => parseBplist(b)
    }
    expect(() => parseBplist(Buffer.from('not a plist at all, but long enough to have a trailer'))).toThrow('not a binary property list')
    expect(() => parseBplist(Buffer.from('bplist00'))).toThrow('not a binary property list')
    const end = ok.length - 32
    expect(broken((b) => (b[end + 6] = 0))).toThrow('trailer') // no offset size
    expect(broken((b) => b.writeBigUInt64BE(9n, end + 16))).toThrow('trailer') // top past the objects
    expect(broken((b) => b.writeBigUInt64BE(BigInt(end), end + 24))).toThrow('trailer') // offset table past the end
    // the dict's key points past the objects
    expect(broken((b) => b.writeUInt16BE(7, 9))).toThrow('object reference')
    // a string longer than the file
    expect(() => parseBplist(layout([Buffer.from([0x5e, 0x61])]))).toThrow('out of bounds')
    // an extended length that isn't an int
    expect(() => parseBplist(layout([Buffer.from([0x5f, 0x51, 0x61])]))).toThrow('length')
    // an array holding itself
    expect(() => parseBplist(layout([Buffer.from([0xa1, 0, 0])]))).toThrow('nested too deep')
    // UIDs (keyed archives) and sets: not bookmarks
    expect(() => parseBplist(layout([Buffer.from([0x80, 1])]))).toThrow('object type 0x80')
    expect(() => parseBplist(layout([Buffer.from([0xc0])]))).toThrow('object type 0xc0')
  })
})
