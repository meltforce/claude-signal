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
