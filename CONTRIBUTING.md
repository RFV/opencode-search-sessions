# Contributing

Thanks for helping improve `opencode-search-sessions`.

## Development

```bash
bun install
bun test
bun run typecheck
```

The plugin runs inside OpenCode's TUI process. To try a local checkout, add its
absolute path to `opencode.json` or `cli.json` and restart the TUI:

```json
{
  "plugins": ["/absolute/path/to/opencode-search-sessions"]
}
```

## Guidelines

- Keep the index incremental. Do not add code paths that re-index unchanged sessions, messages, or parts.
- Never log message text, tool output, or other session content. Logs should contain counts, IDs, and errors only.
- Add tests for extraction, SQL/FTS behavior, and indexer changes.
- Preserve the default privacy posture: tool outputs, shell output, reasoning, and system messages stay off by default.
- Keep the plugin compatible with OpenCode V2 (`@opencode/plugin`), not V1 (`@opencode-ai/plugin`).
- Update `CHANGELOG.md` for user-visible changes.

## Pull requests

- Describe the change and why it is needed.
- Include test output and the OpenCode/Bun versions you tested with.
- Do not include real session data, API keys, or personal paths in tests or screenshots.

## Reporting bugs

Use the issue template and include:

- OpenCode version (`opencode --version`)
- plugin version
- OS and terminal
- steps to reproduce
- relevant log lines from `/tmp/opencode/session-search.log` with content redacted
