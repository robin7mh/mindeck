// electron-builder mac.sign: signs as electron-builder does, except for Electron's plugin helper
// ("Mindeck Helper (Plugin).app"). electron-builder gives every helper entitlements.mac.inherit.plist;
// the plugin helper — where utility processes started with allowLoadingUnsignedLibraries run (the
// lint worker and tsserver: the project's plugins and their native addons, lib/nodeProcess.ts) —
// gets entitlements.mac.plugin.plist instead.
const { join } = require('node:path')

const PLUGIN_ENTITLEMENTS = join(__dirname, 'entitlements.mac.plugin.plist')

/** The plugin helper's bundle and everything in it (its executable). */
const inPluginHelper = (file) => /Helper \(Plugin\)\.app([\\/]|$)/.test(file)

/** The signing step around `sign` (@electron/osx-sign's, with electron-builder's retries). */
function signWith(sign) {
  return (opts) => {
    const optionsForFile = opts.optionsForFile
    return sign({
      ...opts,
      optionsForFile: (file) => {
        const options = optionsForFile(file)
        return inPluginHelper(file) ? { ...options, entitlements: PLUGIN_ENTITLEMENTS } : options
      }
    })
  }
}

exports.signWith = signWith
exports.PLUGIN_ENTITLEMENTS = PLUGIN_ENTITLEMENTS
exports.default = (opts) => signWith(require('app-builder-lib/out/codeSign/macCodeSign').sign)(opts)
