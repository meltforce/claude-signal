import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connect as netConnect, type Socket } from 'node:net'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { copyFile } from 'node:fs/promises'

// =============================================================================
// Config
// =============================================================================

export type Config = {
  account: string
  allowedSenders: Set<string>
  socketPath: string
  defaultRecipient: string | undefined
  attachDir: string
  inboxDir: string
  maxAttachmentBytes: number
  maxSendBytes: number
  sendReadReceipts: boolean
  typingTimeoutMs: number
  debugDumpEvents: boolean
  parseMarkdown: boolean
}

const E164_RE = /^\+[1-9][0-9]{6,14}$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseAllowlist(raw: string): Set<string> {
  const entries = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  const out = new Set<string>()
  for (const e of entries) {
    if (E164_RE.test(e)) out.add(e)
    else if (UUID_RE.test(e)) out.add(e.toLowerCase())
    else throw new Error(`allowlist entry is neither E.164 nor UUID: ${e}`)
  }
  if (out.size === 0) {
    throw new Error('allowlist is empty')
  }
  return out
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return fallback
}

function parseIntOrThrow(raw: string, name: string, min = 1): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got: ${raw}`)
  }
  return n
}

export function loadConfig(): Config {
  const account = process.env.SIGNAL_ACCOUNT?.trim()
  const allowedRaw = process.env.SIGNAL_ALLOWED_SENDERS?.trim()
  const missing: string[] = []
  if (!account) missing.push('SIGNAL_ACCOUNT')
  if (!allowedRaw) missing.push('SIGNAL_ALLOWED_SENDERS')
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(', ')}`)
  }
  if (!E164_RE.test(account!)) {
    throw new Error(`SIGNAL_ACCOUNT must be E.164, got: ${account}`)
  }
  const allowedSenders = parseAllowlist(allowedRaw!)

  const socketPath =
    process.env.SIGNAL_SOCKET_PATH?.trim() || '/run/user/1061/signal-cli.socket'
  const defaultRecipientRaw = process.env.SIGNAL_DEFAULT_RECIPIENT?.trim()
  let defaultRecipient: string | undefined
  if (defaultRecipientRaw) {
    if (!E164_RE.test(defaultRecipientRaw) && !UUID_RE.test(defaultRecipientRaw)) {
      throw new Error(
        `SIGNAL_DEFAULT_RECIPIENT must be E.164 or UUID, got: ${defaultRecipientRaw}`,
      )
    }
    defaultRecipient = E164_RE.test(defaultRecipientRaw)
      ? defaultRecipientRaw
      : defaultRecipientRaw.toLowerCase()
  }

  const attachDir =
    process.env.SIGNAL_ATTACH_DIR?.trim() ||
    '/home/claude/.local/share/signal-cli/attachments'
  const inboxDir = process.env.SIGNAL_INBOX_DIR?.trim() || '/tmp/claude-signal-inbox'
  const maxAttachmentBytes = process.env.SIGNAL_MAX_ATTACHMENT_BYTES
    ? parseIntOrThrow(
        process.env.SIGNAL_MAX_ATTACHMENT_BYTES,
        'SIGNAL_MAX_ATTACHMENT_BYTES',
      )
    : 100 * 1024 * 1024
  const maxSendBytes = process.env.SIGNAL_MAX_SEND_BYTES
    ? parseIntOrThrow(process.env.SIGNAL_MAX_SEND_BYTES, 'SIGNAL_MAX_SEND_BYTES')
    : 95 * 1024 * 1024
  const sendReadReceipts = parseBool(process.env.SIGNAL_SEND_READ_RECEIPTS, true)
  const typingTimeoutMs = process.env.SIGNAL_TYPING_TIMEOUT_MS
    ? parseIntOrThrow(
        process.env.SIGNAL_TYPING_TIMEOUT_MS,
        'SIGNAL_TYPING_TIMEOUT_MS',
        1000,
      )
    : 45_000
  const debugDumpEvents = parseBool(process.env.SIGNAL_DEBUG_DUMP_EVENTS, false)
  const parseMarkdown = parseBool(process.env.SIGNAL_PARSE_MARKDOWN, true)

  return {
    account: account!,
    allowedSenders,
    socketPath,
    defaultRecipient,
    attachDir,
    inboxDir,
    maxAttachmentBytes,
    maxSendBytes,
    sendReadReceipts,
    typingTimeoutMs,
    debugDumpEvents,
    parseMarkdown,
  }
}

// =============================================================================
// Pure helpers
// =============================================================================

export type NotifySink = {
  notification: (n: {
    method: string
    params?: Record<string, unknown>
  }) => Promise<void>
}

export const VERDICT_REGEX = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export const DEDUPE_TTL_MS = 120_000
export const DEDUPE_CAP = 128
const dedupeStore = new Map<string, number>()

export function isDuplicate(key: string): boolean {
  const now = Date.now()
  for (const [k, t] of dedupeStore) {
    if (now - t > DEDUPE_TTL_MS) dedupeStore.delete(k)
    else break
  }
  if (dedupeStore.has(key)) return true
  while (dedupeStore.size >= DEDUPE_CAP) {
    const oldest = dedupeStore.keys().next().value
    if (oldest === undefined) break
    dedupeStore.delete(oldest)
  }
  dedupeStore.set(key, now)
  return false
}

export function _resetDedupe(): void {
  dedupeStore.clear()
}

export type MediaKind = 'image' | 'audio' | 'file'

export function classifyMime(mime: string): MediaKind {
  const lower = mime.toLowerCase()
  if (lower.startsWith('image/')) return 'image'
  if (lower.startsWith('audio/')) return 'audio'
  return 'file'
}

// Minimal MIME→extension map. Signal-cli stores inbound attachments under their
// bare attachment id (no extension); we add one so that downstream tools
// (editors, viewers, Claude's Read tool) open them correctly.
const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/svg+xml': '.svg',
  'audio/aac': '.aac',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/webm': '.webm',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/markdown': '.md',
}

export function extFromMime(mime: string | undefined): string {
  if (!mime) return ''
  return MIME_EXT[mime.toLowerCase()] ?? ''
}

export function safeFilename(name: string, fallbackExt: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96)
  const hasAlnum = /[a-zA-Z0-9]/.test(cleaned)
  if (!hasAlnum) return `attachment${fallbackExt}`
  if (/\.[a-z0-9]{1,8}$/i.test(cleaned)) return cleaned
  return `${cleaned}${fallbackExt}`
}

