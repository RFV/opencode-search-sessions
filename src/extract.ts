import { createHash } from "node:crypto"

export const MAX_PART_CHARS = 100_000

export type ExtractOptions = {
  includeToolInput: boolean
  includeToolOutput: boolean
  includeShell: boolean
  includeReasoning: boolean
  includeSystem: boolean
}

export type ExtractedPart = {
  key: string
  kind: string
  ordinal: number
  text: string
  hash: string
}

export type MessageLike = {
  id: string
  type: string
  time?: { created?: number }
  text?: string
  content?: unknown[]
  [key: string]: unknown
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/\u0000/g, "").trim()
  if (!text) return undefined
  return text.length > MAX_PART_CHARS ? text.slice(0, MAX_PART_CHARS) : text
}

function stable(value: unknown, depth = 0): unknown {
  if (value == null || typeof value !== "object") return value
  if (depth > 8) return "[…]"
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => stable(item, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stable((value as Record<string, unknown>)[key], depth + 1)
  }
  return out
}

function stringifyInput(value: unknown): string | undefined {
  if (value == null) return undefined
  try {
    return normalize(JSON.stringify(stable(value)))
  } catch {
    return undefined
  }
}

function contentText(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const text = normalize(value)
    return text ? [text] : []
  }
  const out: string[] = []
  for (const item of value) {
    if (item == null) continue
    if (typeof item === "string") {
      const text = normalize(item)
      if (text) out.push(text)
      continue
    }
    const record = item as Record<string, unknown>
    const text = normalize(record.text)
    if (text) {
      out.push(text)
      continue
    }
    // File content is referenced by path, never indexed as a blob.
    const file = normalize(record.path) ?? normalize(record.uri) ?? normalize(record.filename)
    if (file) out.push(file)
  }
  return out
}

function errorText(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === "string") return normalize(value)
  if (value instanceof Error) return normalize(value.message)
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const message = normalize(record.message)
    if (message) {
      const data = stringifyInput(record.data)
      return data ? `${message}\n${data}` : message
    }
    const data = stringifyInput(record.data)
    if (data) return data
  }
  return stringifyInput(value)
}

export function extractParts(message: MessageLike, options: ExtractOptions): ExtractedPart[] {
  const parts: ExtractedPart[] = []
  const messageID = String(message.id)

  const push = (kind: string, suffix: string | number, raw: unknown) => {
    const text = normalize(raw)
    if (!text) return
    parts.push({
      key: `${messageID}:${kind}:${suffix}`,
      kind,
      ordinal: typeof suffix === "number" ? suffix : parts.length,
      text,
      hash: hashText(text),
    })
  }

  const type = String(message.type)

  if (type === "user") {
    push("user", "user", message.text)
    return parts
  }

  if (type === "assistant") {
    const content = Array.isArray(message.content) ? message.content : []
    for (let index = 0; index < content.length; index++) {
      const item = content[index]
      if (item == null || typeof item !== "object") continue
      const part = item as Record<string, unknown>
      const partType = String(part.type ?? "")

      if (partType === "text") {
        push("text", index, part.text)
        continue
      }

      if (partType === "reasoning") {
        if (options.includeReasoning) push("reasoning", index, part.text)
        continue
      }

      if (partType === "tool") {
        const toolID = String(part.id ?? index)
        const state = (part.state ?? {}) as Record<string, unknown>

        if (options.includeToolInput) {
          const input = stringifyInput(state.input)
          if (input) push("tool-input", toolID, input)
        }

        if (options.includeToolOutput) {
          const output = contentText(state.content).join("\n")
          if (output) push("tool-output", toolID, output)
          const error = errorText(state.error)
          if (error) push("tool-error", toolID, error)
        }
      }
    }
    return parts
  }

  if (type === "synthetic") {
    push("synthetic", "synthetic", message.text)
    return parts
  }

  if (type === "system") {
    if (options.includeSystem) push("system", "system", message.text)
    return parts
  }

  if (type === "skill") {
    const text =
      normalize(message.text) ??
      normalize(message.content) ??
      normalize(message.name) ??
      normalize((message as Record<string, unknown>).description)
    if (text) push("skill", "skill", text)
    return parts
  }

  if (type === "shell") {
    if (!options.includeShell) return parts
    const command = normalize(message.command)
    const output = normalize((message.output as Record<string, unknown> | undefined)?.output)
    const text = [command, output].filter(Boolean).join("\n")
    if (text) push("shell", "shell", text)
    return parts
  }

  if (type === "compaction") {
    push("compaction", "summary", message.summary)
    push("compaction", "recent", message.recent)
    if (!message.summary) push("compaction", "text", message.text)
    return parts
  }

  return parts
}

export function messageHash(parts: ExtractedPart[]): string {
  const hash = createHash("sha256")
  for (const part of [...parts].sort((a, b) => a.key.localeCompare(b.key))) {
    hash.update(part.key).update("\u0000").update(part.hash).update("\u0000")
  }
  return hash.digest("hex")
}
