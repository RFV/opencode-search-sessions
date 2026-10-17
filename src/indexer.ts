import type { Database } from "bun:sqlite"
import {
  clearIndex,
  deleteMessage,
  deleteMessagesNotIn,
  deleteSession,
  getSession,
  listIndexedSessionIDs,
  setMeta,
  stats,
  updateSessionLocation,
  updateSessionTitle,
  upsertMessageParts,
  upsertSession,
  type IndexStats,
  type SessionMeta,
} from "./db"
import { extractParts, messageHash, type ExtractOptions, type MessageLike } from "./extract"
import { log } from "./log"

export type SessionInfoLike = {
  id: string
  title?: string
  parentID?: string
  projectID: string
  time: { created: number; updated: number }
  location: { directory: string }
}

export type ClientLike = {
  session: {
    list(input?: Record<string, unknown>): Promise<{ data: SessionInfoLike[]; cursor?: { next?: string | null } }>
    get(input: { sessionID: string }): Promise<SessionInfoLike>
    message: {
      get(input: { sessionID: string; messageID: string }): Promise<MessageLike>
    }
  }
  message: {
    list(input: {
      sessionID: string
      limit?: number
      order?: "asc" | "desc"
      cursor?: string
    }): Promise<{ data: MessageLike[]; cursor?: { next?: string | null } }>
  }
}

export type EventLike = {
  type?: string
  data?: Record<string, unknown>
}

export type EventContextLike = {
  on(type: string, handler: (event: EventLike) => void): () => void
}

export type IndexerOptions = ExtractOptions & {
  includeSubagents: boolean
  debounceMs: number
  syncIntervalMs: number
}

export type IndexerStatus = {
  phase: "idle" | "catching-up" | "indexing" | "ready" | "error"
  sessions?: number
  messages?: number
  error?: string
}

export type Indexer = {
  start(): void
  stop(): Promise<void>
  catchUp(force?: boolean): Promise<void>
  rebuild(): Promise<void>
  flush(timeoutMs?: number): Promise<void>
  stats(): IndexStats
  isReady(): boolean
}

type IndexerInput = {
  db: Database
  client: ClientLike
  events: EventContextLike
  options: IndexerOptions
  onStatus?: (status: IndexerStatus) => void
}