export function canonicalSender(
  sourceUuid: string | undefined,
  sourceNumber: string | undefined,
): string | undefined {
  if (sourceUuid) return sourceUuid.toLowerCase()
  if (sourceNumber) return sourceNumber
  return undefined
}

export function isAllowed(
  allowlist: Set<string>,
  sourceUuid: string | undefined,
  sourceNumber: string | undefined,
): boolean {
  if (sourceUuid && allowlist.has(sourceUuid.toLowerCase())) return true
  if (sourceNumber && allowlist.has(sourceNumber)) return true
  return false
}

// =============================================================================
// Recipient state (module-level)
// =============================================================================

let lastRecipient: string | undefined
const sentTimestamps = new Set<number>() // our own outbound ts; for reaction/receipt dedupe

export function resolvePreferLastSender(config: Config): string {
  const r = lastRecipient ?? config.defaultRecipient
  if (!r) {
    throw new Error(
      'no recipient: no inbound DM has been received yet and SIGNAL_DEFAULT_RECIPIENT is not set',
    )
  }
  return r
}

export function resolveDefaultOnly(config: Config): string {
  if (!config.defaultRecipient) {
    throw new Error(
      'push: SIGNAL_DEFAULT_RECIPIENT env var is not set — set it to the default recipient (E.164 or UUID)',
    )
  }
  return config.defaultRecipient
}

export function _resetLastRecipient(): void {
  lastRecipient = undefined
}
export function _setLastRecipient(r: string | undefined): void {
  lastRecipient = r
}
export function _getLastRecipient(): string | undefined {
  return lastRecipient
}

// =============================================================================
// Markdown → Signal textStyles
// =============================================================================
// Signal does not render markdown syntax. It ships styled text as separate
// "body ranges" metadata (start:length:style triples) alongside the plain
// text. signal-cli exposes this as the `textStyles` JSON-RPC param.
//
// This parser converts the common markdown we already write in replies
// (**bold**, *italic*, _italic_, `mono`, ```fenced```, ~~strike~~,
// ||spoiler||) into a stripped-text + TextStyle[] pair so the message
// renders in the Signal client instead of showing literal asterisks.
//
// Offsets are native JS string indices — UTF-16 code units, which matches
// how signal-cli (Java) indexes. Works for BMP and supplementary-plane
// characters.
//
// Limitations:
//   - No backslash escapes. Write `**` inside a code span if you need it
//     literal.
//   - Unpaired delimiters (odd count for a given style) fall back to
//     literal characters in the output.
//   - Inside inline/fenced code, other markdown is not parsed.

export type TextStyleName =
  | 'BOLD'
  | 'ITALIC'
  | 'STRIKETHROUGH'
  | 'MONOSPACE'
  | 'SPOILER'

export type TextStyle = {
  start: number
  length: number
  style: TextStyleName
}

export type ParsedMessage = {
  text: string
  styles: TextStyle[]
}

type Token =
  | { kind: 'text'; value: string }
  | {
      kind: 'delim'
      delim: string
      style: TextStyleName
      verbatim: boolean
    }

// Ordered longest-first so `**` wins over `*`, `~~` over `~`, `||` over `|`,
// and ``` over `.
const DELIM_ORDER: ReadonlyArray<{
  delim: string
  style: TextStyleName
  verbatim: boolean
}> = [
  { delim: '```', style: 'MONOSPACE', verbatim: true },
  { delim: '**', style: 'BOLD', verbatim: false },
  { delim: '~~', style: 'STRIKETHROUGH', verbatim: false },
  { delim: '||', style: 'SPOILER', verbatim: false },
  { delim: '`', style: 'MONOSPACE', verbatim: true },
  { delim: '*', style: 'ITALIC', verbatim: false },
  { delim: '_', style: 'ITALIC', verbatim: false },
]

const WORD_CHAR_RE = /[A-Za-z0-9]/

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && WORD_CHAR_RE.test(c)
}

// Tokenize: classify each character as either literal text or a delimiter
// token. Monospace delimiters (`, ```) are paired eagerly at tokenize time
// and the content between them is emitted as a single verbatim text token —
// no further markdown parsing inside code spans.
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let buf = ''
  const flushText = () => {
    if (buf.length > 0) {
      tokens.push({ kind: 'text', value: buf })
      buf = ''
    }
  }

  let i = 0
  while (i < input.length) {
    // Fenced code block (```...```) — verbatim, eagerly matched
    if (input.startsWith('```', i)) {
      const close = input.indexOf('```', i + 3)
      if (close === -1) {
        // Unclosed: emit literally
        buf += input[i]
        i++
        continue
      }
      flushText()
      tokens.push({ kind: 'delim', delim: '```', style: 'MONOSPACE', verbatim: true })
      tokens.push({ kind: 'text', value: input.substring(i + 3, close) })
      tokens.push({ kind: 'delim', delim: '```', style: 'MONOSPACE', verbatim: true })
      i = close + 3
      continue
    }
    // Inline code (`...`) — verbatim, eagerly matched
    if (input[i] === '`') {
      const close = input.indexOf('`', i + 1)
      if (close === -1) {
        buf += input[i]
        i++
        continue
      }
      flushText()
      tokens.push({ kind: 'delim', delim: '`', style: 'MONOSPACE', verbatim: true })
      tokens.push({ kind: 'text', value: input.substring(i + 1, close) })
      tokens.push({ kind: 'delim', delim: '`', style: 'MONOSPACE', verbatim: true })
      i = close + 1
      continue
    }
    // Try other delimiters longest-first
    let matched: { delim: string; style: TextStyleName; verbatim: boolean } | null = null
    for (const spec of DELIM_ORDER) {
      if (spec.verbatim) continue // handled above
      if (!input.startsWith(spec.delim, i)) continue
      // Single `_` or `*` only counts as a delimiter when not sandwiched
      // between two word characters — so `snake_case` stays literal.
      if (spec.delim === '_' || spec.delim === '*') {
        const prev = i > 0 ? input[i - 1] : undefined
        const next = input[i + spec.delim.length]
        if (isWordChar(prev) && isWordChar(next)) continue
      }
      matched = spec
      break
    }
    if (matched) {
      flushText()
      tokens.push({
        kind: 'delim',
        delim: matched.delim,
        style: matched.style,
        verbatim: false,
      })
      i += matched.delim.length
    } else {
      buf += input[i]
      i++
    }
  }
  flushText()
  return tokens
}

