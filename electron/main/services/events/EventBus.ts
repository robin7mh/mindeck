import { randomUUID } from 'node:crypto'
import {
  EVENT_CATALOG,
  type EventPersistence,
  type MindeckEvent,
  type MindeckEventType
} from '@shared/types/events'
import type { EntityRef } from '@shared/types/entity'

/**
 * Where non-ephemeral events are stored (EventLog: memory ring + a JSON-lines
 * file in the data folder, catalog-driven, append-only).
 */
export interface EventSink {
  persist(event: MindeckEvent, cls: Exclude<EventPersistence, 'ephemeral'>): void
}

export class NoopEventSink implements EventSink {
  persist(): void {}
}

export interface EmitInput<T> {
  actor?: MindeckEvent['actor']
  subject?: EntityRef
  projectId?: string
  conversationId?: string
  payload?: T
}

type Listener = (event: MindeckEvent) => void

/**
 * In-main pub/sub for structured MindeckEvents (architecture §10). Distributes
 * every event to subscribers; persists only per the central EVENT_CATALOG
 * class. An optional broadcast hook forwards events to the renderer once a
 * push channel exists in the IPC contract (none yet in P2A).
 */
export class EventBus {
  private readonly listeners = new Map<MindeckEventType | '*', Set<Listener>>()

  constructor(
    private readonly opts: {
      sink: EventSink
      broadcast?: (event: MindeckEvent) => void
    }
  ) {}

  emit<T = unknown>(type: MindeckEventType, input: EmitInput<T> = {}): MindeckEvent<T> {
    const event: MindeckEvent<T> = {
      id: randomUUID(),
      type,
      ts: new Date().toISOString(),
      actor: input.actor ?? { kind: 'system' },
      subject: input.subject,
      projectId: input.projectId,
      conversationId: input.conversationId,
      payload: (input.payload ?? {}) as T
    }

    for (const key of [type, '*'] as const) {
      for (const listener of this.listeners.get(key) ?? []) {
        try {
          listener(event)
        } catch (err) {
          console.error(`[events] listener for ${type} failed`, err)
        }
      }
    }

    const cls = EVENT_CATALOG[type]
    if (cls !== 'ephemeral') {
      try {
        this.opts.sink.persist(event, cls)
      } catch (err) {
        console.error(`[events] persisting ${type} failed`, err)
      }
    }

    this.opts.broadcast?.(event)
    return event
  }

  subscribe(type: MindeckEventType | '*', listener: Listener): () => void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
    return () => set.delete(listener)
  }
}
