import { beforeEach, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { deleteMessagesNotIn, deleteSession, openIndex, upsertMessageParts, upsertSession } from "../src/db"
import { extractParts, type ExtractOptions } from "../src/extract"
import { parseQuery, search } from "../src/search"

const options: ExtractOptions = {
  includeToolInput: true,
  includeToolOutput: false,
  includeShell: false,
  includeReasoning: false,
  includeSystem: false,
}

function add(db: Database, sessionID: string, messageID: string, text: string, type = "user") {
  upsertMessageParts(
    db,
    sessionID,
    { id: messageID, type, timeCreated: 1 },
    extractParts({ id: messageID, type, text }, options),
  )
}

let db: Database

beforeEach(() => {
  db = openIndex(":memory:")
  upsertSession(db, {
    id: "s1",
    title: "Kitty keybinds",
    directory: "/home/rfv",
    projectID: "p1",
    timeCreated: 1,
    timeUpdated: 10,
  })
  upsertSession(db, {
    id: "s2",
    title: "RAG notes",
    directory: "/home/rfv/.lightrag",
    projectID: "p2",
    timeCreated: 1,
    timeUpdated: 20,
  })
  add(db, "s1", "m1", "How do I search OpenCode sessions with keybinds?")
  add(db, "s1", "m2", "The session list has a keybinds filter.")
  add(db, "s2", "m3", "Trounceflow retrieval and corpus notes.")
})

describe("parseQuery", () => {
  test("quotes tokens and adds prefix matching", () => {
    expect(parseQuery("keybinds kitty")).toBe('"keybinds"* AND "kitty"*')
  })

  test("keeps quoted phrases", () => {
    expect(parseQuery('"exact phrase" other')).toBe('"exact phrase" AND "other"*')
  })

  test("returns undefined for empty input", () => {
    expect(parseQuery("   ")).toBeUndefined()
  })
})

describe("search", () => {
  test("groups multiple matches into one session result", () => {
    const results = search(db, "keybinds")
    expect(results.map((result) => result.sessionID)).toEqual(["s1"])
    expect(results[0].hitCount).toBe(2)
    expect(results[0].title).toBe("Kitty keybinds")
    expect(results[0].snippet).toContain("keybinds")
  })

  test("supports prefix search", () => {
    const results = search(db, "keyb")
    expect(results[0].sessionID).toBe("s1")
  })

  test("searches across projects", () => {
    const results = search(db, "Trounceflow")
    expect(results[0].sessionID).toBe("s2")
  })

  test("returns no results for an unknown term", () => {
    expect(search(db, "zzzznotfound")).toHaveLength(0)
  })

  test("reflects part updates in FTS", () => {
    add(db, "s1", "m1", "completely different content")
    add(db, "s1", "m2", "no match here")
    expect(search(db, "keybinds").some((result) => result.sessionID === "s1")).toBe(false)
    expect(search(db, "different").some((result) => result.sessionID === "s1")).toBe(true)
  })

  test("removes session and FTS rows on delete", () => {
    deleteSession(db, "s1")
    expect(search(db, "keybinds")).toHaveLength(0)
  })

  test("removes messages not present in a full scan", () => {
    add(db, "s1", "m4", "temporary-message-token")
    expect(search(db, "temporary-message-token")).toHaveLength(1)
    expect(deleteMessagesNotIn(db, "s1", new Set(["m1", "m2"]))).toBe(1)
    expect(search(db, "temporary-message-token")).toHaveLength(0)
  })

  test("keeps provisional inbox messages until they are delivered", () => {
    const parts = extractParts({ id: "inbox1", type: "user", text: "queued-token" }, options)
    upsertMessageParts(
      db,
      "s1",
      { id: "inbox1", type: "user", timeCreated: 1, provisional: true },
      parts,
    )
    expect(search(db, "queued-token")).toHaveLength(1)
    expect(deleteMessagesNotIn(db, "s1", new Set(["m1", "m2"]))).toBe(0)
    expect(search(db, "queued-token")).toHaveLength(1)

    upsertMessageParts(
      db,
      "s1",
      { id: "inbox1", type: "user", timeCreated: 1, provisional: false },
      parts,
    )
    expect(deleteMessagesNotIn(db, "s1", new Set(["m1", "m2"]))).toBe(1)
    expect(search(db, "queued-token")).toHaveLength(0)
  })
})