export function parseMarkdownStyles(input: string): ParsedMessage {
  const tokens = tokenize(input)

  // Non-verbatim delimiters must come in pairs (open, close, open, close...).
  // If a delim appears an odd number of times, the LAST occurrence is
  // reverted to literal text so earlier pairs still render.
  const countByDelim = new Map<string, number>()
  for (const t of tokens) {
    if (t.kind !== 'delim' || t.verbatim) continue
    countByDelim.set(t.delim, (countByDelim.get(t.delim) ?? 0) + 1)
  }
  const revertIdx = new Set<number>()
  for (const [delim, count] of countByDelim) {
    if (count % 2 === 0) continue
    for (let k = tokens.length - 1; k >= 0; k--) {
      const tk = tokens[k]!
      if (tk.kind === 'delim' && !tk.verbatim && tk.delim === delim) {
        revertIdx.add(k)
        break
      }
    }
  }

  let text = ''
  const styles: TextStyle[] = []
  const pending = new Map<string, number>() // delim → start offset in output

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]!
    if (revertIdx.has(idx)) {
      text += (t as { delim: string }).delim
      continue
    }
    if (t.kind === 'text') {
      text += t.value
      continue
    }
    const key = t.delim
    const openStart = pending.get(key)
    if (openStart === undefined) {
      pending.set(key, text.length)
    } else {
      pending.delete(key)
      const length = text.length - openStart
      if (length > 0) {
        styles.push({ start: openStart, length, style: t.style })
      }
    }
  }

  // Stable sort for deterministic output (start asc, then length desc)
  styles.sort((a, b) => a.start - b.start || b.length - a.length)
  return { text, styles }
}

export function textStylesToRpcStrings(styles: TextStyle[]): string[] {
  return styles.map(s => `${s.start}:${s.length}:${s.style}`)
}

// =============================================================================
// JSON-RPC client over Unix socket (NDJSON / JSON-RPC 2.0)
// =============================================================================

export type JsonRpcNotification = {
  jsonrpc?: '2.0'
  method: string
  params?: unknown
}

export type SignalRpcClientOpts = {
  socketPath: string
  onNotification?: (msg: JsonRpcNotification) => void
  onConnect?: () => void
  onClose?: (err: Error | undefined) => void
  logPrefix?: string
}

export class SignalRpcClient {
  private sock: Socket | undefined
  private buffer = ''
  private nextId = 1
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private closed = false
  private closeHandlers: Array<(err: Error | undefined) => void> = []
  private readonly log: string

  constructor(private opts: SignalRpcClientOpts) {
    this.log = opts.logPrefix ?? '[claude-signal]'
    if (opts.onClose) this.closeHandlers.push(opts.onClose)
  }

  onClose(fn: (err: Error | undefined) => void): void {
    this.closeHandlers.push(fn)
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = netConnect({ path: this.opts.socketPath })
      this.sock = sock
      let resolved = false
      sock.on('connect', () => {
        resolved = true
        resolve()
        this.opts.onConnect?.()
      })
      sock.on('data', chunk => this.onData(chunk))
      sock.on('error', err => {
        if (!resolved) {
          resolved = true
          reject(err)
          return
        }
        this.handleClose(err)
      })
      sock.on('close', () => {
        this.handleClose(undefined)
      })
    })
  }

  close(): void {
    this.closed = true
    this.sock?.destroy()
  }

  private handleClose(err: Error | undefined): void {
    if (this.closed && this.pending.size === 0 && this.closeHandlers.length === 0) {
      return
    }
    this.closed = true
    for (const p of this.pending.values()) {
      p.reject(err ?? new Error('socket closed'))
    }
    this.pending.clear()
    const handlers = this.closeHandlers.splice(0)
    for (const h of handlers) {
      try {
        h(err)
      } catch (e) {
        console.error(`${this.log} close handler threw:`, e)
      }
    }
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.length === 0) continue
      let msg: {
        jsonrpc?: string
        id?: number | string
        method?: string
        params?: unknown
        result?: unknown
        error?: { code?: number; message?: string; data?: unknown }
      }
      try {
        msg = JSON.parse(line)
      } catch (err) {
        console.error(`${this.log} failed to parse line from daemon: ${line.slice(0, 200)}`)
        continue
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          if (msg.error) {
            const e = msg.error
            p.reject(
              new Error(
                `signal-cli error ${e.code ?? '?'}: ${e.message ?? 'unknown'}${
                  e.data ? ` (${JSON.stringify(e.data).slice(0, 200)})` : ''
                }`,
              ),
            )
          } else {
            p.resolve(msg.result)
          }
        }
        continue
      }
      if (msg.method) {
        try {
          this.opts.onNotification?.({
            jsonrpc: '2.0',
            method: msg.method,
            params: msg.params,
          })
        } catch (err) {
          console.error(`${this.log} notification handler threw:`, err)
        }
      }
    }
  }

  call(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    if (!this.sock || this.closed) {
      return Promise.reject(new Error('rpc client not connected'))
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`rpc timeout: ${method} after ${timeoutMs}ms`))
        }
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.sock!.write(payload, err => {
        if (err) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(err)
        }
      })
    })
  }
}

// =============================================================================
// Inbox handling
// =============================================================================

export function ensureInboxDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const probe = `${path.replace(/\/+$/, '')}/.write-probe`
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
  } catch (err) {
    throw new Error(`inbox dir ${path} is not writable: ${(err as Error).message}`)
  }
}

export function gcInbox(path: string, maxAgeMs: number): number {
  let removed = 0
  const now = Date.now()
  let entries: string[]
  try {
    entries = readdirSync(path)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const full = `${path.replace(/\/+$/, '')}/${name}`
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      if (now - st.mtimeMs > maxAgeMs) {
        unlinkSync(full)
        removed++
      }
    } catch {}
  }
  return removed
}

export type CopiedAttachment = {
  id: string
  path: string
  filename: string
  mime: string
  size: number
  kind: MediaKind
  voiceNote: boolean
}

export type InboundAttachment = {
  id?: string
  contentType?: string
  filename?: string
  size?: number
  voiceNote?: boolean
  // Some signal-cli versions use `isVoiceNote`
  isVoiceNote?: boolean
}

