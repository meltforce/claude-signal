# claude-signal — Specification

Version 0.1.0. Authoritative reference for the plugin's protocol and
behavior. If the code disagrees with this document, the code is probably
right and this document needs updating.

## 1. Purpose

Bridge Signal Messenger DMs to a Claude Code session. A Signal user on an
allowlist writes to the bot's registered number; Claude sees the message
as a `<channel>` tag and can respond through the `reply` tool. Mirrors
`claude-synochat` for Synology Chat.

Single-user shape: one registered signal-cli account, a static allowlist
of allowed senders (E.164 or UUID), an optional default recipient for
proactive messages, `lastRecipient` updated on each inbound DM.

## 2. Architecture

```
 ┌─────────────────────────┐
 │ Signal user (allowlist) │
 └───────────┬─────────────┘
             │ DM
             ▼
 ┌─────────────────────────┐     JSON-RPC 2.0 over Unix socket
 │  signal-cli daemon      │◄──── NDJSON framing
 │  --receive-mode          │
 │      on-connection       │
 └───────────┬─────────────┘
             │  receive notifications / send requests
             ▼
 ┌─────────────────────────┐     MCP stdio (JSON-RPC)
 │  claude-signal (Bun)    │◄──── Claude Code subprocess
 └───────────┬─────────────┘
             │  notifications/claude/channel(/permission)
             ▼
 ┌─────────────────────────┐
 │  Claude Code session    │
 └─────────────────────────┘
```

Invariants:

- stdout is the MCP JSON-RPC stream; never write there directly.
- All logs go to stderr with prefix `[claude-signal]`.
- Dedupe LRU: 128 entries, 120 s TTL, keyed by
  `<canonical-sender>|<timestamp>` (or `<sender>|edit:<ts>`).
- Attachment copy is a local filesystem op; network latency is zero.
- No persistence across restarts except the signal-cli data dir itself.

## 3. Requirements

- Bun ≥ 1.1
- Claude Code ≥ 2.1.81
- signal-cli ≥ 0.13 with daemon mode reachable via Unix socket
- Registered Signal account (not re-registered by the plugin)

## 4. Signal-cli setup

Not the plugin's job. See the juno `signal_cli` role. Expected state:

- Daemon running under the same OS user as the plugin
- `signal-cli --config <data-dir> daemon --socket <path> --receive-mode on-connection`
- Inbound attachments stored at `<data-dir>/attachments/<attachment-id>`

## 5. Configuration

See `README.md` for the env var table. Validation happens in
`loadConfig()`:

- `SIGNAL_ACCOUNT` must match `/^\+[1-9][0-9]{6,14}$/`
- `SIGNAL_ALLOWED_SENDERS` entries must be E.164 or UUID; empty allowlist
  throws
- Numeric fields (`SIGNAL_MAX_*`, `SIGNAL_TYPING_TIMEOUT_MS`) must be
  positive integers
- Unknown or malformed values throw at startup, never at runtime

## 6. Inbound flow

1. `SignalRpcClient.connect()` opens the Unix socket. On connect,
   signal-cli starts receiving from the Signal servers. Every `receive`
   notification is a JSON-RPC notification with an `envelope`.
2. `handleReceiveNotification` filters:
   1. Skip if `exception.message` is present (daemon-side error; log).
   2. Skip typing/sync/story frames; log receipts at debug level.
   3. If `editMessage.dataMessage` is present, use that and record
      `edited_from_timestamp`.
   4. Skip if `groupInfo.groupId` — DMs only in v1.
   5. Gate on `isAllowed(allowedSenders, sourceUuid, sourceNumber)`. Log
      and drop non-matches.
   6. Dedupe on `<canonical-sender>|<timestamp>`.
   7. Update `lastRecipient` (UUID preferred, fallback number).
3. **Verdict short-circuit**: if the raw text matches `VERDICT_REGEX`,
   emit `notifications/claude/channel/permission` and return. Do not
   forward the verdict text to Claude.
4. **Reaction short-circuit**: if `dataMessage.reaction` is set, emit a
   channel event with `kind=reaction` and the reaction meta; return.
5. **Attachment copy**: for each `attachment[]`, read from
   `SIGNAL_ATTACH_DIR/<id>`, validate size, copy to
   `SIGNAL_INBOX_DIR/<ts>-<id>-<safeName>.<ext>`. Errors per attachment
   collect into `meta.attachment_error`; successful copies are still
   reported.
6. **Build meta**: `user_id`, `user_uuid`, `username`, `timestamp`.
   Optional: `edited_from_timestamp`, `view_once`, `quote_timestamp`,
   `quote_author`, `quote_text`, `mentions`, `sticker_*`,
   `image_path`/`audio_path`/`file_path`, `voice_note`, `attachments_json`.
7. **Build content**: prefer the raw text; fallback per attachment type
   (`(Bild: …)`, `(Sprachnachricht: …)`, `(Datei: …)`, `(reaction: 🔥)`).
8. Emit `notifications/claude/channel`.
9. Start the typing pulse for the sender; fire a read receipt if
   `sendReadReceipts` is on.

## 7. Outbound flow

Four tools exposed to Claude. All go through `SignalRpcClient.call('send'
| 'sendReaction' | 'sendTyping' | 'sendReceipt', params)`.

- `reply` → `send` with `recipient = [lastRecipient ?? defaultRecipient]`.
  Stops the typing pulse for that recipient on success.
- `push` → `send` with `recipient = [defaultRecipient]`. Fails loud if
  `defaultRecipient` is unset.
- `react` → `sendReaction` with `recipient = [lastRecipient]`. Returns
  the sent timestamp for reference.
- `typing` → `sendTyping` plus local pulse state.

