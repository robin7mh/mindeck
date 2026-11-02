import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'

export interface ZipFile {
  name: string
  data: Buffer | string
  /** 0 stored, 8 deflated (default), anything else as given. */
  method?: number
  flags?: number
  /** Overrides for broken archives. */
  size?: number
}

/** A ZIP archive as Chrome's packer writes it (local headers, central directory, end record). */
export function zip(files: ZipFile[], opts: { prefix?: Buffer; count?: number; offset?: number } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = opts.prefix?.length ?? 0
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data)
    const method = f.method ?? 8
    const body = method === 8 ? deflateRawSync(data) : data
    const name = Buffer.from(f.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(f.flags ?? 0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(f.size ?? data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(f.flags ?? 0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(f.size ?? data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(opts.count ?? files.length, 8)
  end.writeUInt16LE(opts.count ?? files.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(opts.offset ?? offset, 16)
  return Buffer.concat([opts.prefix ?? Buffer.alloc(0), ...locals, dir, end])
}

function varint(n: number): Buffer {
  const out: number[] = []
  while (n > 127) {
    out.push((n % 128) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return Buffer.from(out)
}

/** A length-delimited protobuf field. */
export function field(n: number, value: Buffer): Buffer {
  return Buffer.concat([varint(n * 8 + 2), varint(value.length), value])
}

/** A varint protobuf field. */
export function varintField(n: number, value: number): Buffer {
  return Buffer.concat([varint(n * 8), varint(value)])
}

export function keyPair(type: 'rsa' | 'ec' = 'rsa') {
  const { publicKey, privateKey } =
    type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { spki: publicKey.export({ format: 'der', type: 'spki' }), privateKey }
}

export const idOf = (spki: Buffer) =>
  [...createHash('sha256').update(spki).digest().subarray(0, 16).toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')

/** A signed CRX3 package of `archive`, like the Web Store's. */
export function crx(
  archive: Buffer,
  opts: { keys?: ReturnType<typeof keyPair>[]; idKey?: Buffer; badSignature?: boolean; extra?: Buffer; proofExtra?: Buffer; noSignedData?: boolean; ecdsa?: boolean } = {}
): Buffer {
  const keys = opts.keys ?? [keyPair()]
  const crxId = createHash('sha256')
    .update(opts.idKey ?? keys[0].spki)
    .digest()
    .subarray(0, 16)
  const signedData = field(1, crxId)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(signedData.length)
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), size, signedData, archive])
  const proofs = keys.map((k) => {
    const signature = opts.badSignature ? Buffer.from('nope') : sign('sha256', message, k.privateKey)
    return field(opts.ecdsa ? 3 : 2, Buffer.concat([field(1, k.spki), field(2, signature), opts.proofExtra ?? Buffer.alloc(0)]))
  })
  const header = Buffer.concat([...proofs, opts.extra ?? Buffer.alloc(0), opts.noSignedData ? Buffer.alloc(0) : field(10000, signedData)])
  const head = Buffer.alloc(12)
  head.write('Cr24', 0, 'latin1')
  head.writeUInt32LE(3, 4)
  head.writeUInt32LE(header.length, 8)
  return Buffer.concat([head, header, archive])
}
