#!/usr/bin/env bun
/**
 * The markdown-to-Signal conversion, for senders that are not this MCP.
 *
 * Two other things on juno put messages into the same DM thread over
 * signal-cli's JSON-RPC socket — `bin/task-dispatch` when a card finishes or
 * blocks, and `juno-ingress` when a spawn reports back. They talk to the socket
 * directly, so until 2026-08-21 their `**bold**` and `` `code` `` arrived as
 * the characters themselves. Linus saw it on the first card that reported a
 * result.
 *
 * Rather than a second parser, this exposes the one in `server.ts`:
 *
 *     echo "**hallo** `welt`" | bun run scripts/markdown.ts
 *     {"message":"hallo welt","textStyles":["0:5:BOLD","6:4:MONOSPACE"]}
 *
 * `message` and `textStyles` are named exactly as signal-cli's `send` params,
 * so a caller merges the object into its request and is done. Empty input, or
 * anything this fails on, must leave the caller with the text it had — see the
 * fallback each caller keeps.
 */
import { parseMarkdown, textStylesToRpcStrings } from '../server.ts'

const chunks: Uint8Array[] = []
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
const input = new TextDecoder().decode(await new Blob(chunks).arrayBuffer())

const parsed = parseMarkdown(input)
console.log(JSON.stringify({
  message: parsed.text,
  textStyles: textStylesToRpcStrings(parsed.styles),
}))
