/**
 * A binary property list (`bplist00`) of a plain value, as Apple writes them —
 * for the tests: dicts, arrays, ASCII and UTF-16 strings, small ints, reals,
 * dates, data, booleans and null. References are 2 bytes, offsets 4.
 */
export function bplist(value: unknown): Buffer {
  const objects: Buffer[] = []
  const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff])
  const sized = (type: number, n: number) => (n < 15 ? Buffer.from([(type << 4) | n]) : Buffer.concat([Buffer.from([(type << 4) | 0xf, 0x11]), u16(n)]))
  const add = (v: unknown): number => {
    const at = objects.length
    objects.push(Buffer.alloc(0)) // its place, before its children take theirs
    objects[at] = encode(v)
    return at
  }
  const encode = (v: unknown): Buffer => {
    if (v === null) return Buffer.from([0x00])
    if (typeof v === 'boolean') return Buffer.from([v ? 0x09 : 0x08])
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= 0 && v < 256) return Buffer.from([0x10, v])
      const real = Buffer.alloc(9)
      real[0] = 0x23
      real.writeDoubleBE(v, 1)
      return real
    }
    if (v instanceof Date) {
      const date = Buffer.alloc(9)
      date[0] = 0x33
      date.writeDoubleBE(v.getTime() / 1000 - 978_307_200, 1)
      return date
    }
    if (Buffer.isBuffer(v)) return Buffer.concat([sized(0x4, v.length), v])
    if (typeof v === 'string') {
      // eslint-disable-next-line no-control-regex -- ASCII is what Apple writes as an ASCII string
      if (/^[\x00-\x7f]*$/.test(v)) return Buffer.concat([sized(0x5, v.length), Buffer.from(v, 'latin1')])
      const le = Buffer.from(v, 'utf16le')
      return Buffer.concat([sized(0x6, le.length / 2), Buffer.from(le).swap16()])
    }
    if (Array.isArray(v)) {
      const refs = v.map(add)
      return Buffer.concat([sized(0xa, refs.length), ...refs.map(u16)])
    }
    const entries = Object.entries(v as Record<string, unknown>)
    const keys = entries.map(([k]) => add(k))
    const values = entries.map(([, x]) => add(x))
    return Buffer.concat([sized(0xd, entries.length), ...keys.map(u16), ...values.map(u16)])
  }
  add(value)
  return layout(objects)
}

/** Objects (already encoded, references 2 bytes) laid out with their offset table and trailer; `top` is the root. */
export function layout(objects: Buffer[], top = 0): Buffer {
  const head = Buffer.from('bplist00', 'latin1')
  const offsets: number[] = []
  let at = head.length
  for (const o of objects) {
    offsets.push(at)
    at += o.length
  }
  const table = Buffer.alloc(objects.length * 4)
  offsets.forEach((o, i) => table.writeUInt32BE(o, i * 4))
  const trailer = Buffer.alloc(32)
  trailer[6] = 4
  trailer[7] = 2
  trailer.writeBigUInt64BE(BigInt(objects.length), 8)
  trailer.writeBigUInt64BE(BigInt(top), 16)
  trailer.writeBigUInt64BE(BigInt(at), 24)
  return Buffer.concat([head, ...objects, table, trailer])
}
