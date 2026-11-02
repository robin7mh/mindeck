import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Every local data location, derived in exactly one place (architecture §11.1). */
export interface MindeckPaths {
  /** ~/Mindeck — the one user-visible home of everything Mindeck keeps. */
  homeDir: string
  /** ~/Mindeck/data — project registry, settings, history, caches: plain files, no database. */
  dataDir: string
  /** Typed app settings (JSON, atomic writes). */
  settingsFile: string
  /** Default markdown vault root — user-visible so it stays Obsidian-openable. */
  defaultVaultRoot: string
  /** Paired remote devices (token hashes, never tokens) and pending pairing codes. */
  devicesFile: string
  /** The network server's self-signed TLS certificate and key (0600). */
  tlsDir: string
  /** Secrets such as the LLM API key — encrypted on desktop, 0600 on a server. */
  secretsFile: string
  /** The Mindeck account: last signed entitlement, install id (the session token is a secret). */
  cloudFile: string
  /** Persisted "Always allow" permission grants for agent tools. */
  grantsFile: string
  /** The activity log (JSON lines, newest events). */
  eventsFile: string
  /** The assistant's recent runs (model, tokens, outcome). */
  runsFile: string
  /** Agent cockpit sessions (Claude Code & co.): list + one transcript file each. */
  agentsDir: string
  /** Isolated git worktrees for agents working in parallel — visible, so nothing hides. */
  worktreesDir: string
  /** ~/Mindeck/logs — the desktop app's log files (rotated) and, under `crashes`, local crash reports. */
  logsDir: string
}

/** The home before the app was called Mindeck — used as it is until ~/Mindeck exists (moving it over is up to the user). */
const FORMER_HOME = 'W-ONE'

/**
 * Everything lives under ~/Mindeck: findable in Finder, the same for `npm run
 * dev` and the packaged app, and backed up by copying one folder. MINDECK_HOME
 * overrides the root (tests, or a custom location).
 */
export function mindeckPaths(home = homedir()): MindeckPaths {
  const current = join(home, 'Mindeck')
  const former = join(home, FORMER_HOME)
  const homeDir = process.env.MINDECK_HOME || (!existsSync(current) && existsSync(former) ? former : current)
  const dataDir = join(homeDir, 'data')
  return {
    homeDir,
    dataDir,
    settingsFile: join(dataDir, 'settings.json'),
    defaultVaultRoot: join(homeDir, 'vault'),
    devicesFile: join(dataDir, 'devices.json'),
    tlsDir: join(dataDir, 'tls'),
    secretsFile: join(dataDir, 'secrets.json'),
    cloudFile: join(dataDir, 'cloud.json'),
    grantsFile: join(dataDir, 'grants.json'),
    eventsFile: join(dataDir, 'events.jsonl'),
    runsFile: join(dataDir, 'runs.json'),
    agentsDir: join(dataDir, 'agents'),
    worktreesDir: join(homeDir, 'worktrees'),
    logsDir: join(homeDir, 'logs')
  }
}

/**
 * One-time copy of the old hidden data folder (Electron's userData, before
 * 2026-10-02 — only the desktop app ever had one) into ~/Mindeck/data. Copy, not
 * move: the original stays untouched as a backup (with a note pointing to the
 * new place). Runs before any service opens its files, so they are at rest.
 */
export function migrateLegacyData(paths: MindeckPaths, legacyDataDir: string): boolean {
  if (existsSync(paths.dataDir) || !existsSync(legacyDataDir)) return false
  mkdirSync(paths.homeDir, { recursive: true })
  cpSync(legacyDataDir, paths.dataDir, { recursive: true, errorOnExist: true })
  writeFileSync(
    join(legacyDataDir, 'MOVED-TO-Mindeck-DATA.txt'),
    `Mindeck now keeps its data in ${paths.dataDir}.\nThis folder is an untouched backup from before the move.\n`
  )
  return true
}
