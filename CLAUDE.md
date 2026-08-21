# claude-signal

MCP channel plugin that bridges Signal Messenger DMs into a Claude Code
session via signal-cli's JSON-RPC daemon. Sibling of `claude-synochat`;
the channel-protocol shape is identical, only the transport changes.

## What this is

- Stdio MCP server, declares `claude/channel` + `claude/channel/permission`.
- Keeps a persistent Unix-socket connection to signal-cli.
- Emits inbound DMs as `notifications/claude/channel`, forwards outbound
  replies via `send`/`sendReaction`/`sendTyping`/`sendReceipt`.
- DMs only. Group messages are dropped before the sink ever sees them.
- Single-user-ish: one `SIGNAL_DEFAULT_RECIPIENT`, a whitelist of allowed
  senders, `lastRecipient` tracked in-memory.

## Outbound markdown is rendered, not shipped as syntax

Two stages, both in `server.ts` and both exported:

- `parseMarkdownStyles` is the character level — `**bold**`, `*italic*`,
  `` `mono` ``, `~~strike~~`, `||spoiler||`, fenced code — turned into Signal's
  `textStyles` ranges.
- `transformBlocks` is the line level, added 2026-08-21 after a specialist's
  answer arrived with its hashes and its pipe art intact. A heading becomes a
  bold line without its hashes, `- item` becomes `• item`, `[text](url)`
  becomes `text (url)`, and a table loses its dashed separator row and is
  monospaced whole, its pipes replaced by spaces that pad each column to its
  widest cell. Fenced code is passed through: inside it the syntax is the
  content.

Signal has no table, no list and no heading — five body ranges over plain text
and nothing else — so a monospaced block is as close as a table gets. Both
renderings were put in front of Linus on 2026-08-21 and he chose the padded
one: in a fixed-width font the pipes carry nothing, because the alignment
already says where a column begins. The padding measures a cell *after* the
character delimiters are removed, so `**Mo**` counts as two.

This governs Signal alone. The web view renders markdown itself and shows a
real table; that is deliberate and stays as it is.

`parseMarkdown` runs the two in order and is what the sender calls. Other
senders on juno reach it through `bun run scripts/markdown.ts`, which reads
stdin and prints `{message, textStyles}` named as signal-cli's `send` params:
`bin/task-dispatch` and `juno-ingress` write to the socket directly and would
otherwise ship the syntax as characters, which is how Linus found this on
2026-08-21. The block
stage reports its styles as line numbers of its own output, which the second
stage resolves into offsets — that works because neither stage changes the
number of lines, and the table's separator row is dropped before the numbering
is taken.

## The envelope format is checked, not assumed

`ENVELOPE_FIELDS` in `server.ts` lists every field this adapter reads off an
envelope, and its type binds it to `SignalEnvelope`, so the two cannot drift.
The test *the envelope contract* walks that list against the schemas in
`schemas/`, which signal-cli publishes per release since 0.14.6.

The failure this guards against is silent. When the envelope format moved once
before, inbound DMs simply stopped arriving: no error, no log line, outbound
unaffected, and the adapter looking for a field that was no longer there.
Nothing on this host would have noticed.

juno updates signal-cli daily and unattended, so the vendored set needs a
watchdog of its own: `bun run schemas:check` compares the installed version's
published schemas against `schemas/` and exits non-zero when a schema differs.
It runs from juno's scheduler after the update timer (`briefings.yaml` →
`signal-schemas`). `bun run schemas:refresh` adopts the installed version's set
— read the diff it prints against `ENVELOPE_FIELDS` before trusting it.

A field the adapter reads that the schema does not have is marked `'legacy'`
rather than `'schema'`; the tests also check the reverse, so a marker that has
become wrong fails too.

## Tech stack

- Bun + TypeScript strict mode. No bundler; Bun runs `.ts` directly.
- `@modelcontextprotocol/sdk` for stdio + protocol types.
- `zod` for the permission-request schema.
- `node:net` for the Unix socket client (works under Bun).
- Tests: `bun:test`, plus a mock unix-socket server via `node:net`.

## Project structure

Single-file design — don't split `server.ts` until it grows past ~800
lines. All public types and helpers are `export`ed so tests can hit them
directly without spinning up the real MCP transport.

- `server.ts` — everything (config, RPC client, inbound/outbound, MCP)
- `server.test.ts` — unit + mock integration
- `schemas/` — signal-cli's own JSON schemas for the envelope format, vendored
  from the release asset of the version in `schemas/VERSION`