export async function copyInboundAttachment(
  att: InboundAttachment,
  timestamp: number,
  config: Config,
): Promise<CopiedAttachment> {
  if (!att.id) throw new Error('attachment has no id')
  const src = `${config.attachDir.replace(/\/+$/, '')}/${att.id}`
  if (!existsSync(src)) {
    throw new Error(`source file missing: ${src}`)
  }
  const st = statSync(src)
  if (st.size > config.maxAttachmentBytes) {
    throw new Error(
      `attachment ${att.id} size ${st.size} exceeds SIGNAL_MAX_ATTACHMENT_BYTES ${config.maxAttachmentBytes}`,
    )
  }
  const mime = (att.contentType ?? 'application/octet-stream').split(';')[0]!.trim()
  const ext = extFromMime(mime)
  const safe = safeFilename(att.filename ?? `attachment-${att.id}`, ext)
  const target = `${config.inboxDir.replace(/\/+$/, '')}/${timestamp}-${att.id}-${safe}`
  await copyFile(src, target)
  return {
    id: att.id,
    path: target,
    filename: safe,
    mime,
    size: st.size,
    kind: classifyMime(mime),
    voiceNote: Boolean(att.voiceNote ?? att.isVoiceNote),
  }
}

// =============================================================================
// Inbound message handler
// =============================================================================

export type SignalEnvelope = {
  source?: string
  sourceNumber?: string
  sourceUuid?: string
  sourceName?: string
  sourceDevice?: number
  timestamp?: number
  dataMessage?: {
    timestamp?: number
    message?: string | null
    attachments?: InboundAttachment[]
    groupInfo?: { groupId?: string; type?: string }
    mentions?: Array<{
      name?: string
      number?: string
      uuid?: string
      start?: number
      length?: number
    }>
    quote?: {
      id?: number
      author?: string
      authorNumber?: string
      authorUuid?: string
      text?: string | null
    }
    reaction?: {
      emoji?: string
      targetAuthor?: string
      targetAuthorNumber?: string
      targetAuthorUuid?: string
      targetSentTimestamp?: number
      isRemove?: boolean
    }
    sticker?: { packId?: string; stickerId?: number }
    viewOnce?: boolean
    isViewOnce?: boolean
  }
  editMessage?: {
    targetSentTimestamp?: number
    dataMessage?: SignalEnvelope['dataMessage']
  }
  typingMessage?: unknown
  // No `type` here: signal-cli reports a receipt as three booleans, and the
  // debug line below printed `?` for as long as it read one (found 2026-08-21
  // by checking this type against the published schema).
  receiptMessage?: {
    isDelivery?: boolean
    isRead?: boolean
    isViewed?: boolean
    when?: number
    timestamps?: number[]
  }
  syncMessage?: unknown
  storyMessage?: unknown
}

/**
 * Every field this adapter reads off an envelope, as a tree that mirrors
 * `SignalEnvelope`.
 *
 * It exists to be checked against signal-cli's own JSON schemas, which the
 * project publishes as a release asset (`…-json-schemas.tar.gz`) since 0.14.6
 * and which are vendored under `schemas/`. The test *the envelope contract*
 * walks this tree and fails when a field is no longer in the format — the
 * failure mode it guards against is silent: when the envelope format moved
 * once before, inbound DMs stopped arriving, outbound kept working, and
 * nothing logged an error.
 *
 * A leaf is `'schema'` when signal-cli must still document the field, and
 * `'legacy'` when the adapter reads it as an older alias and its absence from
 * the schema is expected rather than a regression.
 *
 * The type binds the tree to `SignalEnvelope`: adding a field there without
 * adding it here is a compile error, so the two cannot drift apart.
 */
export type FieldCheck = 'schema' | 'legacy'

type FieldTree<T> = {
  [K in keyof Required<T>]: FieldCheck | FieldTree<unknown>
}

export const ENVELOPE_FIELDS: FieldTree<SignalEnvelope> = {
  source: 'schema',
  sourceNumber: 'schema',
  sourceUuid: 'schema',
  sourceName: 'schema',
  sourceDevice: 'schema',
  timestamp: 'schema',
  dataMessage: {
    timestamp: 'schema',
    message: 'schema',
    attachments: 'schema',
    groupInfo: 'schema',
    mentions: 'schema',
    quote: 'schema',
    reaction: 'schema',
    sticker: 'schema',
    viewOnce: 'schema',
    // Read alongside `viewOnce` and absent from the schema since at least
    // 0.14.7. Kept because it costs one `||` and an envelope from an older
    // signal-cli may still carry it.
    isViewOnce: 'legacy',
  },
  editMessage: {
    targetSentTimestamp: 'schema',
    dataMessage: 'schema',
  },
  typingMessage: 'schema',
  receiptMessage: {
    isDelivery: 'schema',
    isRead: 'schema',
    isViewed: 'schema',
    when: 'schema',
    timestamps: 'schema',
  },
  syncMessage: 'schema',
  storyMessage: 'schema',
}

/** Which of the three receipt flags is set, for the debug line. */
export function receiptKind(
  rm: NonNullable<SignalEnvelope['receiptMessage']>,
): string {
  if (rm.isDelivery) return 'delivery'
  if (rm.isRead) return 'read'
  if (rm.isViewed) return 'viewed'
  return 'unknown'
}

export type ReceivePayload = {
  account?: string
  envelope?: SignalEnvelope
  exception?: { message?: string }
}

export type OutboundSender = {
  sendMessage: (args: {
    recipient: string
    message: string
    attachments?: string[]
    voiceNote?: boolean
    quoteTimestamp?: number
    quoteAuthor?: string
    quoteMessage?: string
    editTimestamp?: number
  }) => Promise<{ timestamp: number }>
  sendTyping: (recipient: string, typing: boolean) => Promise<void>
  sendReceipt: (recipient: string, targetTimestamps: number[]) => Promise<void>
  sendReaction: (args: {
    recipient: string
    emoji: string
    targetAuthor: string
    targetTimestamp: number
    remove?: boolean
  }) => Promise<{ timestamp: number }>
}

// Global typing state (one active pulse per recipient)
type TypingState = {
  interval: ReturnType<typeof setInterval>
  timeout: ReturnType<typeof setTimeout>
}
const typingPulses = new Map<string, TypingState>()

