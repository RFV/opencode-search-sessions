import { describe, expect, test } from "bun:test"
import { extractParts, messageHash, type ExtractOptions } from "../src/extract"

const base: ExtractOptions = {
  includeToolInput: true,
  includeToolOutput: false,
  includeShell: false,
  includeReasoning: false,
  includeSystem: false,
}

describe("extractParts", () => {
  test("indexes user prompts", () => {
    const parts = extractParts({ id: "m1", type: "user", text: "hello world" }, base)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ key: "m1:user:user", kind: "user", text: "hello world" })
  })

  test("indexes assistant text and skips reasoning by default", () => {
    const parts = extractParts(
      {
        id: "m2",
        type: "assistant",
        content: [
          { type: "reasoning", text: "private thinking" },
          { type: "text", text: "public answer" },
        ],
      },
      base,
    )
    expect(parts.map((part) => part.kind)).toEqual(["text"])
    expect(parts[0].text).toBe("public answer")
  })

  test("can include reasoning", () => {
    const parts = extractParts(
      {
        id: "m3",
        type: "assistant",
        content: [{ type: "reasoning", text: "thinking" }],
      },
      { ...base, includeReasoning: true },
    )
    expect(parts[0].kind).toBe("reasoning")
  })

  test("indexes tool input but not output by default", () => {
    const message = {
      id: "m4",
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "tool-1",
          name: "grep",
          state: {
            status: "completed",
            input: { pattern: "needle", path: "/tmp" },
            content: [{ type: "text", text: "needle found" }],
          },
        },
      ],
    }
    const parts = extractParts(message, base)
    expect(parts.map((part) => part.kind)).toEqual(["tool-input"])
    expect(parts[0].text).toContain("needle")

    const withOutput = extractParts(message, { ...base, includeToolOutput: true })
    expect(withOutput.map((part) => part.kind)).toEqual(["tool-input", "tool-output"])
    expect(withOutput[1].text).toBe("needle found")
  })

  test("does not index shell output unless enabled", () => {
    const message = {
      id: "m5",
      type: "shell",
      command: "echo hello",
      output: { output: "hello\n" },
    }
    expect(extractParts(message, base)).toHaveLength(0)
    const parts = extractParts(message, { ...base, includeShell: true })
    expect(parts[0].text).toContain("echo hello")
    expect(parts[0].text).toContain("hello")
  })

  test("indexes compaction summary and recent context", () => {
    const parts = extractParts(
      { id: "m6", type: "compaction", summary: "summary text", recent: "recent text" },
      base,
    )
    expect(parts.map((part) => part.kind)).toEqual(["compaction", "compaction"])
    expect(parts.map((part) => part.text)).toEqual(["summary text", "recent text"])
  })

  test("message hash is stable regardless of part order", () => {
    const a = extractParts(
      {
        id: "m7",
        type: "assistant",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
      base,
    )
    const b = [...a].reverse()
    expect(messageHash(a)).toBe(messageHash(b))
  })
})