- `scripts/schemas.ts` — `bun run schemas:check` / `schemas:refresh`
- `docs/claude-signal-spec.md` — the authoritative spec
- `README.md` — user-facing install/run docs
- `package.json` / `tsconfig.json` — copied from claude-synochat,
  dependency list minimal

## Configuration

All env vars documented in `README.md`. `loadConfig()` is the single
entry point; fails loudly on startup if a required var is missing.

Defaults for `SIGNAL_SOCKET_PATH`, `SIGNAL_ATTACH_DIR`, and
`SIGNAL_INBOX_DIR` target juno's `claude` user. Override these when
running elsewhere.

## Dev commands

```bash
bun install
bun run check                # tsc --noEmit
bun test                     # ~60 unit + mock tests, <200ms
bun run server.ts            # start standalone (requires env vars)
SIGNAL_LIVE_TESTS=1 bun test # opt-in live tests (needs real socket)
```

Register with Claude Code via `~/.claude.json` or `.mcp.json`. Start
Claude with `--dangerously-load-development-channels claude-signal` to
enable the channel capability during the research preview.

## Code conventions

- No classes except where a stateful object is clearer (`SignalRpcClient`).
- Pure functions get unit tests; side-effecting handlers get integration
  tests with mocks.
- All logging goes to `stderr` with the `[claude-signal]` prefix — stdout
  is reserved for the MCP JSON-RPC stream.
- Config errors fail loud on startup (throw). Runtime errors log + soft-
  degrade (e.g. failed attachment copy → still emit channel event with
  `attachment_error`; failed `sendReceipt` → log, don't block the flow).
- Security checks live in code (`isAllowed`), not in docs. Every inbound
  message goes through sender gating before anything else.

## Key gotchas

- **signal-cli `--receive-mode on-connection`**: messages flow only while
  a client is connected. `connectLoop()` keeps one connection open and
  reconnects with exponential backoff (1s → 30s) on drop. When the client
  reconnects, signal-cli replays queued messages; the dedupe LRU
  (sender+timestamp, TTL 120s) catches redelivery.
- **NDJSON framing**: one JSON object per line, `\n` separated. Do not
  assume `Content-Length`; buffer until `\n`.
- **Recipient shape**: `send` params use `recipient: string[]` (array),
  not a single string. `sendReceipt` uses `recipient: string` (single).
  Param names mirror signal-cli CLI flags.
- **`attachment` vs `attachments`**: signal-cli 0.14 uses `attachment` on
  the JSON-RPC side for outbound files. We pass an array.
- **Voice notes**: outbound voice notes need `voiceNote: true` as a
  top-level param (not per-attachment). Signal clients only render as a
  voice-note bubble when this flag is set.
- **Self-messages**: Signal delivers your own outbound messages back as
  `syncMessage` events. We drop those (syncMessage filter).
- **Reactions**: they arrive as `dataMessage.reaction`, not as their own
  envelope type. The handler branches early so they don't get mixed with
  normal text.
- **Edit messages**: sit at `envelope.editMessage`, not on dataMessage.
  We copy the inner `dataMessage` over and tag `edited_from_timestamp`.
- **No image previews in meta**: Claude Code reads `image_path` off the
  channel tag and renders the file through its Read tool; we don't need
  to inline base64.
- **Typing pulse is side-effecting**: it sets intervals. Tests must call
  `_resetTypingPulses()` in `beforeEach` (the helpers file does this).
  Missing that cleanup leaves timers that block `bun test` from exiting.
- **Permission verdicts take precedence over channel events**: if the
  message matches `VERDICT_REGEX`, we emit only the permission
  notification — the reply text is never forwarded to Claude.
- **Markdown → `textStyles`**: `sendMessage` runs outbound text through
  `parseMarkdownStyles`, strips the syntax, and forwards paired ranges
  as signal-cli's `textStyles` param. Signal clients don't render
  markdown syntax — they need the body-ranges metadata. Disable with
  `SIGNAL_PARSE_MARKDOWN=0`. Parser is UTF-16-offset-clean and leaves
  `snake_case` underscores alone via a word-boundary rule.

## Deployment

Runs on juno under user `claude`, installed to `/opt/claude-signal` by
the homelab's `mcp-wiring` role. The signal-cli daemon lives in the same
user namespace — the Unix socket is directly reachable. No network
exposure.

## References

- Spec: `docs/claude-signal-spec.md`
- Channel protocol: <https://code.claude.com/docs/en/channels-reference>
- signal-cli JSON-RPC: <https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc>
- Sibling plugin: <https://github.com/meltforce/claude-synochat>
