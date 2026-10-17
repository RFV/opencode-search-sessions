# Security

## Reporting

Please report suspected security issues privately through GitHub's
**Security → Advisories → Report a vulnerability** flow for this repository.
Do not open a public issue for a vulnerability.

Do not include real session content, credentials, or personal data in a report.
Redact logs before sharing them.

## Data handling

`opencode-search-sessions` reads local OpenCode session history and stores a
local SQLite FTS5 index. It does not include telemetry or make external network
requests; it only communicates with the configured OpenCode server through the
OpenCode client.

The index contains conversation text. The default index directory is
`~/.local/share/opencode/session-search` with mode `0700`; the main database is
mode `0600`. Tool input indexing is enabled by default and may capture sensitive
arguments. Set `includeToolInput: false` if that is not acceptable for your
environment.

Delete the index at any time:

```bash
rm -rf ~/.local/share/opencode/session-search
```
