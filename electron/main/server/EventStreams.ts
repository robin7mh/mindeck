import { randomUUID } from 'node:crypto'

/**
 * How much of a device's events the core keeps for a reconnect: enough for
 * a phone that went into standby or switched Wi-Fi, never more than these.
 */
export interface ReplayLimits {
  /** Events per device at most. */
  maxEvents: number
  /** Their size (JSON) per device at most — a terminal can print megabytes. */
  maxBytes: number
  /** How long an event is kept, and a device's stream after its last connection closed. */
  maxAgeMs: number
  /** Devices whose streams are kept at most (the ones gone longest give way). */
  maxDevices: number
}

export const REPLAY_LIMITS: ReplayLimits = {
  maxEvents: 5000,
  maxBytes: 2 * 1024 * 1024,
  maxAgeMs: 5 * 60_000,
  maxDevices: 32
}

interface Entry {
  seq: number
  message: string
  at: number
}

/**
 * One device's events, numbered: `seq` counts what this device was sent (or
 * would have been, while it was away) — exactly the events it may see. The
 * stream's `id` changes whenever its numbering starts over (a new core, a
 * device that was gone too long): a `seq` means something only with its id.
 */
export class DeviceStream {
  readonly id = randomUUID()
  seq = 0
  /** When a client of this device was last connected. */
  seen: number
  private entries: Entry[] = []
  private bytes = 0

  constructor(
    private readonly limits: ReplayLimits,
    now: number
  ) {
    this.seen = now
  }

  /** The next event for this device: kept for a reconnect, returned as the message to send (`body` + its `seq`). */
  record(body: string, now: number): string {
    this.seq += 1
    // `{"channel":…,"payload":…}` → `{…,"seq":7}`: the payload is serialized once for every device.
    const message = `${body.slice(0, -1)},"seq":${this.seq}}`
    this.entries.push({ seq: this.seq, message, at: now })
    this.bytes += message.length
    this.trim(now)
    return message
  }

  /** What a client that saw everything up to `since` (of stream `id`) missed — null when it can't be told any more. */
  after(id: string, since: number, now: number): string[] | null {
    if (id !== this.id || since > this.seq) return null
    this.trim(now)
    const first = this.entries[0]?.seq ?? this.seq + 1
    if (since + 1 < first) return null
    return this.entries.filter((e) => e.seq > since).map((e) => e.message)
  }

  /** Forget what was kept (the numbering goes on): a client that missed any of it has to resync. */
  clear(): void {
    this.entries = []
    this.bytes = 0
  }

  /** Events kept now (tests). */
  get size(): number {
    return this.entries.length
  }

  private trim(now: number): void {
    const { maxEvents, maxBytes, maxAgeMs } = this.limits
    let drop = 0
    while (drop < this.entries.length && (this.entries.length - drop > maxEvents || this.bytes > maxBytes || now - this.entries[drop].at > maxAgeMs)) {
      this.bytes -= this.entries[drop].message.length
      drop += 1
    }
    if (drop) this.entries = this.entries.slice(drop)
  }
}

/** The streams of the devices connected now or a moment ago. */
export class EventStreams {
  private readonly streams = new Map<string, DeviceStream>()

  constructor(private readonly limits: ReplayLimits = REPLAY_LIMITS) {}

  /** A device connects: its stream, kept on from before or a new one. */
  open(deviceId: string, now: number): DeviceStream {
    let stream = this.streams.get(deviceId)
    if (!stream) {
      stream = new DeviceStream(this.limits, now)
      this.streams.set(deviceId, stream)
    }
    stream.seen = now
    return stream
  }

  get(deviceId: string): DeviceStream | undefined {
    return this.streams.get(deviceId)
  }

  entries(): IterableIterator<[string, DeviceStream]> {
    return this.streams.entries()
  }

  get size(): number {
    return this.streams.size
  }

  /** A removed device's events go with it. */
  drop(deviceId: string): void {
    this.streams.delete(deviceId)
  }

  /** Forget every kept event (what a device may see changed, or events were lost): a reconnect then resyncs. */
  clear(): void {
    for (const stream of this.streams.values()) stream.clear()
  }

  /**
   * Streams of devices gone longer than an event is kept are forgotten (a
   * later connection starts a new one); past `maxDevices` the ones gone
   * longest give way. `connected` devices are never touched.
   */
  prune(now: number, connected: Set<string>): void {
    for (const [deviceId, stream] of this.streams) {
      if (!connected.has(deviceId) && now - stream.seen > this.limits.maxAgeMs) this.streams.delete(deviceId)
    }
    const away = [...this.streams].filter(([id]) => !connected.has(id)).sort((a, b) => a[1].seen - b[1].seen)
    while (this.streams.size > this.limits.maxDevices && away.length) this.streams.delete(away.shift()![0])
  }
}