export function startTypingPulse(
  recipient: string,
  sender: OutboundSender,
  timeoutMs: number,
): void {
  stopTypingPulse(recipient)
  const kick = () => {
    void sender.sendTyping(recipient, true).catch(err => {
      console.error('[claude-signal] sendTyping failed:', (err as Error).message)
    })
  }
  kick()
  const interval = setInterval(kick, 4000)
  const timeout = setTimeout(() => stopTypingPulse(recipient), timeoutMs)
  typingPulses.set(recipient, { interval, timeout })
}

export function stopTypingPulse(recipient: string): void {
  const s = typingPulses.get(recipient)
  if (!s) return
  clearInterval(s.interval)
  clearTimeout(s.timeout)
  typingPulses.delete(recipient)
}

export function _resetTypingPulses(): void {
  for (const key of typingPulses.keys()) stopTypingPulse(key)
}

export type HandleResult = {
  emitted: boolean
  reason?: string
}

export async function handleReceiveNotification(
  payload: ReceivePayload,
  config: Config,
  sink: NotifySink,
  sender: OutboundSender,
): Promise<HandleResult> {
  if (payload.exception?.message) {
    console.error(`[claude-signal] daemon exception: ${payload.exception.message}`)
    return { emitted: false, reason: 'daemon exception' }
  }
  const env = payload.envelope
  if (!env) return { emitted: false, reason: 'no envelope' }

  // We only care about user-visible content. Silently drop typing/receipt/
  // sync/story frames.
  if (env.typingMessage) return { emitted: false, reason: 'typing' }
  if (env.syncMessage) return { emitted: false, reason: 'sync' }
  if (env.storyMessage) return { emitted: false, reason: 'story' }
  if (env.receiptMessage) {
    const rm = env.receiptMessage
    if (config.debugDumpEvents) {
      console.error(
        `[claude-signal] receipt ${receiptKind(rm)} from ${
          env.sourceNumber ?? env.sourceUuid ?? '?'
        } for ts ${rm.timestamps?.join(',') ?? '?'}`,
      )
    }
    return { emitted: false, reason: 'receipt' }
  }

  // Edit messages (signal-cli surfaces them either inline on dataMessage or as
  // a sibling editMessage). Treat editMessage as a fresh dataMessage with an
  // `edited_from_timestamp` marker.
  let dataMessage = env.dataMessage
  let editedFromTimestamp: number | undefined
  if (env.editMessage?.dataMessage) {
    dataMessage = env.editMessage.dataMessage
    editedFromTimestamp = env.editMessage.targetSentTimestamp
  }
  if (!dataMessage) return { emitted: false, reason: 'no dataMessage' }

  // DMs only for v1 — drop groups early so they can't carry either text or
  // attachments through to the channel.
  if (dataMessage.groupInfo?.groupId) {
    if (config.debugDumpEvents) {
      console.error(
        `[claude-signal] dropped group message (v1 DM-only) from ${
          env.sourceNumber ?? env.sourceUuid ?? '?'
        }`,
      )
    }
    return { emitted: false, reason: 'group message' }
  }

  // Sender gate. Required — this is the trust boundary: anyone who can
  // message the Signal number can put text in front of Claude otherwise.
  if (!isAllowed(config.allowedSenders, env.sourceUuid, env.sourceNumber)) {
    console.error(
      `[claude-signal] dropped message from non-allowlisted sender ${
        env.sourceUuid ?? env.sourceNumber ?? '?'
      }`,
    )
    return { emitted: false, reason: 'sender not allowlisted' }
  }

  const sender_ = canonicalSender(env.sourceUuid, env.sourceNumber)
  const dmTimestamp =
    dataMessage.timestamp ?? env.timestamp ?? Date.now()

  // Dedupe. Edits use their own ts so they don't collide with the original.
  const dedupeKey = editedFromTimestamp
    ? `${sender_}|edit:${dmTimestamp}`
    : `${sender_}|${dmTimestamp}`
  if (isDuplicate(dedupeKey)) {
    return { emitted: false, reason: 'duplicate' }
  }

  if (lastRecipient !== sender_) {
    console.error(
      `[claude-signal] DM from ${sender_} (${env.sourceName ?? '?'})`,
    )
  }
  lastRecipient = sender_

  const rawText = dataMessage.message ?? ''

  // Permission verdict short-circuit. Must happen before we emit any channel
  // event so the reply text never leaks into Claude's context.
  const verdict = rawText.match(VERDICT_REGEX)
  if (verdict) {
    const word = verdict[1]!.toLowerCase()
    const requestId = verdict[2]!.toLowerCase()
    const behavior: 'allow' | 'deny' =
      word === 'y' || word === 'yes' ? 'allow' : 'deny'
    try {
      await sink.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: requestId, behavior },
      })
    } catch (err) {
      console.error('[claude-signal] failed to emit permission verdict:', err)
    }
    return { emitted: true, reason: 'verdict' }
  }

  // Reactions land as dataMessage with a `reaction` field. Emit as channel
  // event with kind=reaction so Claude has context; content is derived from
  // the emoji.
  if (dataMessage.reaction) {
    const r = dataMessage.reaction
    const meta: Record<string, string> = {
      kind: 'reaction',
      user_id: env.sourceNumber ?? '',
      user_uuid: env.sourceUuid ?? '',
      username: env.sourceName ?? '',
      timestamp: String(dmTimestamp),
      emoji: r.emoji ?? '',
      reaction_remove: r.isRemove ? 'true' : 'false',
    }
    if (r.targetSentTimestamp !== undefined) {
      meta.target_timestamp = String(r.targetSentTimestamp)
    }
    const targetAuthor =
      r.targetAuthorUuid ?? r.targetAuthor ?? r.targetAuthorNumber
    if (targetAuthor) meta.target_author = targetAuthor
    const content = r.isRemove
      ? `(reaction removed: ${r.emoji ?? ''})`
      : `(reaction: ${r.emoji ?? ''})`
    await sink.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    })
    return { emitted: true, reason: 'reaction' }
  }

  // Copy attachments (if any) into the local inbox. Errors per attachment
  // don't block the notification; they surface in attachment_error.
  const attachments = dataMessage.attachments ?? []
  const copied: CopiedAttachment[] = []
  const errors: string[] = []
  const isViewOnce = dataMessage.viewOnce || dataMessage.isViewOnce
  if (attachments.length > 0 && !isViewOnce) {
    for (const att of attachments) {
      try {
        copied.push(await copyInboundAttachment(att, dmTimestamp, config))
      } catch (err) {
        const id = att.id ?? '?'
        const msg = (err as Error).message
        console.error(
          `[claude-signal] attachment copy failed for id=${id}: ${msg}`,
        )
        errors.push(`${id}: ${msg}`)
      }
    }
  }

  const meta: Record<string, string> = {
    user_id: env.sourceNumber ?? '',
    user_uuid: env.sourceUuid ?? '',
    username: env.sourceName ?? '',
    timestamp: String(dmTimestamp),
  }
  if (editedFromTimestamp !== undefined) {
    meta.edited_from_timestamp = String(editedFromTimestamp)
  }
  if (isViewOnce) {
    meta.view_once = 'true'
  }

  // Quote context: useful so Claude knows which message the user is replying
  // to.
  if (dataMessage.quote) {
    const q = dataMessage.quote
    if (q.id !== undefined) meta.quote_timestamp = String(q.id)
    const author = q.authorUuid ?? q.author ?? q.authorNumber
    if (author) meta.quote_author = author
    if (q.text) meta.quote_text = q.text.slice(0, 500)
  }

  // Mentions: serialize for Claude to inspect; rare in DMs, primarily useful
  // for future group support.
  if (dataMessage.mentions && dataMessage.mentions.length > 0) {
    meta.mentions = JSON.stringify(
      dataMessage.mentions.map(m => ({
        start: m.start,
        length: m.length,
        uuid: m.uuid,
        number: m.number,
      })),
    )
  }

  // Stickers: no file download in v1; just metadata.
  if (dataMessage.sticker) {
    meta.kind = 'sticker'
    if (dataMessage.sticker.packId) meta.sticker_pack_id = dataMessage.sticker.packId
    if (dataMessage.sticker.stickerId !== undefined) {
      meta.sticker_id = String(dataMessage.sticker.stickerId)
    }
  }

  let content = rawText

  if (copied.length > 0) {
    const firstImage = copied.find(c => c.kind === 'image')
    const firstVoice = copied.find(c => c.kind === 'audio' && c.voiceNote)
    const firstAudio = firstVoice ?? copied.find(c => c.kind === 'audio')
    const firstFile = copied.find(c => c.kind === 'file')

    if (firstImage) meta.image_path = firstImage.path
    if (firstAudio) {
      meta.audio_path = firstAudio.path
      meta.audio_mime = firstAudio.mime
      if (firstAudio.voiceNote) meta.voice_note = 'true'
    }
    if (firstFile) {
      meta.file_path = firstFile.path
      meta.file_mime = firstFile.mime
      meta.file_name = firstFile.filename
      meta.file_size = String(firstFile.size)
    }

    // Always include the full manifest so Claude can reach subsequent files
    // (multi-image DM, image + voice, etc.) even when only one path fits in
    // the dedicated slot.
    meta.attachments_json = JSON.stringify(
      copied.map(c => ({
        path: c.path,
        mime: c.mime,
        size: c.size,
        kind: c.kind,
        voice_note: c.voiceNote,
        filename: c.filename,
      })),
    )

    if (!content) {
      if (firstImage) content = `(Bild: ${firstImage.filename})`
      else if (firstVoice) content = `(Sprachnachricht: ${firstVoice.filename})`
      else if (firstAudio) content = `(Audio: ${firstAudio.filename})`
      else if (firstFile) content = `(Datei: ${firstFile.filename})`
      else content = '(Anhang)'
    }
  } else if (attachments.length > 0 && isViewOnce) {
    content = rawText || '(view-once media — bytes intentionally not saved)'
  } else if (attachments.length > 0 && errors.length === attachments.length) {
    content = rawText || '(Anhang — Kopie fehlgeschlagen)'
  }

  if (errors.length > 0) {
    meta.attachment_error = errors.join('; ').slice(0, 500)
  }

  if (!content && !copied.length && !dataMessage.sticker) {
    // Empty frame (rare, e.g. delivery of just a receipt-like envelope that
    // slipped through earlier filters). Skip rather than emit an empty event.
    return { emitted: false, reason: 'empty' }
  }

  try {
    await sink.notification({
      method: 'notifications/claude/channel',
      params: { content: content || '(empty message)', meta },
    })
  } catch (err) {
    console.error('[claude-signal] failed to emit channel event:', err)
    return { emitted: false, reason: 'sink error' }
  }

  // Typing + read-receipt acknowledgements. Keep going even if these fail —
  // they're nice-to-haves.
  if (sender_) {
    startTypingPulse(sender_, sender, config.typingTimeoutMs)
    if (config.sendReadReceipts && !editedFromTimestamp) {
      void sender
        .sendReceipt(sender_, [dmTimestamp])
        .catch(err =>
          console.error('[claude-signal] sendReceipt failed:', (err as Error).message),
        )
    }
  }

  return { emitted: true }
}

