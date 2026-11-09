// Renders the logo (logo.mjs) everywhere it is used, plus the DMG background (dmg.html).
//   node build/brand/render.mjs
// Writes this repo's icons, and those of the phone app and the cloud's admin pages when
// ../mindeck-mobile and ../mindeck-cloud exist (the website is being redone — it keeps its own for
// now). Needs Playwright's Chromium (npx playwright install chromium); macOS 26's icon
// (build/Assets.car) needs Xcode 26 or later.
//
// Every icon comes in the system's appearances — the white tile in light mode, the dark tile in dark
// mode, tinted and clear where the system has them — and the white tile wherever a system shows one
// icon only (no appearance to follow):
//   macOS 26+, iOS 18+  the system switches (Assets.car, the asset catalog)
//   older macOS, Windows, Linux  the white tile; while Mindeck runs it follows the theme (main.ts)
//   Android  the white tile, and the themed (monochrome) icon of Android 13+
//   browsers  favicons that follow prefers-color-scheme (one SVG with both tiles)
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { adaptiveIcon, icon, layers } from './logo.mjs'

/** The splash screen's ground, light and dark (the phone app's app.json says the same). */
const SPLASH = { light: '#ffffff', dark: '#04060b' }

const brand = dirname(fileURLToPath(import.meta.url))
const desktop = join(brand, '../..')
const mobile = join(desktop, '../mindeck-mobile')
const cloud = join(desktop, '../mindeck-cloud')

const write = (file, data) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  console.log('  ' + file.slice(join(desktop, '..').length + 1))
}

