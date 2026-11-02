import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { samplerScript, WinSampler } from '../../../electron/main/services/system/winSampler'

/** A stand-in for the PowerShell child: stdout is an emitter we write lines into. */
function fakeChild() {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  const child = Object.assign(new EventEmitter(), { stdout, kill: vi.fn() })
  return child
}

function setup() {
  const children: ReturnType<typeof fakeChild>[] = []
  const spawn = vi.fn(() => {
    const c = fakeChild()
    children.push(c)
    return c as never
  })
  const s = new WinSampler(spawn, 1000, 3)
  const emit = (data: string, i = children.length - 1) => children[i].stdout.emit('data', data)
  return { s, spawn, children, emit }
}

describe('samplerScript', () => {
  it('loops at the interval, exits with the app and samples processes every Nth round', () => {
    const script = samplerScript(4321, 1500, 3)
    expect(script).toContain('Get-Process -Id 4321')
    expect(script).toContain('Start-Sleep -Milliseconds 1500')
    expect(script).toContain('$i % 3 -eq 0')
    expect(script).toContain('Select-Object -First 6')
  })
})

describe('WinSampler', () => {
  it('starts one hidden PowerShell, idempotently', () => {
    const { s, spawn } = setup()
    expect(s.running).toBe(false)
    s.start()
    s.start()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]).toEqual([
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-Command']),
      expect.objectContaining({ windowsHide: true })
    ])
    expect(s.running).toBe(true)
  })

  it('turns byte counters into MB/s and parses process rows, across split chunks', () => {
    const { s, emit } = setup()
    s.start()
    emit('{"at":1000,"rx":0,"tx":0,"procs":[{"pid":1,"name":"Code","cpu":12.345,"mem":104857600},{"pid":2,"name":"x","cpu":-0.01,"mem":0}]}\n')
    expect(s.net).toEqual({ rxMbps: 0, txMbps: 0 }) // a rate needs two samples
    expect(s.procs).toEqual([
      { pid: 1, name: 'Code', cpu: 12.3, mem: 100 },
      { pid: 2, name: 'x', cpu: 0, mem: 0 }
    ])
    emit('{"at":3000,"rx":4000000,')
    emit('"tx":1000000}\nnot json\n')
    expect(s.net).toEqual({ rxMbps: 2, txMbps: 0.5 })
    expect(s.procs[0].pid).toBe(1) // rounds without procs keep the last list
  })

  it('never reports a negative or divide-by-zero rate', () => {
    const { s, emit } = setup()
    s.start()
    emit('{"at":1000,"rx":5000000,"tx":5000000}\n')
    emit('{"at":1000,"rx":9000000,"tx":9000000}\n') // same timestamp: ignored
    expect(s.net).toEqual({ rxMbps: 0, txMbps: 0 })
    emit('{"at":2000,"rx":1000,"tx":1000}\n') // counters reset (adapter gone)
    expect(s.net).toEqual({ rxMbps: 0, txMbps: 0 })
  })

  it('stop kills the child and clears the rates; a dead child is restarted on the next start', () => {
    const { s, spawn, children, emit } = setup()
    s.start()
    emit('{"at":1000,"rx":0,"tx":0}\n{"at":2000,"rx":1000000,"tx":0}\n')
    expect(s.net.rxMbps).toBe(1)
    s.stop()
    expect(children[0].kill).toHaveBeenCalled()
    expect(s.running).toBe(false)
    expect(s.net).toEqual({ rxMbps: 0, txMbps: 0 })
    s.stop() // safe without a child

    s.start()
    children[1].emit('exit', 1)
    expect(s.running).toBe(false)
    s.start()
    children[2].emit('error', new Error('no powershell'))
    expect(s.running).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(3)

    // A late exit from an old child must not tear down the current one.
    s.start()
    children[0].emit('exit', 0)
    expect(s.running).toBe(true)
  })

  it('defaults to the real spawn', () => {
    expect(new WinSampler().running).toBe(false)
  })
})
