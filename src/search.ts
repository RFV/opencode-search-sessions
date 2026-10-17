import type { Database } from "bun:sqlite"

export type SearchResult = {
  sessionID: string
  messageID: string
  kind: string
  snippet: string
  rank: number
  hitCount: number
  title: string | null
  directory: string | null
  projectID: string | null
  parentID: string | null
  timeUpdated: number
}

function quote(token: string): string {
  return `"${token.replaceAll('"', '""')}"`
}

/**
 * Turn user input into a conservative FTS5 query.
 * Every token is quoted, so FTS operators typed by the user are treated as text.
 * Quoted phrases stay phrases; ordinary tokens get prefix matching.
 */
export function parseQuery(input: string): string | undefined {
  const value = input.trim().slice(0, 400)
  if (!value) return undefined

  const terms: string[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) && terms.length < 20) {
    const phrase = match[1]
    const token = match[2]
    if (phrase !== undefined) {
      const trimmed = phrase.trim()
      if (trimmed) terms.push(quote(trimmed))
      continue
    }
    if (!token) continue
    const trimmed = token.trim()
    if (!trimmed) continue
    terms.push(`${quote(trimmed)}*`)
  }

  if (terms.length === 0) return undefined
  return terms.join(" AND ")
}

export function search(db: Database, input: string, limit = 30): SearchResult[] {
  const query = parseQuery(input)
  if (!query) return []
  const cappedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))

  const sql = `
    WITH hits AS (
      SELECT
        p.session_id,
        p.message_id,
        p.kind,
        p.time_created,
        snippet(parts_fts, 0, '', '', '…', 36) AS snippet,
        bm25(parts_fts) AS rank
      FROM parts_fts
      JOIN parts p ON p.id = parts_fts.rowid
      WHERE parts_fts MATCH ?
    ),
    ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY rank ASC, time_created DESC) AS rn,
        COUNT(*) OVER (PARTITION BY session_id) AS hit_count
      FROM hits
    )
    SELECT
      r.session_id AS sessionID,
      r.message_id AS messageID,
      r.kind AS kind,
      r.snippet AS snippet,
      r.rank AS rank,
      r.hit_count AS hitCount,
      s.title AS title,
      s.directory AS directory,
      s.project_id AS projectID,
      s.parent_id AS parentID,
      s.time_updated AS timeUpdated
    FROM ranked r
    JOIN sessions s ON s.id = r.session_id
    WHERE r.rn = 1
    ORDER BY r.rank ASC, s.time_updated DESC
    LIMIT ?
  `

  try {
    return db.query(sql).all(query, cappedLimit) as SearchResult[]
  } catch (error) {
    throw new Error(`Invalid search query: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function oneLine(value: string, max = 220): string {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}
