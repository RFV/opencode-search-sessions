import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const LOG_DIR = join(tmpdir(), "opencode")
const LOG_FILE = join(LOG_DIR, "session-search.log")
const MAX_LOG_BYTES = 2_000_000

function ensureLogFile() {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (statSync(LOG_FILE).size > MAX_LOG_BYTES) truncateSync(LOG_FILE, 0)
    } catch {
      // File does not exist yet.
    }
  } catch {
    // Logging must never break the plugin.
  }
}

function stringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || value == null) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function log(...parts: unknown[]) {
  ensureLogFile()
  const line = `${new Date().toISOString()} ${parts.map(stringify).join(" ")}`
  try {
    appendFileSync(LOG_FILE, line + "\n")
  } catch {
    // Best-effort only.
  }
}

export const logPath = LOG_FILE
