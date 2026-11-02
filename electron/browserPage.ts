import { contextBridge } from 'electron'
import { chromeBrands, patchUserAgentData } from './main/platform/browser/clientHints'

// The preload of every page in the browser's tabs — no Mindeck bridge, nothing exposed. It only
// makes navigator.userAgentData name the same brands as the client-hint headers (Google Chrome).
const full = process.versions.chrome
contextBridge.executeInMainWorld({ func: patchUserAgentData, args: [chromeBrands(full, false), chromeBrands(full, true), full] })