const browser = await chromium.launch()
/** An SVG drawn at `size` px square. */
async function png(svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`)
  const data = await page.screenshot({ omitBackground: true })
  await page.close()
  return data
}

/** Drops a PNG's alpha channel — iOS refuses app icons that have one. Takes 8-bit RGBA, not interlaced (what Chromium writes). */
function opaque(data) {
  let ihdr
  const idat = []
  for (let pos = 8; pos < data.length; ) {
    const length = data.readUInt32BE(pos)
    const type = data.toString('latin1', pos + 4, pos + 8)
    if (type === 'IHDR') ihdr = data.subarray(pos + 8, pos + 8 + length)
    if (type === 'IDAT') idat.push(data.subarray(pos + 8, pos + 8 + length))
    pos += 12 + length
  }
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  if (ihdr[9] === 2) return data // RGB already: Chromium leaves the alpha out when every pixel is opaque
  if (ihdr[8] !== 8 || ihdr[9] !== 6 || ihdr[12] !== 0) throw new Error('expected an 8-bit RGBA PNG, not interlaced')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgb = Buffer.alloc(height * (1 + width * 3))
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? line[i - 4] : 0
      const b = prev[i]
      const c = i >= 4 ? prev[i - 4] : 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = (line[i] + add) & 255
    }
    for (let x = 0; x < width; x++) line.copy(rgb, y * (1 + width * 3) + 1 + x * 3, x * 4, x * 4 + 3)
    prev = line
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, crc])
  }
  const header = Buffer.from(ihdr)
  header[9] = 2 // RGB
  return Buffer.concat([data.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(rgb, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** A Windows .ico of PNG images (Vista and later read those). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i
    head[entry] = head[entry + 1] = size >= 256 ? 0 : size
    head.writeUInt16LE(1, entry + 4)
    head.writeUInt16LE(32, entry + 6)
    head.writeUInt32LE(data.length, entry + 8)
    head.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...images.map((image) => image.data)])
}

/** An icon of `kind` at `size` px, in an appearance (default: the white tile — what a system without one shows). */
const at = (kind, size, theme = 'light') => png(icon(kind, theme), size)
/** A Windows .ico of the rounded white tile in these sizes. */
const winIco = async (sizes) => ico(await Promise.all(sizes.map(async (size) => ({ size, data: await at('rounded', size) }))))

/**
 * The Icon Composer document for macOS 26+ (and iOS 26+): the reactor above its ground, each a
 * picture per appearance. Light and dark come out exactly as the full icons; in the tinted and clear
 * looks the ground goes and the clear reactor stands on the system's glass.
 */
async function iconDocument(dir) {
  const light = layers('light')
  const dark = layers('dark')
  write(join(dir, 'Assets/ground-light.png'), opaque(await png(light.ground, 1024)))
  write(join(dir, 'Assets/ground-dark.png'), opaque(await png(dark.ground, 1024)))
  write(join(dir, 'Assets/reactor-light.png'), await png(light.reactor, 1024))
  write(join(dir, 'Assets/reactor-dark.png'), await png(dark.reactor, 1024))
  write(join(dir, 'Assets/reactor-clear.png'), await png(layers('clear').reactor, 1024))
  // The first layer is on top. The default comes first in every list: without it the system ignores the others.
  const reactor = {
    name: 'Reactor',
    glass: false,
    'image-name-specializations': [{ value: 'reactor-light.png' }, { appearance: 'dark', value: 'reactor-dark.png' }, { appearance: 'tinted', value: 'reactor-clear.png' }]
  }
  const ground = {
    name: 'Ground',
    glass: false,
    'image-name-specializations': [{ value: 'ground-light.png' }, { appearance: 'dark', value: 'ground-dark.png' }],
    'hidden-specializations': [{ value: false }, { appearance: 'tinted', value: true }]
  }
  const doc = { groups: [{ layers: [reactor, ground], shadow: { kind: 'neutral', opacity: 0.5 }, translucency: { enabled: false, value: 0.5 } }], 'supported-platforms': { squares: ['macOS', 'iOS'] } }
  write(join(dir, 'icon.json'), JSON.stringify(doc, null, 2) + '\n')
}

/** Compiles the Icon Composer document into the asset catalog macOS 26 reads (CFBundleIconName AppIcon) — when this Mac has Xcode 26 or later. */
function compileAssets(document, out) {
  const work = mkdtempSync(join(tmpdir(), 'mindeck-icon-'))
  try {
    cpSync(document, join(work, 'AppIcon.icon'), { recursive: true })
    mkdirSync(join(work, 'out'))
    execFileSync('xcrun', ['actool', join(work, 'AppIcon.icon'), '--compile', join(work, 'out'), '--platform', 'macosx', '--minimum-deployment-target', '13.0', '--app-icon', 'AppIcon', '--output-partial-info-plist', join(work, 'partial.plist')], { stdio: 'pipe' })
    cpSync(join(work, 'out/Assets.car'), out)
    console.log('  ' + out.slice(join(desktop, '..').length + 1))
  } catch (err) {
    console.warn(`  build/Assets.car not rebuilt (needs Xcode 26+ on macOS): ${String(err.stderr || err.message).trim().split('\n')[0]}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** An Xcode asset catalog entry: one image per appearance (the light one without any — the default). */
const appearances = (theme) => (theme === 'light' ? {} : { appearances: [{ appearance: 'luminosity', value: theme }] })

console.log('desktop')
// The logo in the app (MindeckMark), in the app's appearance, and the web app's tab (index.html) in the system's.
write(join(brand, 'tile.svg'), icon('tile'))
write(join(brand, 'tile-light.svg'), icon('tile', 'light'))
write(join(brand, 'tile-auto.svg'), adaptiveIcon('tile'))
// macOS: the document and its compiled catalog (macOS 26+ switches by itself); icon.png for the .icns older macOS shows.
await iconDocument(join(desktop, 'build/AppIcon.icon'))
compileAssets(join(desktop, 'build/AppIcon.icon'), join(desktop, 'build/Assets.car'))
write(join(desktop, 'build/icon.png'), await at('macos', 1024))
write(join(desktop, 'build/icon.ico'), await winIco([16, 24, 32, 48, 64, 128, 256]))
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) write(join(desktop, `build/icons/${size}x${size}.png`), await at('rounded', size))
// What the running app switches between when the theme changes (resources/icons): the tray (Windows/Linux),
// the window (Windows/Linux), the Dock (`npm run dev`, and macOS before 26).
for (const theme of ['light', 'dark']) {
  write(join(desktop, `build/runtime/tray-${theme}.png`), await at('tile', 32, theme))
  write(join(desktop, `build/runtime/window-${theme}.png`), await at('rounded', 256, theme))
  write(join(desktop, `build/runtime/dock-${theme}.png`), await at('macos', 512, theme))
}
for (const scale of [1, 2]) {
  const page = await browser.newPage({ viewport: { width: 540, height: 380 }, deviceScaleFactor: scale })
  await page.goto(`file://${join(brand, 'dmg.html')}`)
  await page.evaluate(() => document.fonts.ready)
  write(join(desktop, `build/background${scale === 2 ? '@2x' : ''}.png`), await page.screenshot())
  await page.close()
}