// =============================================================================
// signal-cli JSON-RPC wrapper
// =============================================================================

// Note: signal-cli's JSON-RPC param names mirror the CLI flags 1:1. We aim at
// v0.14.x, which accepts `recipient` as an array of recipient strings (E.164
// or UUID). The daemon returns `{timestamp}` for single-recipient DMs; for
// multi-recipient sends the shape is slightly different but we never send to
// more than one at a time.

export function makeOutboundSender(
  rpc: SignalRpcClient,
  config: Config,
): OutboundSender {
  async function sendMessage(args: {
    recipient: string
    message: string
    attachments?: string[]
    voiceNote?: boolean
    quoteTimestamp?: number
    quoteAuthor?: string
    quoteMessage?: string
    editTimestamp?: number
  }): Promise<{ timestamp: number }> {
    let messageText = args.message
    let textStyles: string[] | undefined
    if (config.parseMarkdown && args.message.length > 0) {
      const parsed = parseMarkdownStyles(args.message)
      messageText = parsed.text
      if (parsed.styles.length > 0) {
        textStyles = textStylesToRpcStrings(parsed.styles)
      }
    }
    const params: Record<string, unknown> = {
      account: config.account,
      recipient: [args.recipient],
      message: messageText,
    }
    if (textStyles) params.textStyles = textStyles
    if (args.attachments && args.attachments.length > 0) {
      params.attachment = args.attachments
    }
    if (args.voiceNote) params.voiceNote = true
    if (args.quoteTimestamp !== undefined) {
      params.quoteTimestamp = args.quoteTimestamp
      if (args.quoteAuthor) params.quoteAuthor = args.quoteAuthor
      if (args.quoteMessage) params.quoteMessage = args.quoteMessage
    }
    if (args.editTimestamp !== undefined) {
      params.editTimestamp = args.editTimestamp
    }
    const res = (await rpc.call('send', params)) as {
      timestamp?: number
      results?: unknown
    }
    const ts =
      typeof res?.timestamp === 'number' ? res.timestamp : Date.now()
    sentTimestamps.add(ts)
    return { timestamp: ts }
  }

  async function sendTyping(recipient: string, typing: boolean): Promise<void> {
    await rpc.call(
      'sendTyping',
      {
        account: config.account,
        recipient: [recipient],
        stop: !typing,
      },
      5_000,
    )
  }

  async function sendReceipt(
    recipient: string,
    targetTimestamps: number[],
  ): Promise<void> {
    await rpc.call(
      'sendReceipt',
      {
        account: config.account,
        recipient,
        type: 'read',
        targetTimestamp: targetTimestamps,
      },
      5_000,
    )
  }

  async function sendReaction(args: {
    recipient: string
    emoji: string
    targetAuthor: string
    targetTimestamp: number
    remove?: boolean
  }): Promise<{ timestamp: number }> {
    const res = (await rpc.call('sendReaction', {
      account: config.account,
      recipient: [args.recipient],
      emoji: args.emoji,
      targetAuthor: args.targetAuthor,
      targetTimestamp: args.targetTimestamp,
      remove: Boolean(args.remove),
    })) as { timestamp?: number }
    const ts = typeof res?.timestamp === 'number' ? res.timestamp : Date.now()
    sentTimestamps.add(ts)
    return { timestamp: ts }
  }

  return { sendMessage, sendTyping, sendReceipt, sendReaction }
}

