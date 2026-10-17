import { afterEach, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { getSession, openIndex } from "../src/db"
import { createIndexer, type ClientLike, type EventContextLike, type SessionInfoLike } from "../src/indexer"
import type { MessageLike } from "../src/extract"
import { search } from "../src/search"

class FakeClient {
  sessions: SessionInfoLike[] = []
  messages = new Map<string, MessageLike[]>()

  session = {
    list: async () => ({ data: this.sessions, cursor: { next: null } }),
    get: async ({ sessionID }: { sessionID: string }) => {
      const session = this.sessions.find((item) => item.id === sessionID)
      if (!session) throw new Error("404 not found")
      return session
    },
    message: {
      get: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
        const message = this.messages.get(sessionID)?.find((item) => item.id === messageID)
        if (!message) throw new Error("404 not found")
        return message
      },
    },
  }

  message = {
    list: async ({ sessionID }: { sessionID: string }) => ({
      data: this.messages.get(sessionID) ?? [],
      cursor: { next: null },
    }),
  }
}

class FakeEvents {
  handlers = new Map<string, ((event: { type?: string; data?: Record<string, unknown> }) => void)[]>()

  on(type: string, handler: (event: { type?: string; data?: Record<string, unknown> }) => void) {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
    return () => {
      this.handlers.set(
        type,
        (this.handlers.get(type) ?? []).filter((item) => item !== handler),
      )
    }
  }

  emit(type: string, data: Record<string, unknown>) {
    for (const handler of this.handlers.get(type) ?? []) handler({ type, data })
  }
}

const options = {
  includeToolInput: true,
  includeToolOutput: false,
  includeShell: false,
  includeReasoning: false,
  includeSystem: false,
  includeSubagents: true,
  debounceMs: 10,
  syncIntervalMs: 0,
}

let db: Database
let indexer: ReturnType<typeof createIndexer> | undefined

function session(updated: number): SessionInfoLike {
  return {
    id: "s1",
    title: "Test session",
    projectID: "p1",
    time: { created: 1, updated },
    location: { directory: "/tmp/project" },
  }
}

afterEach(async () => {
  await indexer?.stop()
  indexer = undefined
})

describe("indexer", () => {
  test("catches up, updates one message, and deletes on event", async () => {
    const client = new FakeClient()
    const events = new FakeEvents()
    client.sessions = [session(10)]
    client.messages.set("s1", [{ id: "m1", type: "user", text: "alpha keybinds", time: { created: 1 } }])
    db = openIndex(":memory:")
    indexer = createIndexer({
      db,
      client: client as unknown as ClientLike,
      events: events as unknown as EventContextLike,
      options,
    })

    indexer.start()
    await indexer.flush(5_000)
    expect(indexer.isReady()).toBe(true)
    expect(indexer.stats()).toMatchObject({ sessions: 1, messages: 1, parts: 1 })
    expect(search(db, "keybinds")[0]?.sessionID).toBe("s1")

    const lastWrite = indexer.stats().lastIndexAt
    await indexer.catchUp()
    expect(indexer.stats().lastIndexAt).toBe(lastWrite)

    client.messages.get("s1")!.push({ id: "m2", type: "user", text: "unique-token-123", time: { created: 2 } })
    events.emit("session.inbox.delivered", { sessionID: "s1", inboxID: "m2" })
    await indexer.flush(5_000)
    expect(search(db, "unique-token-123")).toHaveLength(1)
    expect(indexer.stats().messages).toBe(2)

    client.messages.get("s1")![1] = {
      id: "m2",
      type: "user",
      text: "changed-token-456",
      time: { created: 2 },
    }
    events.emit("session.inbox.delivered", { sessionID: "s1", inboxID: "m2" })
    await indexer.flush(5_000)
    expect(search(db, "unique-token-123")).toHaveLength(0)
    expect(search(db, "changed-token-456")).toHaveLength(1)
    expect(indexer.stats().messages).toBe(2)

    client.messages.get("s1")!.push({
      id: "m3",
      type: "assistant",
      content: [{ type: "text", text: "tail-event-token" }],
      time: { created: 3 },
    })
    events.emit("session.execution.succeeded", { sessionID: "s1" })
    await indexer.flush(5_000)
    expect(search(db, "tail-event-token")).toHaveLength(1)

    events.emit("session.inbox.enqueued", {
      sessionID: "s1",
      inboxID: "inbox1",
      item: { type: "user", time: { created: 4 }, payload: { text: "queued-token-789" } },
    })
    await indexer.flush(2_000)
    expect(search(db, "queued-token-789")).toHaveLength(1)

    events.emit("session.inbox.cancelled", { sessionID: "s1", inboxID: "inbox1" })
    expect(search(db, "queued-token-789")).toHaveLength(0)

    events.emit("session.renamed", { sessionID: "s1", title: "Renamed session" })
    expect(getSession(db, "s1")?.title).toBe("Renamed session")

    client.sessions = []
    events.emit("session.deleted", { sessionID: "s1" })
    expect(indexer.stats().sessions).toBe(0)
  })

  test("does not index subagent sessions when disabled", async () => {
    const client = new FakeClient()
    const events = new FakeEvents()
    client.sessions = [{ ...session(10), parentID: "parent" }]
    client.messages.set("s1", [{ id: "m1", type: "user", text: "subagent content", time: { created: 1 } }])
    db = openIndex(":memory:")
    indexer = createIndexer({
      db,
      client: client as unknown as ClientLike,
      events: events as unknown as EventContextLike,
      options: { ...options, includeSubagents: false },
    })
    indexer.start()
    await indexer.flush(5_000)
    expect(indexer.stats().sessions).toBe(0)
  })
})