type Task = { type: "session"; sessionID: string; full: boolean } | { type: "message"; sessionID: string; messageID: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function sessionMeta(session: SessionInfoLike): SessionMeta {
  return {
    id: session.id,
    title: session.title ?? null,
    directory: session.location?.directory ?? null,
    projectID: session.projectID ?? null,
    parentID: session.parentID ?? null,
    timeCreated: session.time?.created ?? 0,
    timeUpdated: session.time?.updated ?? 0,
  }
}

export function createIndexer(input: IndexerInput): Indexer {
  const { db, client, events, options, onStatus } = input

  let started = false
  let stopped = false
  let ready = false
  let draining = false
  let catchUpPromise: Promise<void> | undefined
  let syncTimer: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAt = 0

  const queue: Task[] = []
  const pendingMessages = new Map<string, { sessionID: string; timer: ReturnType<typeof setTimeout> }>()
  const pendingSessions = new Map<string, { full: boolean; timer: ReturnType<typeof setTimeout> }>()
  const unsubscribers: (() => void)[] = []

  function status(next: IndexerStatus) {
    try {
      onStatus?.(next)
    } catch {
      // Status reporting must never stop indexing.
    }
  }

  function includeSession(session: SessionInfoLike): boolean {
    return options.includeSubagents || !session.parentID
  }

  function enqueue(task: Task) {
    if (stopped) return
    queue.push(task)
    void drain()
  }

  function markMessage(sessionID: string, messageID: string) {
    if (stopped) return
    const previous = pendingMessages.get(messageID)
    if (previous) clearTimeout(previous.timer)
    const timer = setTimeout(() => {
      pendingMessages.delete(messageID)
      enqueue({ type: "message", sessionID, messageID })
    }, 250)
    pendingMessages.set(messageID, { sessionID, timer })
  }

  function markSession(sessionID: string, full = false) {
    if (stopped) return
    const previous = pendingSessions.get(sessionID)
    const nextFull = full || previous?.full === true
    if (previous) clearTimeout(previous.timer)
    const timer = setTimeout(() => {
      pendingSessions.delete(sessionID)
      enqueue({ type: "session", sessionID, full: nextFull })
    }, Math.max(100, options.debounceMs))
    pendingSessions.set(sessionID, { full: nextFull, timer })
  }

  function markCatchUp(delayMs = 1_000) {
    if (stopped) return
    const now = Date.now()
    const at = now + delayMs
    if (reconnectTimer && reconnectAt <= at) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectAt = at
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      reconnectAt = 0
      void catchUp().catch((error) => log("catch-up failed", error))
    }, delayMs)
  }

  async function listAllSessions(): Promise<SessionInfoLike[]> {
    const out: SessionInfoLike[] = []
    let page = await client.session.list({ limit: 50, order: "desc" })
    out.push(...page.data)
    while (page.cursor?.next && !stopped) {
      page = await client.session.list({ limit: 50, cursor: page.cursor.next })
      out.push(...page.data)
      if (out.length > 50_000) break
    }
    return out
  }

  async function listAllMessages(sessionID: string): Promise<MessageLike[]> {
    const out: MessageLike[] = []
    let page = await client.message.list({ sessionID, limit: 100, order: "desc" })
    out.push(...page.data)
    while (page.cursor?.next && !stopped) {
      page = await client.message.list({ sessionID, limit: 100, cursor: page.cursor.next })
      out.push(...page.data)
      if (out.length > 200_000) break
    }
    return out
  }

  function indexMessage(sessionID: string, message: MessageLike, provisional = false): boolean {
    const parts = extractParts(message, options)
    return upsertMessageParts(
      db,
      sessionID,
      {
        id: String(message.id),
        type: String(message.type),
        timeCreated: message.time?.created ?? 0,
        provisional,
      },
      parts,
    )
  }

  async function indexSession(session: SessionInfoLike, full: boolean): Promise<{ indexed: number; unchanged: number; deleted: number }> {
    if (!includeSession(session)) return { indexed: 0, unchanged: 0, deleted: 0 }
    upsertSession(db, sessionMeta(session))

    let indexed = 0
    let unchanged = 0
    let deleted = 0

    if (full) {
      const messages = await listAllMessages(session.id)
      const seen = new Set<string>()
      let failed = false
      for (const message of messages) {
        if (stopped) break
        seen.add(String(message.id))
        try {
          if (indexMessage(session.id, message)) indexed++
          else unchanged++
        } catch (error) {
          failed = true
          log("message index failed", session.id, message.id, error)
        }
      }
      // Never delete index rows from a partial scan. A stopped or failed scan
      // leaves the previous state in place; the next catch-up retries it.
      if (!stopped && !failed) deleted = deleteMessagesNotIn(db, session.id, seen)
    } else {
      // A live event should refer to the newest page. Do not scan the whole
      // history for a tail diff; full recovery uses full=true.
      const page = await client.message.list({ sessionID: session.id, limit: 50, order: "desc" })
      let changedSeen = false
      let unchangedRun = 0
      for (const message of page.data) {
        if (stopped) break
        let changed = false
        try {
          const parts = extractParts(message, options)
          const existing = db
            .query("SELECT content_hash FROM messages WHERE id = ?")
            .get(String(message.id)) as { content_hash?: string } | null
          if (existing && existing.content_hash === messageHash(parts)) {
            unchanged++
            unchangedRun++
            if (changedSeen && unchangedRun >= 10) break
            continue
          }
          changed = indexMessage(session.id, message)
        } catch (error) {
          log("message index failed", session.id, message.id, error)
        }
        if (changed) {
          indexed++
          changedSeen = true
          unchangedRun = 0
        }
      }
    }

    upsertSession(db, sessionMeta(session))
    if (indexed > 0 || deleted > 0) {
      log("session indexed", session.id, "messages=", indexed, "unchanged=", unchanged, "deleted=", deleted)
    }
    return { indexed, unchanged, deleted }
  }

  async function processMessage(task: Extract<Task, { type: "message" }>) {
    try {
      const session = await client.session.get({ sessionID: task.sessionID })
      if (!includeSession(session)) return
      upsertSession(db, sessionMeta(session))
      const message = await client.session.message.get({ sessionID: task.sessionID, messageID: task.messageID })
      const changed = indexMessage(task.sessionID, message)
      if (changed) log("message indexed", task.messageID)
    } catch (error) {
      log("message fetch failed", task.sessionID, task.messageID, error)
      markSession(task.sessionID, false)
    }
  }

  async function processSession(task: Extract<Task, { type: "session" }>) {
    try {
      const session = await client.session.get({ sessionID: task.sessionID })
      await indexSession(session, task.full)
    } catch (error) {
      log("session fetch failed", task.sessionID, error)
      if (/not found|404/i.test(String(error))) deleteSession(db, task.sessionID)
    }
  }

  async function drain() {
    if (draining || stopped) return
    draining = true
    status({ phase: "indexing" })
    try {
      while (!stopped && queue.length > 0) {
        const task = queue.shift()
        if (!task) break
        try {
          if (task.type === "message") await processMessage(task)
          else await processSession(task)
        } catch (error) {
          log("task failed", task.type, error)
          status({ phase: "error", error: error instanceof Error ? error.message : String(error) })
        }
        await sleep(0)
      }
    } finally {
      draining = false
      if (!stopped && queue.length > 0) void drain()
      else if (!stopped) status(ready ? { phase: "ready" } : { phase: "idle" })
    }
  }

  async function catchUp(force = false): Promise<void> {
    if (stopped) return
    if (catchUpPromise && !force) return catchUpPromise
    if (catchUpPromise && force) await catchUpPromise.catch(() => {})
    catchUpPromise = (async () => {
      status({ phase: "catching-up" })
      const sessions = await listAllSessions()
      const included = sessions.filter(includeSession)
      const seen = new Set(included.map((session) => session.id))
      let indexedSessions = 0
      let skippedSessions = 0
      let deletedSessions = 0

      for (const session of included) {
        if (stopped) break
        const existing = getSession(db, session.id)
        if (!force && existing && existing.time_updated >= session.time.updated) {
          skippedSessions++
          continue
        }
        try {
          const result = await indexSession(session, true)
          if (result.indexed > 0 || result.deleted > 0) indexedSessions++
        } catch (error) {
          log("session catch-up failed", session.id, error)
        }
      }

      for (const sessionID of listIndexedSessionIDs(db)) {
        if (stopped) break
        if (seen.has(sessionID)) continue
        try {
          const session = await client.session.get({ sessionID })
          if (!includeSession(session)) {
            deleteSession(db, sessionID)
            deletedSessions++
            continue
          }
          await indexSession(session, true)
        } catch (error) {
          if (/not found|404/i.test(String(error))) {
            deleteSession(db, sessionID)
            deletedSessions++
          } else {
            log("orphan check failed", sessionID, error)
          }
        }
      }

      setMeta(db, "last_scan_at", Date.now())
      ready = true
      log(
        "catch-up done",
        "sessions=",
        included.length,
        "indexed=",
        indexedSessions,
        "skipped=",
        skippedSessions,
        "deleted=",
        deletedSessions,
      )
      status({ phase: "ready", sessions: included.length })
    })()

    try {
      await catchUpPromise
    } finally {
      catchUpPromise = undefined
    }
  }

  function register(type: string, handler: (event: EventLike) => void) {
    try {
      unsubscribers.push(events.on(type, handler))
    } catch (error) {
      log("event subscribe failed", type, error)
    }
  }

  function start() {
    if (started) return
    started = true

    register("session.text.ended", (event) => {
      const data = event.data ?? {}
      markMessage(String(data.sessionID), String(data.assistantMessageID))
    })
    register("session.reasoning.ended", (event) => {
      if (!options.includeReasoning) return
      const data = event.data ?? {}
      markMessage(String(data.sessionID), String(data.assistantMessageID))
    })
    register("session.tool.success", (event) => {
      if (!options.includeToolInput && !options.includeToolOutput) return
      const data = event.data ?? {}
      markMessage(String(data.sessionID), String(data.assistantMessageID))
    })
    register("session.tool.failed", (event) => {
      if (!options.includeToolInput && !options.includeToolOutput) return
      const data = event.data ?? {}
      markMessage(String(data.sessionID), String(data.assistantMessageID))
    })
    register("session.inbox.enqueued", (event) => {
      const data = event.data ?? {}
      const item = data.item as
        | {
            type?: string
            time?: { created?: number }
            payload?: { text?: string }
          }
        | undefined
      const type = item?.type
      const text = item?.payload?.text
      if ((type !== "user" && type !== "synthetic") || typeof text !== "string" || !text.trim()) return
      const sessionID = String(data.sessionID)
      const inboxID = String(data.inboxID)
      try {
        const message = { id: inboxID, type, text, time: item?.time ?? { created: Date.now() } }
        const changed = upsertMessageParts(
          db,
          sessionID,
          { id: inboxID, type, timeCreated: message.time?.created ?? 0, provisional: true },
          extractParts(message, options),
        )
        if (changed) log("inbox indexed", inboxID, "session=", sessionID, "type=", type)
      } catch (error) {
        log("inbox index failed", inboxID, error)
        markSession(sessionID, false)
      }
    })
    register("session.inbox.delivered", (event) => {
      const data = event.data ?? {}
      markMessage(String(data.sessionID), String(data.inboxID))
    })
    register("session.inbox.cancelled", (event) => {
      const data = event.data ?? {}
      deleteMessage(db, String(data.inboxID))
    })
    register("session.execution.succeeded", (event) => {
      const data = event.data ?? {}
      markSession(String(data.sessionID), false)
    })
    register("session.execution.failed", (event) => {
      const data = event.data ?? {}
      markSession(String(data.sessionID), false)
    })
    register("session.execution.interrupted", (event) => {
      const data = event.data ?? {}
      markSession(String(data.sessionID), false)
    })
    register("session.created", (event) => {
      const data = event.data ?? {}
      markSession(String(data.sessionID), false)
    })
    register("session.renamed", (event) => {
      const data = event.data ?? {}
      updateSessionTitle(db, String(data.sessionID), String(data.title ?? ""))
    })
    register("session.moved", (event) => {
      const data = event.data ?? {}
      const location = (data.location ?? {}) as { directory?: string }
      updateSessionLocation(db, String(data.sessionID), {
        directory: location.directory ?? null,
        projectID: data.projectID ? String(data.projectID) : null,
      })
    })
    register("session.deleted", (event) => {
      const data = event.data ?? {}
      log("session.deleted event", data.sessionID)
      deleteSession(db, String(data.sessionID))
    })
    register("session.shell.ended", (event) => {
      if (!options.includeShell) return
      const data = event.data ?? {}
      markSession(String(data.sessionID), false)
    })
    register("session.compaction.ended", (event) => {
      const data = event.data ?? {}
      markSession(String(data.sessionID), false)
    })
    register("session.synthetic", (event) => {
      const data = event.data ?? {}
      markSession(String(data.sessionID), false)
    })
    register("session.skill.activated", (event) => {
      const data = event.data ?? {}
      markSession(String(data.sessionID), false)
    })
    register("session.revert.committed", (event) => {
      const data = event.data ?? {}
      markSession(String(data.sessionID), true)
    })
    register("session.forked", (event) => {
      const data = event.data ?? {}
      markSession(String(data.sessionID), true)
    })
    register("session.message.content.updated", (event) => {
      const data = event.data ?? {}
      markMessage(String(data.sessionID), String(data.messageID))
    })
    register("server.connected", () => {
      markCatchUp(1_000)
    })

    if (options.syncIntervalMs > 0) {
      syncTimer = setInterval(() => {
        void catchUp().catch((error) => log("periodic catch-up failed", error))
      }, options.syncIntervalMs)
    }

    void catchUp().catch((error) => {
      ready = false
      status({ phase: "error", error: error instanceof Error ? error.message : String(error) })
      log("initial catch-up failed", error)
    })
  }

  async function stop() {
    if (stopped) return
    stopped = true
    if (syncTimer) clearInterval(syncTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        // Ignore unsubscribe failures during unload.
      }
    }
    for (const item of pendingMessages.values()) clearTimeout(item.timer)
    for (const item of pendingSessions.values()) clearTimeout(item.timer)
    pendingMessages.clear()
    pendingSessions.clear()
    queue.length = 0
    await catchUpPromise?.catch(() => {})
    for (let i = 0; i < 100 && draining; i++) await sleep(50)
    try {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch {
      // The database may already be closed or busy during shutdown.
    }
    db.close()
    log("stopped")
  }

  async function flush(timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!draining && !catchUpPromise && queue.length === 0 && pendingMessages.size === 0 && pendingSessions.size === 0) {
        return
      }
      await sleep(50)
    }
  }

  async function rebuild() {
    clearIndex(db)
    ready = false
    await catchUp(true)
  }

  return {
    start,
    stop,
    catchUp,
    rebuild,
    flush,
    stats: () => stats(db),
    isReady: () => ready,
  }
}