// =============================================================================
// MCP server
// =============================================================================

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

const INSTRUCTIONS =
  'You are connected to a Signal Messenger user via signal-cli. Inbound DMs arrive as ' +
  '<channel source="claude-signal" user_id="..." user_uuid="..." username="..." timestamp="..." ...>. ' +
  'Four tools are available: `reply` sends a DM to whoever last messaged the bot (use for in-conversation responses). ' +
  '`push` ALWAYS targets the configured default recipient — use ONLY for proactive, unsolicited messages from scheduled sessions. ' +
  '`react` sends an emoji reaction to a specific inbound message (pass its `timestamp` + `user_uuid` as target_author). ' +
  '`typing` manually toggles the typing indicator for long-running work (auto-managed otherwise). ' +
  'When a channel event carries `image_path`, `audio_path`, or `file_path` in meta, use the Read tool on that absolute path — it is a file the user attached. ' +
  '`voice_note="true"` means the user sent an audio message whose bytes live at `audio_path`; the adapter does not transcribe, and you cannot process audio content directly — acknowledge and ask them to type what they said if you need to act on it. ' +
  '`attachments_json` (if present) is a JSON array listing ALL attachments when a DM had multiple. ' +
  '`quote_timestamp` + `quote_author` + `quote_text` indicate the user replied to a previous message; use `quote_timestamp` when calling `reply` with `quote_timestamp` to thread the response. ' +
  'Permission prompts are forwarded to the same DM thread as replies; the user answers with "yes <id>" or "no <id>". ' +
  'If `attachment_error` is set, the adapter could not copy the file — let the user know briefly and continue.'

export function buildMcpServer(
  config: Config,
  getSender: () => OutboundSender,
): Server {
  const mcp = new Server(
    { name: 'claude-signal', version: '0.1.0' },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Send a DM back to the Signal user who is currently chatting with the bot. ' +
          'Recipient resolves to whoever last DMed the bot (falling back to SIGNAL_DEFAULT_RECIPIENT). ' +
          'Attachments are absolute paths to local files; send voice notes by setting voice_note=true with an audio file attached. ' +
          'Returns the sent-timestamp so you can react to or edit this message later.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Message text (may be empty if sending attachments only)' },
            attachments: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute paths to local files to attach (images, PDFs, audio, …)',
            },
            voice_note: {
              type: 'boolean',
              description: 'Mark audio attachment(s) as a real voice note (plays inline in Signal)',
            },
            quote_timestamp: {
              type: 'number',
              description: 'Timestamp of the inbound message to thread-reply to (from meta.timestamp)',
            },
            quote_author: {
              type: 'string',
              description: 'UUID or E.164 of the quoted message author (usually the user_uuid/user_id from meta)',
            },
            quote_text: {
              type: 'string',
              description: 'Quoted snippet of the original message (shown in Signal\'s quote preview)',
            },
            edit_timestamp: {
              type: 'number',
              description: 'Edit a previously sent message by its timestamp',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'push',
        description:
          'Send an UNSOLICITED DM to the default Signal recipient (SIGNAL_DEFAULT_RECIPIENT). ' +
          'Use ONLY for proactive, scheduled, or cron-driven messages with no active conversation. ' +
          'For responding to a DM the user just sent, use `reply` instead.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Message text' },
            attachments: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute paths to local files to attach',
            },
            voice_note: { type: 'boolean', description: 'Mark audio as voice note' },
          },
          required: ['text'],
        },
      },
      {
        name: 'react',
        description:
          'Send an emoji reaction to a specific inbound message. target_timestamp + target_author come from the inbound event\'s meta (timestamp + user_uuid).',
        inputSchema: {
          type: 'object',
          properties: {
            target_timestamp: { type: 'number', description: 'Timestamp of the message to react to' },
            target_author: {
              type: 'string',
              description: 'UUID or E.164 of the target message author',
            },
            emoji: { type: 'string', description: 'Single emoji character' },
            remove: { type: 'boolean', description: 'True to remove an existing reaction' },
          },
          required: ['target_timestamp', 'target_author', 'emoji'],
        },
      },
      {
        name: 'typing',
        description:
          'Toggle the typing indicator for the current recipient. Normally managed automatically (pulsed while awaiting a reply); use this to show activity during long-running tool work.',
        inputSchema: {
          type: 'object',
          properties: {
            on: { type: 'boolean', description: 'True to show, false to clear' },
          },
          required: ['on'],
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const sender = getSender()

    try {
      if (name === 'reply' || name === 'push') {
        const text = args.text
        if (typeof text !== 'string') {
          return errorResult(`${name}: "text" argument must be a string`)
        }
        const attachments = validateAttachments(args.attachments, config)
        const voiceNote = typeof args.voice_note === 'boolean' ? args.voice_note : false
        const recipient =
          name === 'reply' ? resolvePreferLastSender(config) : resolveDefaultOnly(config)
        const res = await sender.sendMessage({
          recipient,
          message: text,
          attachments,
          voiceNote,
          quoteTimestamp:
            typeof args.quote_timestamp === 'number' ? args.quote_timestamp : undefined,
          quoteAuthor:
            typeof args.quote_author === 'string' ? args.quote_author : undefined,
          quoteMessage:
            typeof args.quote_text === 'string' ? args.quote_text : undefined,
          editTimestamp:
            typeof args.edit_timestamp === 'number' ? args.edit_timestamp : undefined,
        })
        stopTypingPulse(recipient)
        return {
          content: [
            { type: 'text', text: `sent (timestamp=${res.timestamp})` },
          ],
        }
      }
      if (name === 'react') {
        const ts = args.target_timestamp
        const author = args.target_author
        const emoji = args.emoji
        if (typeof ts !== 'number' || !Number.isFinite(ts)) {
          return errorResult('react: target_timestamp must be a number')
        }
        if (typeof author !== 'string' || !author) {
          return errorResult('react: target_author must be a non-empty string')
        }
        if (typeof emoji !== 'string' || !emoji) {
          return errorResult('react: emoji must be a non-empty string')
        }
        const recipient = resolvePreferLastSender(config)
        const remove = typeof args.remove === 'boolean' ? args.remove : false
        const res = await sender.sendReaction({
          recipient,
          emoji,
          targetAuthor: author,
          targetTimestamp: ts,
          remove,
        })
        return {
          content: [
            { type: 'text', text: `reaction sent (timestamp=${res.timestamp})` },
          ],
        }
      }
      if (name === 'typing') {
        const on = args.on
        if (typeof on !== 'boolean') {
          return errorResult('typing: "on" must be a boolean')
        }
        const recipient = resolvePreferLastSender(config)
        if (on) {
          startTypingPulse(recipient, sender, config.typingTimeoutMs)
        } else {
          stopTypingPulse(recipient)
          await sender.sendTyping(recipient, false).catch(() => {})
        }
        return { content: [{ type: 'text', text: on ? 'typing on' : 'typing off' }] }
      }
      throw new Error(`unknown tool: ${name}`)
    } catch (err) {
      return errorResult(
        `${name} failed: ${(err as Error).message}`,
      )
    }
  })

  mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    const msg =
      `🔐 Claude wants to run *${params.tool_name}*:\n` +
      `${params.description}\n\n` +
      `\`${params.input_preview}\`\n\n` +
      `Reply: "yes ${params.request_id}" or "no ${params.request_id}"`
    try {
      const sender = getSender()
      const recipient = resolvePreferLastSender(config)
      await sender.sendMessage({ recipient, message: msg })
    } catch (err) {
      console.error('[claude-signal] failed to forward permission prompt:', err)
    }
  })

  return mcp
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  }
}

