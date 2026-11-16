import { createHash, verify } from 'node:crypto'

/** What a CRX3 file holds: the ZIP inside, the extension's id and its public key. */
export interface CrxPackage {
  id: string
  /** The developer's public key (DER SubjectPublicKeyInfo) — `manifest.key` keeps the id stable. */
  publicKey: Buffer
  zip: Buffer
}

/** One signature of the package (RSA or ECDSA, both over SHA-256). */
interface Proof {
  publicKey: Buffer
  signature: Buffer
}

const MAGIC = 'Cr24'
const SIGNED_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1')

function bad(message: string): Error {
  return Object.assign(new Error(message), { code: 'bad-package' })
}

/** Chrome's extension id: the key's SHA-256, first 16 bytes, written with the letters a–p. */
export function idFromKey(publicKey: Buffer): string {
  return idFromBytes(createHash('sha256').update(publicKey).digest().subarray(0, 16))
}

function idFromBytes(bytes: Buffer): string {
  return [...bytes.toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

/** Protocol Buffers, the little the CRX header needs: varints and length-delimited fields. */
function* fields(buf: Buffer): Generator<{ field: number; value: Buffer }> {
  let at = 0
  const varint = (): number => {
    let result = 0
    let shift = 0
    for (;;) {
      if (at >= buf.length) throw bad('Broken CRX header')
      const byte = buf[at++]
      result += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) return result
      shift += 7
      if (shift > 49) throw bad('Broken CRX header')
    }
  }
  while (at < buf.length) {
    const key = varint()
    const type = key % 8
    const field = Math.floor(key / 8)
    if (type === 0) {
      varint()
    } else if (type === 2) {
      const length = varint()
      if (at + length > buf.length) throw bad('Broken CRX header')
      yield { field, value: buf.subarray(at, at + length) }
      at += length
    } else if (type === 5 || type === 1) {
      at += type === 5 ? 4 : 8
    } else {
      throw bad('Broken CRX header')
    }
  }
}

function proof(value: Buffer): Proof {
  let publicKey: Buffer = Buffer.alloc(0)
  let signature: Buffer = Buffer.alloc(0)
  for (const f of fields(value)) {
    if (f.field === 1) publicKey = f.value
    else if (f.field === 2) signature = f.value
  }
  return { publicKey, signature }
}

/**
 * Reads and checks a CRX3 package (what the Chrome Web Store serves): every
 * signature in its header must verify over the archive, and one of them must
 * come from the key the extension's id is made of — the same checks Chrome
 * makes before it installs an extension.
 */
export function parseCrx(buf: Buffer): CrxPackage {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== MAGIC) throw bad('Not a Chrome extension package (CRX)')
  const version = buf.readUInt32LE(4)
  if (version !== 3) throw bad(`Unsupported CRX version ${version}`)
  const headerSize = buf.readUInt32LE(8)
  if (12 + headerSize > buf.length) throw bad('Broken CRX header')
  const header = buf.subarray(12, 12 + headerSize)
  const zip = buf.subarray(12 + headerSize)

  const proofs: Proof[] = []
  let signedData: Buffer | undefined
  for (const f of fields(header)) {
    // 2: sha256_with_rsa, 3: sha256_with_ecdsa
    if (f.field === 2 || f.field === 3) proofs.push(proof(f.value))
    else if (f.field === 10000) signedData = f.value
  }
  if (!signedData) throw bad('The package is not signed')
  let crxId: Buffer | undefined
  for (const f of fields(signedData)) if (f.field === 1) crxId = f.value
  if (!crxId || crxId.length !== 16) throw bad('The package has no id')

  const size = Buffer.alloc(4)
  size.writeUInt32LE(signedData.length)
  const message = Buffer.concat([SIGNED_PREFIX, size, signedData, zip])
  let developer: Buffer | undefined
  for (const p of proofs) {
    let ok = false
    try {
      ok = verify('sha256', message, { key: p.publicKey, format: 'der', type: 'spki' }, p.signature)
    } catch {
      ok = false
    }
    if (!ok) throw bad('The package signature does not verify')
    if (createHash('sha256').update(p.publicKey).digest().subarray(0, 16).equals(crxId)) developer = p.publicKey
  }
  if (!developer) throw bad('The package is not signed by its developer')
  return { id: idFromBytes(crxId), publicKey: Buffer.from(developer), zip: Buffer.from(zip) }
}
