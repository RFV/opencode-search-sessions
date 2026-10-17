import { Plugin } from "@opencode/plugin/tui"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import { openIndex, stats } from "./db"
import { createIndexer, type ClientLike, type EventContextLike, type IndexerStatus } from "./indexer"
import { oneLine, search } from "./search"
import { log, logPath } from "./log"

type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

function boolOption(context: TuiContext, key: string, fallback: boolean): boolean {
  const value = context.options?.[key]
  return typeof value === "boolean" ? value : fallback
}

function numberOption(context: TuiContext, key: string, fallback: number): number {
  const value = context.options?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function stringOption(context: TuiContext, key: string, fallback: string): string {
  const value = context.options?.[key]
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return "unknown time"
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "never"
  return new Date(timestamp).toLocaleString()
}

function formatCount(value: number): string {
  return value.toLocaleString()
}

export default Plugin.define({
  id: "opencode-search-sessions",
  async setup(context) {
    const options = {
      includeToolInput: boolOption(context, "includeToolInput", true),
      includeToolOutput: boolOption(context, "includeToolOutput", false),
      includeShell: boolOption(context, "includeShell", false),
      includeReasoning: boolOption(context, "includeReasoning", false),
      includeSystem: boolOption(context, "includeSystem", false),
      includeSubagents: boolOption(context, "includeSubagents", true),
      debounceMs: numberOption(context, "debounceMs", 750),
      syncIntervalMs: numberOption(context, "syncIntervalMs", 300_000),
    }
    const maxResults = Math.max(1, Math.min(100, numberOption(context, "maxResults", 30)))
    const keybind = stringOption(context, "keybind", "<leader>f")

    const dataRoot = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
    const defaultPath = join(dataRoot, "opencode", "session-search", "index.sqlite")
    const dbPath = stringOption(context, "dbPath", process.env.OPENCODE_SESSION_SEARCH_DB ?? defaultPath)

    let db: ReturnType<typeof openIndex> | undefined
    let setupError: string | undefined
    try {
      db = openIndex(dbPath)
    } catch (error) {
      setupError = error instanceof Error ? error.message : String(error)
      log("index open failed", dbPath, setupError)
    }

    const firstBuild = db ? stats(db).sessions === 0 : false
    let announcedReady = !firstBuild
    let lastError = ""

    function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
      context.ui.toast.show({ title: "Session search", message, variant, duration: 4000 })
    }

    const indexer = db
      ? createIndexer({
          db,
          client: context.client as unknown as ClientLike,
          events: context.data as unknown as EventContextLike,
          options,
          onStatus(status: IndexerStatus) {
            if (status.phase === "ready" && !announcedReady) {
              announcedReady = true
              toast(`Indexed ${formatCount(status.sessions ?? 0)} sessions`, "success")
            }
            if (status.phase === "error" && status.error && status.error !== lastError) {
              lastError = status.error
              toast(status.error, "error")
            }
          },
        })
      : undefined

    if (!db) {
      toast(`Index unavailable: ${setupError ?? "unknown error"}`, "error")
    } else if (indexer) {
      if (firstBuild) toast("Building the session index…")
      indexer.start()
    }

    async function openSearch(input?: string) {
      if (!db || !indexer) {
        toast(`Index unavailable: ${setupError ?? "unknown error"}`, "error")
        return
      }

      let query = (input ?? "").trim()
      if (!query) {
        query =
          (
            await context.ui.dialog.prompt({
              title: "Search sessions",
              description: "Search prompts, replies, and summaries across all OpenCode sessions.",
              placeholder: 'words or "exact phrase"',
            })
          )?.trim() ?? ""
      }
      if (!query) return

      await indexer.flush(1_000)

      let results: ReturnType<typeof search>
      try {
        results = search(db, query, maxResults)
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error")
        return
      }

      if (results.length === 0) {
        toast(`No matches for “${query}”`, "warning")
        return
      }

      const picked = await context.ui.dialog.select({
        title: `Sessions matching “${query}”`,
        placeholder: "filter results",
        options: results.map((result) => {
          const project = (
            result.projectID ? context.data.project.get(result.projectID) : undefined
          ) as { name?: string; canonical?: string } | undefined
          const category =
            project?.name ??
            (project?.canonical ? basename(project.canonical) : undefined) ??
            (result.directory ? basename(result.directory) : "Other")
          return {
            title: result.title || "Untitled session",
            description: oneLine(result.snippet),
            footer: `${formatCount(result.hitCount)} match${result.hitCount === 1 ? "" : "es"} · ${relativeTime(
              result.timeUpdated,
            )}${result.parentID ? " · subagent" : ""}`,
            category,
            value: result.sessionID,
          }
        }),
      })

      if (picked) context.ui.router.navigate({ type: "session", sessionID: picked })
    }

    async function showStats() {
      if (!db) {
        await context.ui.dialog.alert({
          title: "Session search",
          message: `Index unavailable.\n\n${setupError ?? "Unknown error"}\n\nLog: ${logPath}`,
        })
        return
      }
      const info = stats(db)
      await context.ui.dialog.alert({
        title: "Session search index",
        message: [
          `Sessions: ${formatCount(info.sessions)}`,
          `Messages: ${formatCount(info.messages)}`,
          `Parts: ${formatCount(info.parts)}`,
          `Indexed text: ${formatCount(info.indexedChars)} chars`,
          `Last scan: ${formatDate(info.lastScanAt)}`,
          `Last write: ${formatDate(info.lastIndexAt)}`,
          `Database: ${dbPath}`,
          `Log: ${logPath}`,
        ].join("\n"),
      })
    }

    async function syncNow() {
      if (!indexer) {
        toast(`Index unavailable: ${setupError ?? "unknown error"}`, "error")
        return
      }
      toast("Syncing the session index…")
      try {
        await indexer.catchUp()
        const info = indexer.stats()
        toast(`Synced: ${formatCount(info.sessions)} sessions, ${formatCount(info.messages)} messages`, "success")
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error")
      }
    }

    async function rebuildIndex() {
      if (!indexer) {
        toast(`Index unavailable: ${setupError ?? "unknown error"}`, "error")
        return
      }
      const confirmed = await context.ui.dialog.confirm({
        title: "Rebuild session index?",
        message: "This deletes the local search index and rebuilds it from OpenCode session history.",
        label: { confirm: "Rebuild", cancel: "Cancel" },
      })
      if (!confirmed) return
      toast("Rebuilding the session index…")
      try {
        await indexer.rebuild()
        const info = indexer.stats()
        toast(`Rebuilt: ${formatCount(info.sessions)} sessions, ${formatCount(info.messages)} messages`, "success")
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error")
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "session-search.open",
          title: "Search session content",
          description: "Full-text search across all OpenCode sessions",
          group: "Session",
          bind: keybind,
          palette: true,
          slash: { name: "search-sessions", aliases: ["find"], arguments: true },
          run: (input) => openSearch(input),
        },
        {
          id: "session-search.stats",
          title: "Session search index stats",
          description: "Show index size, counts, and last sync",
          group: "Session",
          palette: true,
          run: () => showStats(),
        },
        {
          id: "session-search.sync",
          title: "Sync session search index",
          description: "Check for changed sessions now",
          group: "Session",
          palette: true,
          run: () => syncNow(),
        },
        {
          id: "session-search.rebuild",
          title: "Rebuild session search index",
          description: "Delete and rebuild the local index",
          group: "Session",
          palette: true,
          run: () => rebuildIndex(),
        },
      ],
      bindings: ["session-search.open"],
    }))

    log("setup", "db=", dbPath, "options=", JSON.stringify(options), "keybind=", keybind)

    return () => indexer?.stop()
  },
})
