// Structured system events — one envelope for everything that happens
// (architecture §10). Pure module (no DOM/Node/Electron) so it compiles
// under both tsconfigs.

import type { EntityRef } from './entity'

/** Grows additively as phases land (project.*, memory.*, agent.*, tool.*, …). */
export type MindeckEventType =
  | 'app.started'
  | 'agent.started'
  | 'agent.status.updated'
  | 'agent.completed'
  | 'agent.failed'
  | 'agent.cancelled'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.denied'
  | 'permission.requested'
  | 'permission.granted'
  | 'permission.denied'
  | 'session.started'
  | 'session.ended'
  | 'device.browser'
  | 'device.files'

/**
 * How an event is persisted. The bus distributes ALL events to subscribers;
 * it stores only per this class. Audit rows are append-only — the event store
 * exposes no update or delete methods for them.
 */
export type EventPersistence = 'ephemeral' | 'activity' | 'audit'

/**
 * Central catalog: every event type declares its persistence class exactly
 * once. Adding an event type without classifying it is a type error.
 */
export const EVENT_CATALOG: Record<MindeckEventType, EventPersistence> = {
  'app.started': 'activity',
  'agent.started': 'activity',
  'agent.status.updated': 'ephemeral',
  'agent.completed': 'activity',
  'agent.failed': 'activity',
  'agent.cancelled': 'activity',
  'tool.started': 'activity',
  'tool.completed': 'activity',
  'tool.failed': 'activity',
  'tool.denied': 'audit',
  'permission.requested': 'audit',
  'permission.granted': 'audit',
  'permission.denied': 'audit',
  'session.started': 'activity',
  'session.ended': 'activity',
  // What a paired device did with the desktop's browser and files: kept for good, shown on the desktop only.
  'device.browser': 'audit',
  'device.files': 'audit'
}

/** The payload of `device.browser` / `device.files` — what was done and where, never what was typed. */
export interface DeviceActivity {
  /** The device's name. */
  device: string
  /** browser: view, input, open, navigate, close, bookmark · files: download, upload, mkdir, rename, trash, restore, move, copy, undo, compress, extract */
  action: string
  /** The site (browser). */
  host?: string
  path?: string
  /** The first few paths of a batch (`count`: all of them). */
  paths?: string[]
  count?: number
  dest?: string
}

export interface MindeckEvent<T = unknown> {
  id: string
  type: MindeckEventType
  ts: string // ISO
  actor: { kind: 'user' | 'agent' | 'system' | 'device'; id?: string }
  /** Primary entity concerned, if any. */
  subject?: EntityRef
  /** Project scope, if any. */
  projectId?: string
  /** Assistant conversation this event belongs to, if any. */
  conversationId?: string
  /** JSON-serializable, type-specific detail. Never raw model reasoning. */
  payload: T
}
