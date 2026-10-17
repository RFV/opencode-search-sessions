import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { messageHash, type ExtractedPart } from "./extract"

export const SCHEMA_VERSION = 2
export const EXTRACTOR_VERSION = 1

export type SessionMeta = {
  id: string
  title?: string | null
  directory?: string | null
  projectID?: string | null
  parentID?: string | null
  timeCreated?: number
  timeUpdated?: number
}

export type MessageMeta = {
  id: string
  type: string
  timeCreated?: number
  /** A queued inbox item that is not yet part of the persisted transcript. */
  provisional?: boolean
}

export type IndexStats = {
  sessions: number
  messages: number
  parts: number
  indexedChars: number
  lastScanAt: number
  lastIndexAt: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  directory TEXT,
  project_id TEXT,
  parent_id TEXT,
  time_created INTEGER NOT NULL DEFAULT 0,
  time_updated INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  part_count INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0,
  provisional INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);

CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY,
  part_key TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  time_created INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS parts_session_idx ON parts(session_id);
CREATE INDEX IF NOT EXISTS parts_message_idx ON parts(message_id);

CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
  text,
  content='parts',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3 4'
);

CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS parts_au AFTER UPDATE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO parts_fts(rowid, text) VALUES (new.id, new.text);
END;
`

function userVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null
  return Number(row?.user_version ?? 0)
}

function dropSchema(db: Database) {
  db.exec(`
    DROP TRIGGER IF EXISTS parts_ai;
    DROP TRIGGER IF EXISTS parts_ad;
    DROP TRIGGER IF EXISTS parts_au;
    DROP TABLE IF EXISTS parts_fts;
    DROP TABLE IF EXISTS parts;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS meta;
  `)
}

export function createSchema(db: Database) {
  const version = userVersion(db)
  if (version !== 0 && version !== SCHEMA_VERSION) dropSchema(db)
  db.exec(SCHEMA)
  db.run("PRAGMA user_version = " + SCHEMA_VERSION)
  db.query("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION))
  db.query("INSERT OR IGNORE INTO meta(key, value) VALUES('extractor_version', ?)").run(String(EXTRACTOR_VERSION))
  db.query("INSERT OR IGNORE INTO meta(key, value) VALUES('last_scan_at', '0')").run()
  db.query("INSERT OR IGNORE INTO meta(key, value) VALUES('last_index_at', '0')").run()
}

export function openIndex(path: string): Database {
  if (path !== ":memory:") {
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700)
    } catch {
      // Best-effort on filesystems that do not support modes.
    }
  }

  const db = new Database(path, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA temp_store = MEMORY")
  createSchema(db)

  const extractorVersion = Number(getMeta(db, "extractor_version") ?? EXTRACTOR_VERSION)
  if (extractorVersion !== EXTRACTOR_VERSION) {
    clearIndex(db)
    setMeta(db, "extractor_version", EXTRACTOR_VERSION)
  }

  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600)
    } catch {
      // Best-effort.
    }
  }
  return db
}

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | null
  return row?.value
}

export function setMeta(db: Database, key: string, value: string | number) {
  db.query("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    String(value),
  )
}

export function upsertSession(db: Database, session: SessionMeta) {
  const now = Date.now()
  db.query(
    `INSERT INTO sessions(id, title, directory, project_id, parent_id, time_created, time_updated, indexed_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = COALESCE(excluded.title, sessions.title),
       directory = COALESCE(excluded.directory, sessions.directory),
       project_id = COALESCE(excluded.project_id, sessions.project_id),
       parent_id = COALESCE(excluded.parent_id, sessions.parent_id),
       time_created = CASE WHEN excluded.time_created > 0 THEN excluded.time_created ELSE sessions.time_created END,
       time_updated = CASE WHEN excluded.time_updated > sessions.time_updated THEN excluded.time_updated ELSE sessions.time_updated END,
       indexed_at = excluded.indexed_at`,
  ).run(
    session.id,
    session.title ?? null,
    session.directory ?? null,
    session.projectID ?? null,
    session.parentID ?? null,
    session.timeCreated ?? 0,
    session.timeUpdated ?? 0,
    now,
  )
}

export function updateSessionTitle(db: Database, sessionID: string, title: string) {
  db.query("UPDATE sessions SET title = ?, indexed_at = ? WHERE id = ?").run(title, Date.now(), sessionID)
}

export function updateSessionLocation(
  db: Database,
  sessionID: string,
  location: { directory?: string | null; projectID?: string | null },
) {
  db.query("UPDATE sessions SET directory = ?, project_id = ?, indexed_at = ? WHERE id = ?").run(
    location.directory ?? null,
    location.projectID ?? null,
    Date.now(),
    sessionID,
  )
}

export function deleteSession(db: Database, sessionID: string) {
  db.query("DELETE FROM sessions WHERE id = ?").run(sessionID)
}

export function getSession(db: Database, sessionID: string) {
  return (db.query("SELECT * FROM sessions WHERE id = ?").get(sessionID) as
    | {
        id: string
        title: string | null
        directory: string | null
        project_id: string | null
        parent_id: string | null
        time_created: number
        time_updated: number
        indexed_at: number
      }
    | null) ?? null
}

export function listIndexedSessionIDs(db: Database): string[] {
  return (db.query("SELECT id FROM sessions").all() as { id: string }[]).map((row) => row.id)
}

export function deleteMessage(db: Database, messageID: string) {
  db.query("DELETE FROM messages WHERE id = ?").run(messageID)
}

export function upsertMessageParts(
  db: Database,
  sessionID: string,
  message: MessageMeta,
  parts: ExtractedPart[],
): boolean {
  const contentHash = messageHash(parts)
  const provisional = message.provisional ? 1 : 0
  const existing = db
    .query("SELECT content_hash, part_count, provisional FROM messages WHERE id = ?")
    .get(message.id) as { content_hash?: string; part_count?: number; provisional?: number } | null

  if (
    existing &&
    existing.content_hash === contentHash &&
    Number(existing.part_count ?? 0) === parts.length &&
    Number(existing.provisional ?? 0) === provisional
  ) {
    return false
  }

  const now = Date.now()
  const tx = db.transaction(() => {
    db.run("INSERT OR IGNORE INTO sessions(id, indexed_at) VALUES(?, ?)", [sessionID, now])
    // The session should already exist; the line above is only a guard against a missed metadata upsert.
    db.query(
      `INSERT INTO messages(id, session_id, type, content_hash, part_count, time_created, indexed_at, provisional)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         type = excluded.type,
         content_hash = excluded.content_hash,
         part_count = excluded.part_count,
         time_created = excluded.time_created,
         indexed_at = excluded.indexed_at,
         provisional = excluded.provisional`,
    ).run(message.id, sessionID, message.type, contentHash, parts.length, message.timeCreated ?? 0, now, provisional)

    const existingParts = db.query("SELECT part_key, hash FROM parts WHERE message_id = ?").all(message.id) as {
      part_key: string
      hash: string
    }[]
    const old = new Map(existingParts.map((part) => [part.part_key, part.hash]))
    const next = new Set<string>()

    for (const part of parts) {
      next.add(part.key)
      if (old.get(part.key) === part.hash) continue
      db.query(
        `INSERT INTO parts(part_key, message_id, session_id, kind, ordinal, text, hash, time_created)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(part_key) DO UPDATE SET
           message_id = excluded.message_id,
           session_id = excluded.session_id,
           kind = excluded.kind,
           ordinal = excluded.ordinal,
           text = excluded.text,
           hash = excluded.hash,
           time_created = excluded.time_created`,
      ).run(part.key, message.id, sessionID, part.kind, part.ordinal, part.text, part.hash, message.timeCreated ?? 0)
    }

    for (const key of old.keys()) {
      if (!next.has(key)) db.query("DELETE FROM parts WHERE part_key = ?").run(key)
    }

    db.query("UPDATE messages SET content_hash = ?, part_count = ?, indexed_at = ? WHERE id = ?").run(
      contentHash,
      parts.length,
      now,
      message.id,
    )
    setMeta(db, "last_index_at", now)
  })

  tx()
  return true
}

export function deleteMessagesNotIn(db: Database, sessionID: string, keep: Set<string>): number {
  const rows = db.query("SELECT id, provisional FROM messages WHERE session_id = ?").all(sessionID) as {
    id: string
    provisional: number
  }[]
  let deleted = 0
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (keep.has(row.id)) continue
      // Pending inbox items are not in the persisted message list yet. Keep
      // them until they are delivered or explicitly cancelled.
      if (Number(row.provisional ?? 0) === 1) continue
      db.query("DELETE FROM messages WHERE id = ?").run(row.id)
      deleted++
    }
  })
  tx()
  return deleted
}

export function stats(db: Database): IndexStats {
  const sessions = (db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number } | null)?.n ?? 0
  const messages = (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number } | null)?.n ?? 0
  const parts = (db.query("SELECT COUNT(*) AS n FROM parts").get() as { n: number } | null)?.n ?? 0
  const indexedChars =
    (db.query("SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM parts").get() as { n: number } | null)?.n ?? 0
  return {
    sessions,
    messages,
    parts,
    indexedChars,
    lastScanAt: Number(getMeta(db, "last_scan_at") ?? 0),
    lastIndexAt: Number(getMeta(db, "last_index_at") ?? 0),
  }
}

export function clearIndex(db: Database) {
  const tx = db.transaction(() => {
    db.run("DELETE FROM parts")
    db.run("DELETE FROM messages")
    db.run("DELETE FROM sessions")
    setMeta(db, "last_scan_at", 0)
    setMeta(db, "last_index_at", 0)
  })
  tx()
}