function validateAttachments(
  raw: unknown,
  config: Config,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error('attachments must be an array of paths')
  const out: string[] = []
  for (const p of raw) {
    if (typeof p !== 'string' || !p) {
      throw new Error('each attachment must be a non-empty string path')
    }
    if (!p.startsWith('/')) {
      throw new Error(`attachment must be an absolute path: ${p}`)
    }
    if (!existsSync(p)) {
      throw new Error(`attachment not found: ${p}`)
    }
    const st = statSync(p)
    if (!st.isFile()) {
      throw new Error(`attachment is not a regular file: ${p}`)
    }
    if (st.size > config.maxSendBytes) {
      throw new Error(
        `attachment ${p} size ${st.size} exceeds SIGNAL_MAX_SEND_BYTES ${config.maxSendBytes}`,
      )
    }
    out.push(p)
  }
  return out.length > 0 ? out : undefined
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const config = loadConfig()
  ensureInboxDir(config.inboxDir)
  const removed = gcInbox(config.inboxDir, 7 * 24 * 60 * 60 * 1000)
  console.error(
    `[claude-signal] inbox ${config.inboxDir}${
      removed > 0 ? ` (gc removed ${removed} old files)` : ''
    }`,
  )

  let currentSender: OutboundSender | undefined
  const getSender = (): OutboundSender => {
    if (!currentSender) {
      throw new Error('signal-cli socket not yet connected')
    }
    return currentSender
  }
  const mcp = buildMcpServer(config, getSender)

  let shuttingDown = false
  let backoffMs = 1000

  const connectLoop = async (): Promise<void> => {
    while (!shuttingDown) {
      const rpc = new SignalRpcClient({
        socketPath: config.socketPath,
        onNotification: msg => {
          if (msg.method === 'receive') {
            if (config.debugDumpEvents) {
              try {
                console.error(
                  `[claude-signal] receive: ${JSON.stringify(msg.params).slice(0, 1200)}`,
                )
              } catch {}
            }
            void handleReceiveNotification(
              msg.params as ReceivePayload,
              config,
              mcp,
              getSender(),
            ).catch(err => {
              console.error('[claude-signal] handler error:', err)
            })
          } else if (config.debugDumpEvents) {
            console.error(`[claude-signal] ignored notification: ${msg.method}`)
          }
        },
        onClose: err => {
          if (shuttingDown) return
          console.error(
            `[claude-signal] socket closed${
              err ? ` (${err.message})` : ''
            }; will reconnect`,
          )
        },
      })
      try {
        const closedPromise = new Promise<void>(resolve => {
          rpc.onClose(() => resolve())
        })
        await rpc.connect()
        currentSender = makeOutboundSender(rpc, config)
        backoffMs = 1000
        console.error(
          `[claude-signal] connected to ${config.socketPath}; account=${config.account}`,
        )
        await closedPromise
      } catch (err) {
        console.error(
          `[claude-signal] connect failed: ${(err as Error).message}; retrying in ${backoffMs}ms`,
        )
      }
      currentSender = undefined
      _resetTypingPulses()
      if (shuttingDown) return
      await new Promise(resolve => setTimeout(resolve, backoffMs))
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
  }

  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[claude-signal] received ${signal}, shutting down`)
    _resetTypingPulses()
    mcp.close().catch(err => console.error('[claude-signal] mcp close:', err))
    setTimeout(() => process.exit(0), 500)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  await mcp.connect(new StdioServerTransport())
  await connectLoop()
}

if (import.meta.main) {
  main().catch(err => {
    console.error('[claude-signal] fatal:', err)
    process.exit(1)
  })
}
