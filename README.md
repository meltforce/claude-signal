# claude-signal

Signal Messenger channel plugin for [Claude Code](https://code.claude.com).
Forwards Signal DMs into a Claude Code session as `<channel>` events and lets
Claude reply, react, and show "typing…" via [signal-cli]'s JSON-RPC daemon.

[signal-cli]: https://github.com/AsamK/signal-cli

Sibling project: [`claude-synochat`](https://github.com/meltforce/claude-synochat)
— same channel-protocol pattern but for Synology Chat.

## What this does

- Keeps a persistent connection to the local `signal-cli` daemon's Unix
  socket.
- Filters inbound messages against an allowlist (E.164 or UUID). Anything
  not on the list is dropped silently.
- Emits allowed DMs as `notifications/claude/channel` events. Images, voice
  notes, and other files are copied to a local inbox with the right file
  extension and surfaced via `image_path` / `audio_path` / `file_path`
  meta.
- Exposes four tools to Claude: `reply`, `push`, `react`, `typing`.
- Shows a live typing indicator while waiting for Claude to respond.
- Sends read receipts automatically (toggleable).
- Relays permission prompts (`yes <id>` / `no <id>`) to the same DM thread.
- Propagates quote/edit/reaction context both ways.

DMs only in v1. Groups are dropped before the channel event is emitted.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Claude Code ≥ 2.1.81 (permission relay requires this version)
- `signal-cli` ≥ 0.13 running as a daemon with a reachable Unix socket
- An already-registered Signal account on that daemon

On juno (homelab), the daemon runs under user `claude` with socket
`/run/user/1061/signal-cli.socket` and account `+493045310892`. See
`~/projects/homelab/configuration/juno/roles/signal_cli/`.

## Install

```bash
cd ~/projects/claude-signal
bun install
```

## Configuration

| Env var                       | Required | Default                                                   | Purpose                                            |
| ----------------------------- | :------: | --------------------------------------------------------- | -------------------------------------------------- |
| `SIGNAL_ACCOUNT`              |    ✓     | —                                                         | Registered E.164, e.g. `+493045310892`             |
| `SIGNAL_ALLOWED_SENDERS`      |    ✓     | —                                                         | Comma-separated list of E.164 and/or UUIDs         |
| `SIGNAL_SOCKET_PATH`          |          | `/run/user/1061/signal-cli.socket`                        | signal-cli JSON-RPC socket                         |
| `SIGNAL_DEFAULT_RECIPIENT`    |          | —                                                         | Fallback for `reply` / target for `push`           |
| `SIGNAL_ATTACH_DIR`           |          | `/home/claude/.local/share/signal-cli/attachments`        | Where signal-cli stores inbound attachment blobs   |
| `SIGNAL_INBOX_DIR`            |          | `/tmp/claude-signal-inbox`                                | Plugin-owned inbox for copied attachments          |
| `SIGNAL_MAX_ATTACHMENT_BYTES` |          | `104857600` (100 MB)                                      | Refuse to copy larger inbound files                |
| `SIGNAL_MAX_SEND_BYTES`       |          | `99614720` (95 MB)                                        | Refuse to send larger outbound files               |
| `SIGNAL_SEND_READ_RECEIPTS`   |          | `1`                                                       | Set `0` to stop sending read receipts              |
| `SIGNAL_TYPING_TIMEOUT_MS`    |          | `45000`                                                   | Max duration of an auto-typing pulse               |
| `SIGNAL_DEBUG_DUMP_EVENTS`    |          | —                                                         | `1` to print every `receive` payload on stderr     |
| `SIGNAL_PARSE_MARKDOWN`       |          | `1`                                                       | Parse markdown in outbound messages into Signal `textStyles`. `0` to send raw text |

Required vars are validated at startup — the process exits immediately if
anything is missing or malformed.

## Run

Register as an MCP server in Claude Code (user-level `~/.claude.json` or
project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "claude-signal": {
      "command": "bun",
      "args": ["run", "/opt/claude-signal/server.ts"],
      "env": {
        "SIGNAL_ACCOUNT": "+493045310892",
        "SIGNAL_ALLOWED_SENDERS": "+491234567890",
        "SIGNAL_DEFAULT_RECIPIENT": "+491234567890"
      }
    }
  }
}
```

Start Claude Code with the development-channel flag (the channel isn't on
Anthropic's approved allowlist during research preview):

```bash
claude --dangerously-load-development-channels claude-signal
```

On juno we alias `claude` to always pass both `claude-synochat` and
`claude-signal`:

```bash
alias claude='command claude --dangerously-load-development-channels claude-synochat claude-signal'
```

## Tools

- **`reply(text, attachments?, voice_note?, quote_timestamp?, quote_author?, quote_text?, edit_timestamp?)`**
  DM the last sender. `attachments` is an array of absolute paths.
  `voice_note=true` sends audio as a real Signal voice note.
- **`push(text, attachments?, voice_note?)`**
  Proactive DM to `SIGNAL_DEFAULT_RECIPIENT`. Ignores who last wrote.
- **`react(target_timestamp, target_author, emoji, remove?)`**
  React to a specific inbound message. `target_timestamp` comes from the
  inbound channel event's `meta.timestamp`; `target_author` from
  `meta.user_uuid` or `meta.user_id`.
- **`typing(on)`**
  Manually toggle the typing indicator.

Each outbound tool returns the `timestamp` of the sent message so Claude
can react to or edit it later.

## Markdown in outbound messages

Signal doesn't render markdown syntax — `**bold**` arrives as literal
asterisks. Under the hood the client uses separate "body ranges" metadata
(start:length:style) to mark styled spans. `claude-signal` parses a
subset of markdown on every outbound `reply` / `push`, strips the syntax
from the text, and passes the ranges to signal-cli as `textStyles`.

Supported:

| Input             | Renders as     |
| ----------------- | -------------- |
| `**bold**`        | **bold**       |
| `*italic*`        | *italic*       |
| `_italic_`        | *italic*       |
| `` `inline` ``    | `inline` (mono)|
| ```` ```code``` ````  | multiline mono |
| `~~strike~~`      | strikethrough  |
| `\|\|spoiler\|\|` | tap-to-reveal  |

Notes and limits:

- `_` inside `snake_case` identifiers is left alone — word-boundary
  check.
- Unpaired delimiters (e.g. a lone `**`) are emitted as literal
  characters.
- No backslash escapes. Put `**` or `` ` `` inside a code span to keep it
  literal.
- Styles inside code spans are not parsed — `` `**x**` `` renders as
  `**x**` in monospace.
- Turn the parser off entirely with `SIGNAL_PARSE_MARKDOWN=0` (then all
  markdown is sent as raw text).

## Inbound channel events

```xml
<channel source="claude-signal"
         user_id="+491234567890"
         user_uuid="abcdef12-…"
         username="Alice"
         timestamp="1713182400000"
         image_path="/tmp/claude-signal-inbox/1713182400000-abc-photo.jpg"
         attachments_json='[{"path":"…","mime":"image/jpeg",…}]'>
Schau mal das Rezept hier
</channel>
```

Additional meta fields that may appear:
`audio_path` + `audio_mime` + `voice_note=true`, `file_path` + `file_mime`
+ `file_name` + `file_size`, `quote_timestamp` + `quote_author` +
`quote_text`, `kind=reaction` + `emoji` + `target_timestamp` +
`target_author`, `kind=sticker`, `view_once=true`,
`edited_from_timestamp`, `mentions` (JSON), `attachment_error`.

## Permission relay

When Claude Code wants to run a restricted tool, the plugin DMs a prompt
that includes a five-letter ID:

> 🔐 Claude wants to run *Bash*: run `git status`
> Reply: "yes abcde" or "no abcde"

Reply with exactly that syntax from the same Signal thread; the local
terminal dialog stays open in parallel until either side answers.

## Testing

```bash
bun run check       # tsc --noEmit
bun test            # unit + mock-socket integration
```

Live tests against the real juno socket are gated on `SIGNAL_LIVE_TESTS=1`.
They require SSH port-forwarding the signal-cli socket to your local
machine (`ssh -L $(pwd)/signal.sock:/run/user/1061/signal-cli.socket juno`).

## Deployment on juno

The homelab's `mcp-wiring` role clones this repo to `/opt/claude-signal`,
runs `bun install` as user `claude`, and registers it in
`~/.claude.json`. Secrets live in setec under
`private-cloud/juno-signal-*`. See
`~/projects/homelab/configuration/juno/roles/mcp-wiring/`.

## Security model

- Only senders on `SIGNAL_ALLOWED_SENDERS` can push events into Claude's
  context. This is the trust boundary — keep the list tight.
- The plugin does not persist messages. It relies on Signal for history.
- The signal-cli socket is Unix-local; the plugin must run on the same
  host as the daemon (or over an SSH-forwarded socket).
- Tokens and allowlists are passed via env vars; nothing is logged with
  personally identifying text beyond sender numbers in reconnect/dropped
  messages.

## See also

- [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)
- [signal-cli JSON-RPC API](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc)
- [claude-synochat](https://github.com/meltforce/claude-synochat) sibling project
