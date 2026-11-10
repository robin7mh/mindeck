/** Apple counts dates in seconds since 2001 — seconds since 1970 here. */
export const APPLE_EPOCH_S = 978_307_200

/** How deep containers may nest (Safari's bookmarks go a few levels; a cycle would go on forever). */
const MAX_DEPTH = 64

const malformed = (what: string) => Object.assign(new Error(`Malformed property list: ${what}`), { code: 'bad-plist' })

/**
 * Apple's binary property list (`bplist00`, what Safari keeps its bookmarks
 * in) as plain values: dictionaries as objects without a prototype, arrays,
 * strings, numbers, booleans, dates as Date, data as Buffer; `null` for the
 * null and fill markers. UIDs and sets (archives, not bookmarks) and anything
 * out of bounds throw.
 */
export function parseBplist(buf: Buffer): unknown {
  if (buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') throw malformed('not a binary property list')
  // The trailer: the sizes of offsets and object references, how many objects, the top one, where the offsets are.
  const end = buf.length - 32
  const offsetSize = buf[end + 6]
  const refSize = buf[end + 7]
  const count = Number(buf.readBigUInt64BE(end + 8))
  const top = Number(buf.readBigUInt64BE(end + 16))
  const table = Number(buf.readBigUInt64BE(end + 24))
  if (!offsetSize || !refSize || top >= count || table + count * offsetSize > end) throw malformed('trailer')

  const need = (at: number, bytes: number) => {
    if (at + bytes > end) throw malformed('object out of bounds')
  }
  const uint = (at: number, size: number): number => {
    need(at, size)
    let v = 0
    for (let i = 0; i < size; i++) v = v * 256 + buf[at + i]
    return v
  }

  const read = (ref: number, depth: number): unknown => {
    if (depth > MAX_DEPTH) throw malformed('nested too deep')
    if (ref >= count) throw malformed('object reference')
    const at = uint(table + ref * offsetSize, offsetSize)
    need(at, 1)
    const marker = buf[at]
    const info = marker & 0xf
    // A length: in the marker, or — 0xF — in the int object right after it.
    const sized = (unit: number): [number, number] => {
      let n = info
      let from = at + 1
      if (info === 0xf) {
        need(from, 1)
        if (buf[from] >> 4 !== 0x1) throw malformed('length')
        const size = 1 << (buf[from] & 0xf)
        n = uint(from + 1, size)
        from += 1 + size
      }
      need(from, n * unit)
      return [n, from]
    }
    switch (marker >> 4) {
      case 0x0:
        return info === 0x8 ? false : info === 0x9 ? true : null
      case 0x1: {
        const size = 1 << info
        need(at + 1, size)
        return size === 8 ? Number(buf.readBigInt64BE(at + 1)) : uint(at + 1, size)
      }
      case 0x2:
        need(at + 1, 1 << info)
        return info === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1)
      case 0x3:
        need(at + 1, 8)
        return new Date((buf.readDoubleBE(at + 1) + APPLE_EPOCH_S) * 1000)
      case 0x4: {
        const [n, from] = sized(1)
        return buf.subarray(from, from + n)
      }
      case 0x5: {
        const [n, from] = sized(1)
        return buf.toString('latin1', from, from + n)
      }
      case 0x6: {
        // UTF-16, big-endian: swapped to the little-endian Node decodes.
        const [n, from] = sized(2)
        return Buffer.from(buf.subarray(from, from + n * 2)).swap16().toString('utf16le')
      }
      case 0xa: {
        const [n, from] = sized(refSize)
        return Array.from({ length: n }, (_, i) => read(uint(from + i * refSize, refSize), depth + 1))
      }
      case 0xd: {
        const [n, from] = sized(refSize * 2)
        const out: Record<string, unknown> = Object.create(null)
        for (let i = 0; i < n; i++) out[String(read(uint(from + i * refSize, refSize), depth + 1))] = read(uint(from + (n + i) * refSize, refSize), depth + 1)
        return out
      }
      default:
        throw malformed(`object type 0x${marker.toString(16)}`)
    }
  }
  return read(top, 0)
}