if (existsSync(mobile)) {
  console.log('phone app')
  // iOS 18+ switches between them (app.json ios.icon); Android and the web take the white one.
  write(join(mobile, 'assets/images/icon.png'), opaque(await at('full', 1024)))
  write(join(mobile, 'assets/images/icon-dark.png'), opaque(await at('full', 1024, 'dark')))
  write(join(mobile, 'assets/images/icon-tinted.png'), opaque(await at('full', 1024, 'tinted')))
  write(join(mobile, 'assets/images/android-icon-background.png'), opaque(await at('android-bg', 1024)))
  write(join(mobile, 'assets/images/android-icon-foreground.png'), await at('android-fg', 1024))
  write(join(mobile, 'assets/images/android-icon-monochrome.png'), await at('android-mono', 1024))
  write(join(mobile, 'assets/images/splash-icon.png'), await at('tile', 1024))
  write(join(mobile, 'assets/images/splash-icon-dark.png'), await at('tile', 1024, 'dark'))
  write(join(mobile, 'assets/images/favicon.png'), await at('tile', 48))
  // A local native project (`expo run:ios`, Xcode): its asset catalog gets them too — `expo prebuild` would rewrite the project.
  const catalog = join(mobile, 'ios/Mindeck/Images.xcassets')
  if (existsSync(catalog)) {
    const appIcon = join(catalog, 'AppIcon.appiconset')
    const images = []
    for (const theme of ['light', 'dark', 'tinted']) {
      const filename = `App-Icon-1024x1024-${theme}.png`
      write(join(appIcon, filename), opaque(await at('full', 1024, theme)))
      images.push({ filename, idiom: 'universal', platform: 'ios', size: '1024x1024', ...appearances(theme) })
    }
    write(join(appIcon, 'Contents.json'), JSON.stringify({ images, info: { version: 1, author: 'expo' } }, null, 2) + '\n')
    rmSync(join(appIcon, 'App-Icon-1024x1024@1x.png'), { force: true })
    const splash = join(catalog, 'SplashScreenLogo.imageset')
    const splashImages = []
    for (const theme of ['light', 'dark']) {
      for (const scale of [1, 2, 3]) {
        const filename = `image-${theme}${scale > 1 ? `@${scale}x` : ''}.png`
        write(join(splash, filename), await at('tile', 120 * scale, theme))
        splashImages.push({ idiom: 'universal', filename, scale: `${scale}x`, ...appearances(theme) })
      }
    }
    write(join(splash, 'Contents.json'), JSON.stringify({ images: splashImages, info: { version: 1, author: 'expo' } }, null, 2) + '\n')
    for (const old of ['image.png', 'image@2x.png', 'image@3x.png']) rmSync(join(splash, old), { force: true })
    const rgb = (hex) => ({ red: String(parseInt(hex.slice(1, 3), 16) / 255), green: String(parseInt(hex.slice(3, 5), 16) / 255), blue: String(parseInt(hex.slice(5, 7), 16) / 255), alpha: '1.000' })
    const colors = [
      { color: { components: rgb(SPLASH.light), 'color-space': 'srgb' }, idiom: 'universal' },
      { color: { components: rgb(SPLASH.dark), 'color-space': 'srgb' }, idiom: 'universal', ...appearances('dark') }
    ]
    write(join(catalog, 'SplashScreenBackground.colorset/Contents.json'), JSON.stringify({ colors, info: { version: 1, author: 'expo' } }, null, 2) + '\n')
  }
}

if (existsSync(cloud)) {
  console.log('cloud (admin pages)')
  write(join(cloud, 'admin/public/favicon.svg'), adaptiveIcon('tile'))
}

await browser.close()