### Param mapping to signal-cli JSON-RPC

```json
{
  "method": "send",
  "params": {
    "account": "+493045310892",
    "recipient": ["+491234567890"],
    "message": "hallo",
    "attachment": ["/tmp/claude-signal-inbox/1713-abc-pic.jpg"],
    "voiceNote": false,
    "quoteTimestamp": 1713182400000,
    "quoteAuthor": "aaaa-bbbb-…",
    "quoteMessage": "…",
    "editTimestamp": 1713182500000
  }
}
```

Only fields relevant to the call are included. Unused params are
omitted to keep the wire payload small and legible in logs.

### Success and failure

- signal-cli returns `{timestamp}` on success (plus per-recipient details
  on multi-sends). We only ever send to a single recipient, so the
  returned timestamp is the message ts.
- On failure, signal-cli returns a JSON-RPC error. Error message is
  surfaced verbatim to Claude via `{isError: true, content: [...]}`.
- Network drops: the socket closes, `connectLoop()` reconnects, and
  pending `call()` promises reject with `socket closed`. Claude sees the
  rejection as a tool error.

## 8. Permission relay

Opt-in via `capabilities.experimental['claude/channel/permission']`.

1. Claude Code fires `notifications/claude/channel/permission_request`.
2. The plugin DMs the user (`reply` path):

   > 🔐 Claude wants to run *Bash*: runs `git status`
   >
   > `git status`
   >
   > Reply: "yes abcde" or "no abcde"

3. User replies from the DM thread. The inbound handler's
   `VERDICT_REGEX` match takes precedence over the normal channel event
   and fires `notifications/claude/channel/permission`.
4. If the user answers the local terminal dialog first, the remote reply
   is harmless: Claude Code drops verdicts whose `request_id` doesn't
   match an open dialog.

## 9. Typing and receipts

- Typing pulse: on each inbound channel event, start a 4 s-interval
  `sendTyping(..., typing=true)` loop, bounded by
  `SIGNAL_TYPING_TIMEOUT_MS` (default 45 s). Stops on the next outbound
  `reply`/`push` to the same recipient or on explicit `typing(false)`.
- Read receipts: after a successful channel emit, fire
  `sendReceipt(type=read, targetTimestamp=[...])`. Best-effort; errors
  log but don't block.

## 10. Attachments

Inbound:

- Source: `SIGNAL_ATTACH_DIR/<attachment-id>` (extensionless).
- Target: `SIGNAL_INBOX_DIR/<timestamp>-<id>-<safe-filename>.<ext>`.
- Extension from MIME map (jpeg/png/webp/heic/gif/svg, aac/mp4/mpeg/ogg/
  opus/webm/wav/flac, mp4/mov/webm, pdf/zip/txt/md). Unknown MIMEs get
  no extension (still copied).
- Voice notes: `attachment.isVoiceNote === true` → `voice_note=true` in
  meta. Most Signal voice notes are `audio/aac` or `audio/ogg`.
- View-once: `isViewOnce === true` → `view_once=true` meta, no
  `image_path`/`audio_path`/`file_path` (respect the once-and-gone
  semantics).
- Size limit: `SIGNAL_MAX_ATTACHMENT_BYTES` (default 100 MB).
- All-or-nothing per attachment: a single failed copy records
  `attachment_error` but successful copies still land in meta.

Outbound:

- Absolute paths only, must exist, must be regular files, must be
  ≤ `SIGNAL_MAX_SEND_BYTES` (default 95 MB). Validation throws synchronous
  tool errors before we call signal-cli.
- `voice_note=true` on `reply`/`push` sets the top-level `voiceNote` flag;
  signal-cli renders the audio as a real voice note bubble.

## 11. Reconnection

signal-cli in `on-connection` mode buffers inbound messages on the Signal
server when no client is connected. On reconnect, it fetches and replays
them via `receive` notifications. Our dedupe LRU catches replays
within its 120 s window; anything older than that re-emits as a fresh
channel event (acceptable — the user typically won't care if a message
they already saw shows up again after a long adapter outage).

Backoff: 1 s → 2 s → 4 s → … → 30 s cap. Reset to 1 s on every successful
connect.

## 12. Security

- Trust boundary = the allowlist. The only assumption we make is that
  messages from non-allowlisted senders contain hostile input (prompt
  injection, link bait, etc.) and must never reach Claude. The code
  gates unconditionally in `handleReceiveNotification`.
- No auth beyond allowlist. Transport security is signal-cli's problem.
- The Unix socket inherits file-system permissions from the user that
  started the daemon; the plugin must run as the same user (or via SSH
  forwarding).
- Outbound rate limits: none enforced. Signal will throttle us if we
  misbehave; that's fine for a single-user bot.

## 13. Testing

- Unit tests (`bun test`): pure helpers (parsing, classification,
  dedupe, allowlist, resolver). ~30 cases.
- Mock-socket integration tests: spin up a `node:net` Unix server in the
  test and exercise `SignalRpcClient.call`, notifications, error
  handling, close rejection.
- Inbound handler tests: craft `ReceivePayload` literals, assert
  notifications / sender calls.
- Live tests (`SIGNAL_LIVE_TESTS=1 bun test`): opt-in, point at a real
  socket (juno via SSH port-forward or local daemon), do a
  `listAccounts` roundtrip.

## 14. Out of scope (v1)

- Groups (send + receive)
- Pairing flow for allowlist bootstrap (statically configured today)
- Voice-note transcription (files land in `SIGNAL_INBOX_DIR` for a
  separate worker to pick up)
- Sticker file download (metadata only)
- Message chunking — Signal accepts large messages and we haven't hit a
  limit yet
