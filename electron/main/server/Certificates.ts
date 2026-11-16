import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPair } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { generate } from 'selfsigned'

/** One extension of `generate` (selfsigned names its type but does not export it). */
type CertificateExtension = NonNullable<NonNullable<Parameters<typeof generate>[1]>['extensions']>[number]
import type { TlsInfo } from '@shared/types/server'

const DAY_MS = 24 * 60 * 60_000
/** Two years: under the 825 days Apple platforms accept for any TLS server certificate. */
const VALID_DAYS = 730
/** A certificate this close to its end is replaced. */
const RENEW_BEFORE_MS = 30 * DAY_MS

/** What an HTTPS server needs: the PEMs, and what clients are told about them. */
export interface TlsCredentials extends TlsInfo {
  cert: string
  key: string
}

export interface CertificatesOptions {
  /** Where the self-signed certificate lives (`cert.pem`, `key.pem` — the key 0600). */
  dir: string
  /** An own certificate (PEM files, e.g. from Let's Encrypt): used as it is, never replaced here. */
  files?: { cert: string; key: string }
  /** Injected for tests. */
  now?: () => number
  hostname?: () => string
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function parse(cert: string): X509Certificate | null {
  try {
    return new X509Certificate(cert)
  } catch {
    return null
  }
}

/** `AB:CD:…`, the way `X509Certificate.fingerprint256` writes it. */
const colonHex = (digest: Buffer) => digest.toString('hex').toUpperCase().replace(/(..)(?!$)/g, '$1:')

/** Fingerprints (of the certificate and of its public key), end and origin of a certificate. */
function infoOf(x509: X509Certificate): TlsInfo {
  return {
    fingerprint: x509.fingerprint256,
    spkiFingerprint: colonHex(createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest()),
    expiresAt: new Date(Date.parse(x509.validTo)).toISOString(),
    // Issued by itself (and signed with its own key): nobody vouches for it but the fingerprint.
    selfSigned: x509.issuer === x509.subject && x509.verify(x509.publicKey)
  }
}

/**
 * The names a client may use for this core: `localhost`, 127.0.0.1, the
 * machine name (also as `<name>.local`, its mDNS name) and every LAN address.
 */
export function certificateHosts(addresses: string[], host: string): string[] {
  const name = host.toLowerCase()
  const names = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(name) ? (name.includes('.') ? [name] : [name, `${name}.local`]) : []
  return [...new Set(['localhost', '127.0.0.1', ...names, ...addresses])]
}

/**
 * The core's TLS certificate. Without one of its own, the core makes a
 * self-signed one (RSA 2048, SHA-256, two years) for all its names and
 * addresses, and keeps it in its data folder. Browsers warn about it once;
 * the pairing QR code carries its fingerprint, so a person (or the app) can
 * check it is the real core — trust on first use, no certificate authority.
 * It is made anew a month before it ends and when the computer got an address
 * it does not cover (on the same key, so a pinned public key stays valid).
 */
export class Certificates {
  private readonly now: () => number
  private readonly hostname: () => string
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: CertificatesOptions) {
    this.now = opts.now ?? Date.now
    this.hostname = opts.hostname ?? osHostname
  }

  /** Whether the certificate comes from the environment (then it is not the core's to make). */
  get custom(): boolean {
    return !!this.opts.files
  }

  /** The certificate for a server reachable at `addresses` — made or renewed when needed. */
  credentials(addresses: string[]): Promise<TlsCredentials> {
    // One at a time: a start and a pairing must not make two certificates.
    const run = this.chain.then(() => (this.opts.files ? this.own(this.opts.files) : this.selfSigned(addresses)))
    this.chain = run.catch(() => {})
    return run
  }

  /** The certificate as it is now, without making one (e.g. for `mindeck pair`); null when there is none. */
  async current(): Promise<TlsInfo | null> {
    const file = this.opts.files?.cert ?? join(this.opts.dir, 'cert.pem')
    const x509 = parse(await readFile(file, 'utf8').catch(() => ''))
    return x509 && infoOf(x509)
  }

  private async own(files: { cert: string; key: string }): Promise<TlsCredentials> {
    const [cert, key] = await Promise.all(
      [files.cert, files.key].map((f) =>
        readFile(f, 'utf8').catch((err: Error) => {
          throw coded('bad-certificate', `Cannot read ${f}: ${err.message}`)
        })
      )
    )
    const x509 = parse(cert)
    if (!x509) throw coded('bad-certificate', `${files.cert} holds no PEM certificate`)
    let matches: boolean
    try {
      matches = x509.checkPrivateKey(createPrivateKey(key))
    } catch {
      throw coded('bad-certificate', `${files.key} holds no PEM private key`)
    }
    if (!matches) throw coded('bad-certificate', `${files.key} is not the key of ${files.cert}`)
    return { cert, key, ...infoOf(x509) }
  }

  private async selfSigned(addresses: string[]): Promise<TlsCredentials> {
    const hosts = certificateHosts(addresses, this.hostname())
    const certFile = join(this.opts.dir, 'cert.pem')
    const keyFile = join(this.opts.dir, 'key.pem')
    const read = (f: string) => readFile(f, 'utf8').catch(() => null)
    const [cert, stored] = await Promise.all([read(certFile), read(keyFile)])
    // Only an intact RSA key of ours is kept.
    const key = stored && this.rsaKey(stored)
    const x509 = cert && key ? parse(cert) : null
    if (cert && key && x509?.checkPrivateKey(createPrivateKey(key)) && this.covers(x509, hosts)) {
      return { cert, key, ...infoOf(x509) }
    }
    const nextKey = key ?? (await newKey())
    const nextCert = await this.issue(hosts, nextKey)
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 })
    await writePrivate(keyFile, nextKey)
    await writePrivate(certFile, nextCert)
    return { cert: nextCert, key: nextKey, ...infoOf(new X509Certificate(nextCert)) }
  }

  private rsaKey(pem: string): string | null {
    try {
      return createPrivateKey(pem).asymmetricKeyType === 'rsa' ? pem : null
    } catch {
      return null
    }
  }

  /** Valid now, for more than a month, for every name and address. */
  private covers(x509: X509Certificate, hosts: string[]): boolean {
    const now = this.now()
    if (Date.parse(x509.validFrom) > now || Date.parse(x509.validTo) - now < RENEW_BEFORE_MS) return false
    return hosts.every((h) => (isIP(h) ? x509.checkIP(h) : x509.checkHost(h)) !== undefined)
  }

  private async issue(hosts: string[], key: string): Promise<string> {
    const host = this.hostname()
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string
    // A little in the past: a phone whose clock is a few minutes behind still accepts it.
    const notBeforeDate = new Date(Date.now() - 60 * 60_000)
    const extensions: CertificateExtension[] = [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: hosts.map((h) => (isIP(h) ? { type: 7, ip: h } : { type: 2, value: h })) }
    ]
    const attrs = [
      { name: 'commonName', value: `Mindeck (${host})` },
      { name: 'organizationName', value: 'Mindeck self-signed' }
    ]
    const { cert } = await generate(attrs, {
      algorithm: 'sha256',
      notBeforeDate,
      notAfterDate: new Date(notBeforeDate.getTime() + VALID_DAYS * DAY_MS),
      keyPair: { privateKey: key, publicKey },
      extensions
    })
    return cert
  }
}

async function newKey(): Promise<string> {
  const { privateKey } = await promisify(generateKeyPair)('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  return privateKey
}

/** Atomic, readable by the owner only (also when a leftover temp file had other rights). */
async function writePrivate(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}
