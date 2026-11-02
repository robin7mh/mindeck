import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { ProcessInfo, SystemSnapshot } from '@shared/types/system'

/**
 * Windows telemetry from ONE long-lived PowerShell.
 *
 * systeminformation starts a fresh powershell.exe for nearly every call (mem,
 * fsSize, networkStats, battery, processes). At the 1.5 s tick that meant
 * several PowerShell start-ups per second — each ~1 s of CPU, each scanned by
 * Defender — and the machine pegged at ~75 % CPU. Its persistent mode
 * (`powerShellStart`) hangs in `processes()`. So this loop pays the start-up
 * once and prints one JSON line per sample: total network bytes every time,
 * the top processes by CPU every `procEvery` samples.
 */
export const TOP_N = 6

interface RawSample {
  at: number
  rx: number
  tx: number
  procs?: Array<{ pid: number; name: string; cpu: number; mem: number }>
}

const r1 = (n: number) => Math.round(n * 10) / 10

export function samplerScript(parentPid: number, intervalMs: number, procEvery: number): string {
  // PowerShell, one statement per line; `exit` when the app is gone so a
  // crashed Electron never leaves an orphan looping in the background.
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$cores = [Environment]::ProcessorCount',
    '$prev = @{}; $prevAt = $null; $i = 0',
    'while ($true) {',
    `  if (-not (Get-Process -Id ${parentPid})) { exit }`,
    '  $rx = 0; $tx = 0',
    '  foreach ($a in Get-NetAdapterStatistics) { $rx += $a.ReceivedBytes; $tx += $a.SentBytes }',
    '  $out = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); rx = $rx; tx = $tx }',
    `  if ($i % ${procEvery} -eq 0) {`,
    '    $now = [DateTime]::UtcNow; $cur = @{}',
    '    $rows = foreach ($p in Get-Process) {',
    '      if ($p.Id -eq 0 -or $null -eq $p.CPU) { continue }',
    '      $cur[$p.Id] = $p.CPU',
    '      if ($prevAt -and $prev.ContainsKey($p.Id)) {',
    '        [pscustomobject]@{ pid = $p.Id; name = $p.ProcessName; cpu = ($p.CPU - $prev[$p.Id]) / ($now - $prevAt).TotalSeconds / $cores * 100; mem = $p.WorkingSet64 }',
    '      }',
    '    }',
    '    $prev = $cur; $prevAt = $now',
    `    $out.procs = @($rows | Sort-Object cpu -Descending | Select-Object -First ${TOP_N})`,
    '  }',
    '  $i++',
    '  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 3))',
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    '}'
  ].join('\n')
}

type Spawn = (cmd: string, args: string[], opts: object) => ChildProcess

export class WinSampler {
  private child: ChildProcess | null = null
  private buffer = ''
  private lastNet: { at: number; rx: number; tx: number } | undefined
  net: SystemSnapshot['net'] = { rxMbps: 0, txMbps: 0 }
  procs: ProcessInfo[] = []

  constructor(
    private readonly spawn: Spawn = nodeSpawn as unknown as Spawn,
    private readonly intervalMs = 1500,
    private readonly procEvery = 3
  ) {}

  get running(): boolean {
    return this.child !== null
  }

  /** Idempotent — also restarts a PowerShell that died. */
  start(): void {
    if (this.child) return
    const child = this.spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', samplerScript(process.pid, this.intervalMs, this.procEvery)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    this.child = child
    const stdout = child.stdout! // stdio 'pipe' → always there
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => this.onData(chunk))
    const gone = () => {
      if (this.child === child) this.reset()
    }
    child.on('exit', gone)
    child.on('error', gone)
  }

  stop(): void {
    this.child?.kill()
    this.reset()
  }

  private reset(): void {
    this.child = null
    this.buffer = ''
    this.lastNet = undefined
    this.net = { rxMbps: 0, txMbps: 0 }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() as string // split always yields ≥ 1 item: the unfinished line
    for (const line of lines) {
      let sample: RawSample
      try {
        sample = JSON.parse(line) as RawSample
      } catch {
        continue
      }
      this.apply(sample)
    }
  }

  private apply(s: RawSample): void {
    const prev = this.lastNet
    if (prev && s.at > prev.at) {
      const secs = (s.at - prev.at) / 1000
      // Counters reset when an adapter goes away — never report a negative rate.
      this.net = { rxMbps: r1(Math.max(0, s.rx - prev.rx) / secs / 1e6), txMbps: r1(Math.max(0, s.tx - prev.tx) / secs / 1e6) }
    }
    this.lastNet = { at: s.at, rx: s.rx, tx: s.tx }
    if (s.procs) {
      this.procs = s.procs.map((p) => ({ pid: p.pid, name: p.name, cpu: Math.max(0, r1(p.cpu)), mem: Math.round(p.mem / 1048576) }))
    }
  }
}
