/**
 * Streaming sites that play only with DRM (Widevine), which Electron's
 * Chromium does not have. Mindeck says so and offers the system browser
 * instead of showing a player that never starts.
 */
const DRM_SITES = [
  'netflix.com',
  'open.spotify.com',
  'disneyplus.com',
  'primevideo.com',
  'max.com',
  'hbomax.com',
  'hulu.com',
  'tv.apple.com',
  'paramountplus.com',
  'peacocktv.com',
  'dazn.com',
  'crunchyroll.com',
  'listen.tidal.com',
  'rtlplus.com',
  'joyn.de',
  'wowtv.de',
  'magentatv.de',
  'waipu.tv',
  'zattoo.com'
]

/** Amazon's own Prime Video pages (amazon.de/gp/video/…). */
const AMAZON_VIDEO = /^(www\.)?amazon\.[a-z.]+$/

/** Players report a missing key system in the console (EME, Shaka, dash.js, Bitmovin …). */
const DRM_CONSOLE = /requestMediaKeySystemAccess|com\.widevine\.alpha|key ?system|widevine|\bEME\b|MediaKeys|\bDRM\b/i

/** A page known to need DRM. */
export function needsDrm(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (!/^https?:$/.test(u.protocol)) return false
  const host = u.hostname.toLowerCase()
  if (AMAZON_VIDEO.test(host) && /^\/gp\/video\b/.test(u.pathname)) return true
  return DRM_SITES.some((site) => host === site || host.endsWith(`.${site}`))
}

/** A console error or warning that says playback failed for want of DRM. */
export function drmFailure(level: string, message: string): boolean {
  return (level === 'error' || level === 'warning') && DRM_CONSOLE.test(message)
}
