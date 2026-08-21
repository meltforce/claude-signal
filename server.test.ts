import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server as NetServer } from 'node:net'
import {
  ENVELOPE_FIELDS,
  type FieldCheck,
  _resetDedupe,
  _resetLastRecipient,
  _resetTypingPulses,
  _setLastRecipient,
  canonicalSender,
  classifyMime,
  DEDUPE_CAP,
  DEDUPE_TTL_MS,
  copyInboundAttachment,
  ensureInboxDir,
  extFromMime,
  gcInbox,
  handleReceiveNotification,
  isAllowed,
  isDuplicate,
  loadConfig,
  makeOutboundSender,
  parseAllowlist,
  parseMarkdownStyles,
  textStylesToRpcStrings,
  resolveDefaultOnly,
  resolvePreferLastSender,
  safeFilename,
  SignalRpcClient,
  VERDICT_REGEX,
  type Config,
  type NotifySink,
  type OutboundSender,
  type ReceivePayload,
} from './server.ts'

// =============================================================================
// Fixtures
// =============================================================================

let tmpAttach: string
let tmpInbox: string

beforeEach(() => {
  _resetDedupe()
  _resetLastRecipient()
  _resetTypingPulses()
  tmpAttach = mkdtempSync(join(tmpdir(), 'claude-signal-attach-'))
  tmpInbox = mkdtempSync(join(tmpdir(), 'claude-signal-inbox-'))
})

afterEach(() => {
  try { rmSync(tmpAttach, { recursive: true, force: true }) } catch {}
  try { rmSync(tmpInbox, { recursive: true, force: true }) } catch {}
})

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    account: '+493045310892',
    allowedSenders: new Set(['+491234567890', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']),
    socketPath: '/tmp/nonexistent.sock',
    defaultRecipient: undefined,
    attachDir: tmpAttach,
    inboxDir: tmpInbox,
    maxAttachmentBytes: 10 * 1024 * 1024,
    maxSendBytes: 10 * 1024 * 1024,
    sendReadReceipts: false,
    typingTimeoutMs: 5_000,
    debugDumpEvents: false,
    parseMarkdown: true,
    ...overrides,
  }
}

type CapturedNotification = {
  method: string
  params?: Record<string, unknown>
}

function makeSink(): { sink: NotifySink; notifications: CapturedNotification[] } {
  const notifications: CapturedNotification[] = []
  const sink: NotifySink = {
    notification: async n => {
      notifications.push(n)
    },
  }
  return { sink, notifications }
}

type SenderCall =
  | { kind: 'send'; args: Parameters<OutboundSender['sendMessage']>[0] }
  | { kind: 'typing'; recipient: string; typing: boolean }
  | { kind: 'receipt'; recipient: string; ts: number[] }
  | { kind: 'reaction'; args: Parameters<OutboundSender['sendReaction']>[0] }

function makeFakeSender(): { sender: OutboundSender; calls: SenderCall[] } {
  const calls: SenderCall[] = []
  const sender: OutboundSender = {
    sendMessage: async args => {
      calls.push({ kind: 'send', args })
      return { timestamp: 1_700_000_000_000 }
    },
    sendTyping: async (recipient, typing) => {
      calls.push({ kind: 'typing', recipient, typing })
    },
    sendReceipt: async (recipient, ts) => {
      calls.push({ kind: 'receipt', recipient, ts })
    },
    sendReaction: async args => {
      calls.push({ kind: 'reaction', args })
      return { timestamp: 1_700_000_000_001 }
    },
  }
  return { sender, calls }
}

function buildPayload(overrides: {
  sourceNumber?: string
  sourceUuid?: string
  sourceName?: string
  timestamp?: number
  dataMessage?: ReceivePayload['envelope'] extends infer E ? E extends { dataMessage?: infer D } ? D : never : never
  editMessage?: ReceivePayload['envelope'] extends infer E ? E extends { editMessage?: infer D } ? D : never : never
  account?: string
  extra?: Record<string, unknown>
}): ReceivePayload {
  return {
    account: overrides.account ?? '+493045310892',
    envelope: {
      sourceNumber: overrides.sourceNumber ?? '+491234567890',
      sourceUuid: overrides.sourceUuid,
      sourceName: overrides.sourceName,
      timestamp: overrides.timestamp ?? 1_700_000_000_000,
      dataMessage: overrides.dataMessage,
      editMessage: overrides.editMessage,
      ...(overrides.extra ?? {}),
    },
  }
}

// =============================================================================
// parseAllowlist
// =============================================================================

describe('parseAllowlist', () => {
  test('accepts E.164 numbers', () => {
    const set = parseAllowlist('+491234567890, +493045310892')
    expect(set.has('+491234567890')).toBe(true)
    expect(set.has('+493045310892')).toBe(true)
  })
  test('accepts UUIDs and lowercases them', () => {
    const set = parseAllowlist('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
    expect(set.has('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(true)
  })
  test('mixes E.164 and UUIDs', () => {
    const set = parseAllowlist('+491234567890, 12345678-1234-1234-1234-123456789abc')
    expect(set.size).toBe(2)
  })
  test('throws on empty allowlist', () => {
    expect(() => parseAllowlist('')).toThrow()
    expect(() => parseAllowlist('  , , ')).toThrow()
  })
  test('throws on garbage entry', () => {
    expect(() => parseAllowlist('not-a-phone-or-uuid')).toThrow()
    expect(() => parseAllowlist('+491234567890, garbage')).toThrow()
  })
})

// =============================================================================
// VERDICT_REGEX
// =============================================================================

describe('VERDICT_REGEX', () => {
  test('matches "yes abcde"', () => {
    const m = 'yes abcde'.match(VERDICT_REGEX)
    expect(m?.[1]).toBe('yes')
    expect(m?.[2]).toBe('abcde')
  })
  test('matches uppercase autocorrect', () => {
    const m = 'Yes Abcde'.match(VERDICT_REGEX)
    expect(m?.[1]?.toLowerCase()).toBe('yes')
    expect(m?.[2]?.toLowerCase()).toBe('abcde')
  })
  test('rejects IDs containing l', () => {
    expect('yes abcle'.match(VERDICT_REGEX)).toBeNull()
  })
  test('rejects free text', () => {
    expect('yes please'.match(VERDICT_REGEX)).toBeNull()
    expect('approve it'.match(VERDICT_REGEX)).toBeNull()
  })
  test('matches no variant', () => {
    expect('no abcde'.match(VERDICT_REGEX)?.[1]).toBe('no')
    expect('n abcde'.match(VERDICT_REGEX)?.[1]).toBe('n')
  })
})

// =============================================================================
// Dedupe
// =============================================================================

describe('isDuplicate', () => {
  test('first call returns false, second returns true', () => {
    expect(isDuplicate('k1')).toBe(false)
    expect(isDuplicate('k1')).toBe(true)
  })
  test('distinct keys do not collide', () => {
    expect(isDuplicate('k1')).toBe(false)
    expect(isDuplicate('k2')).toBe(false)
  })
  test('exports correct TTL and cap constants', () => {
    expect(DEDUPE_TTL_MS).toBeGreaterThan(0)
    expect(DEDUPE_CAP).toBeGreaterThan(0)
  })
})

// =============================================================================
// Classification helpers
// =============================================================================

describe('classifyMime', () => {
  test('image/* → image', () => {
    expect(classifyMime('image/jpeg')).toBe('image')
    expect(classifyMime('IMAGE/PNG')).toBe('image')
  })
  test('audio/* → audio', () => {
    expect(classifyMime('audio/aac')).toBe('audio')
    expect(classifyMime('audio/ogg')).toBe('audio')
  })
  test('other → file', () => {
    expect(classifyMime('application/pdf')).toBe('file')
    expect(classifyMime('video/mp4')).toBe('file')
    expect(classifyMime('')).toBe('file')
  })
})

describe('extFromMime', () => {
  test('maps common MIME types to extensions', () => {
    expect(extFromMime('image/jpeg')).toBe('.jpg')
    expect(extFromMime('image/png')).toBe('.png')
    expect(extFromMime('audio/ogg')).toBe('.ogg')
    expect(extFromMime('application/pdf')).toBe('.pdf')
  })
  test('returns empty for unknown MIMEs', () => {
    expect(extFromMime('weird/unknown')).toBe('')
    expect(extFromMime(undefined)).toBe('')
  })
})

describe('safeFilename', () => {
  test('preserves alnum + dot underscore dash', () => {
    expect(safeFilename('IMG_1234.jpg', '.jpg')).toBe('IMG_1234.jpg')
  })
  test('replaces path separators with underscore', () => {
    expect(safeFilename('../../etc/passwd', '')).not.toContain('/')
  })
  test('adds fallback extension if none present', () => {
    expect(safeFilename('voice-note', '.ogg')).toBe('voice-note.ogg')
  })
  test('treats punctuation-only name as empty', () => {
    expect(safeFilename('////', '.jpg')).toBe('attachment.jpg')
  })
})

// =============================================================================
// Sender gating
// =============================================================================

describe('isAllowed / canonicalSender', () => {
  test('allows by UUID (case-insensitive)', () => {
    const allow = new Set(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'])
    expect(isAllowed(allow, 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', '+49123')).toBe(true)
  })
  test('allows by number when UUID not in list', () => {
    const allow = new Set(['+491234567890'])
    expect(isAllowed(allow, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '+491234567890')).toBe(true)
  })
  test('rejects unknown sender', () => {
    const allow = new Set(['+491234567890'])
    expect(isAllowed(allow, undefined, '+49999')).toBe(false)
  })
  test('canonicalSender prefers UUID lowercased', () => {
    expect(canonicalSender('AAAA', '+49')).toBe('aaaa')
    expect(canonicalSender(undefined, '+49')).toBe('+49')
  })
})

// =============================================================================
// Recipient resolution
// =============================================================================

describe('resolvePreferLastSender / resolveDefaultOnly', () => {
  test('reply uses lastRecipient when set', () => {
    _setLastRecipient('+491234567890')
    expect(resolvePreferLastSender(makeConfig({ defaultRecipient: '+499' }))).toBe('+491234567890')
  })
  test('reply falls back to default', () => {
    expect(resolvePreferLastSender(makeConfig({ defaultRecipient: '+499' }))).toBe('+499')
  })
  test('reply throws when neither set', () => {
    expect(() => resolvePreferLastSender(makeConfig())).toThrow()
  })
  test('push ignores lastRecipient', () => {
    _setLastRecipient('+491234567890')
    expect(resolveDefaultOnly(makeConfig({ defaultRecipient: '+499' }))).toBe('+499')
  })
  test('push throws when default unset', () => {
    _setLastRecipient('+491234567890')
    expect(() => resolveDefaultOnly(makeConfig())).toThrow()
  })
})

// =============================================================================
// Attachment copy
// =============================================================================

describe('copyInboundAttachment', () => {
  test('copies source file to inbox with extension and returns meta', async () => {
    writeFileSync(join(tmpAttach, 'att-1'), 'fake-jpeg-bytes')
    const res = await copyInboundAttachment(
      { id: 'att-1', contentType: 'image/jpeg', filename: 'photo.jpg', size: 15 },
      1_700_000_000_000,
      makeConfig(),
    )
    expect(res.kind).toBe('image')
    expect(res.mime).toBe('image/jpeg')
    expect(res.path).toStartWith(tmpInbox)
    expect(res.path).toEndWith('photo.jpg')
    expect(res.size).toBe(15)
  })
  test('marks voice notes via isVoiceNote flag', async () => {
    writeFileSync(join(tmpAttach, 'att-2'), 'oggbytes')
    const res = await copyInboundAttachment(
      { id: 'att-2', contentType: 'audio/ogg', isVoiceNote: true },
      1_700_000_000_000,
      makeConfig(),
    )
    expect(res.kind).toBe('audio')
    expect(res.voiceNote).toBe(true)
    expect(res.path).toEndWith('.ogg')
  })
  test('throws when source missing', async () => {
    await expect(
      copyInboundAttachment(
        { id: 'missing', contentType: 'image/png' },
        1_700_000_000_000,
        makeConfig(),
      ),
    ).rejects.toThrow(/source file missing/)
  })
  test('throws when file exceeds maxAttachmentBytes', async () => {
    const big = Buffer.alloc(2000, 'x')
    writeFileSync(join(tmpAttach, 'big'), big)
    await expect(
      copyInboundAttachment(
        { id: 'big', contentType: 'application/octet-stream' },
        1_700_000_000_000,
        makeConfig({ maxAttachmentBytes: 1000 }),
      ),
    ).rejects.toThrow(/exceeds/)
  })
})

// =============================================================================
// ensureInboxDir / gcInbox
// =============================================================================

describe('inbox management', () => {
  test('ensureInboxDir creates dir with 0700 and survives on existing', () => {
    const dir = join(tmpInbox, 'nested', 'inbox')
    ensureInboxDir(dir)
    ensureInboxDir(dir) // idempotent
  })
  test('gcInbox removes files older than maxAge', () => {
    writeFileSync(join(tmpInbox, 'old.txt'), 'old')
    writeFileSync(join(tmpInbox, 'new.txt'), 'new')
    // Backdate old.txt: use fs.utimesSync
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const { utimesSync } = require('node:fs') as typeof import('node:fs')
    utimesSync(join(tmpInbox, 'old.txt'), past, past)
    const removed = gcInbox(tmpInbox, 7 * 24 * 60 * 60 * 1000)
    expect(removed).toBe(1)
  })
})

// =============================================================================
// handleReceiveNotification
// =============================================================================

describe('handleReceiveNotification', () => {
  test('drops group messages', async () => {
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    const res = await handleReceiveNotification(
      buildPayload({
        dataMessage: { timestamp: 1, message: 'hi group', groupInfo: { groupId: 'gid==' } },
      }),
      makeConfig(),
      sink,
      sender,
    )
    expect(res.emitted).toBe(false)
    expect(notifications).toHaveLength(0)
  })

  test('drops non-allowlisted sender', async () => {
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    const res = await handleReceiveNotification(
      buildPayload({
        sourceNumber: '+4999999',
        dataMessage: { timestamp: 1, message: 'spam' },
      }),
      makeConfig(),
      sink,
      sender,
    )
    expect(res.emitted).toBe(false)
    expect(notifications).toHaveLength(0)
  })

  test('emits channel event for allowed sender + text', async () => {
    const { sink, notifications } = makeSink()
    const { sender, calls } = makeFakeSender()
    const res = await handleReceiveNotification(
      buildPayload({
        dataMessage: { timestamp: 123, message: 'hallo claude' },
      }),
      makeConfig(),
      sink,
      sender,
    )
    expect(res.emitted).toBe(true)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.method).toBe('notifications/claude/channel')
    expect(notifications[0]!.params?.content).toBe('hallo claude')
    const meta = notifications[0]!.params?.meta as Record<string, string>
    expect(meta.user_id).toBe('+491234567890')
    expect(meta.timestamp).toBe('123')
    // typing pulse should have kicked off (but not receipt since flag off)
    expect(calls.some(c => c.kind === 'typing' && c.typing)).toBe(true)
    expect(calls.some(c => c.kind === 'receipt')).toBe(false)
  })

  test('emits read receipt when enabled', async () => {
    const { sink } = makeSink()
    const { sender, calls } = makeFakeSender()
    await handleReceiveNotification(
      buildPayload({ dataMessage: { timestamp: 42, message: 'hi' } }),
      makeConfig({ sendReadReceipts: true }),
      sink,
      sender,
    )
    // Receipts fire async; wait a microtask so the fire-and-forget resolves.
    await new Promise(r => setTimeout(r, 10))
    expect(calls.some(c => c.kind === 'receipt' && c.ts.includes(42))).toBe(true)
  })

  test('verdict short-circuits and emits permission notification', async () => {
    const { sink, notifications } = makeSink()
    const { sender, calls } = makeFakeSender()
    const res = await handleReceiveNotification(
      buildPayload({ dataMessage: { timestamp: 1, message: 'yes abcde' } }),
      makeConfig(),
      sink,
      sender,
    )
    expect(res.emitted).toBe(true)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.method).toBe('notifications/claude/channel/permission')
    expect(notifications[0]!.params).toEqual({ request_id: 'abcde', behavior: 'allow' })
    // Verdicts must not trigger typing/receipt chatter.
    expect(calls).toHaveLength(0)
  })

  test('deduplicates same (sender, timestamp) key', async () => {
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    const p = buildPayload({ dataMessage: { timestamp: 9, message: 'hi' } })
    await handleReceiveNotification(p, makeConfig(), sink, sender)
    await handleReceiveNotification(p, makeConfig(), sink, sender)
    expect(notifications).toHaveLength(1)
  })

  test('image attachment → image_path + attachments_json', async () => {
    writeFileSync(join(tmpAttach, 'img-1'), 'jpegdata')
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    await handleReceiveNotification(
      buildPayload({
        dataMessage: {
          timestamp: 1,
          message: null,
          attachments: [
            { id: 'img-1', contentType: 'image/jpeg', filename: 'pic.jpg' },
          ],
        },
      }),
      makeConfig(),
      sink,
      sender,
    )
    const meta = notifications[0]!.params?.meta as Record<string, string>
    expect(meta.image_path).toContain('pic.jpg')
    expect(JSON.parse(meta.attachments_json!)).toHaveLength(1)
    expect(notifications[0]!.params?.content).toStartWith('(Bild:')
  })

  test('voice note → audio_path + voice_note=true', async () => {
    writeFileSync(join(tmpAttach, 'voice-1'), 'oggdata')
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    await handleReceiveNotification(
      buildPayload({
        dataMessage: {
          timestamp: 1,
          message: null,
          attachments: [
            { id: 'voice-1', contentType: 'audio/ogg', isVoiceNote: true },
          ],
        },
      }),
      makeConfig(),
      sink,
      sender,
    )
    const meta = notifications[0]!.params?.meta as Record<string, string>
    expect(meta.audio_path).toContain('.ogg')
    expect(meta.voice_note).toBe('true')
    expect(notifications[0]!.params?.content).toStartWith('(Sprachnachricht')
  })

  test('multiple attachments surface in attachments_json', async () => {
    writeFileSync(join(tmpAttach, 'a-1'), 'a')
    writeFileSync(join(tmpAttach, 'a-2'), 'b')
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    await handleReceiveNotification(
      buildPayload({
        dataMessage: {
          timestamp: 1,
          message: 'two files',
          attachments: [
            { id: 'a-1', contentType: 'image/png' },
            { id: 'a-2', contentType: 'application/pdf' },
          ],
        },
      }),
      makeConfig(),
      sink,
      sender,
    )
    const meta = notifications[0]!.params?.meta as Record<string, string>
    const list = JSON.parse(meta.attachments_json!) as unknown[]
    expect(list).toHaveLength(2)
    expect(meta.image_path).toBeDefined()
    expect(meta.file_path).toBeDefined()
  })

  test('missing source file records attachment_error', async () => {
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    await handleReceiveNotification(
      buildPayload({
        dataMessage: {
          timestamp: 1,
          message: 'no file',
          attachments: [{ id: 'nope', contentType: 'image/png' }],
        },
      }),
      makeConfig(),
      sink,
      sender,
    )
    const meta = notifications[0]!.params?.meta as Record<string, string>
    expect(meta.attachment_error).toContain('source file missing')
  })

  test('quote fields propagate into meta', async () => {
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    await handleReceiveNotification(
      buildPayload({
        dataMessage: {
          timestamp: 1,
          message: 'reply',
          quote: {
            id: 99,
            authorUuid: 'AAAA-bbbb',
            text: 'quoted original',
          },
        },
      }),
      makeConfig(),
      sink,
      sender,
    )
    const meta = notifications[0]!.params?.meta as Record<string, string>
    expect(meta.quote_timestamp).toBe('99')
    expect(meta.quote_author).toBe('AAAA-bbbb')
    expect(meta.quote_text).toBe('quoted original')
  })

  test('reaction emits channel event with kind=reaction', async () => {
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    await handleReceiveNotification(
      buildPayload({
        dataMessage: {
          timestamp: 1,
          message: null,
          reaction: {
            emoji: '🔥',
            targetAuthorUuid: 'XXXX',
            targetSentTimestamp: 777,
            isRemove: false,
          },
        },
      }),
      makeConfig(),
      sink,
      sender,
    )
    const meta = notifications[0]!.params?.meta as Record<string, string>
    expect(meta.kind).toBe('reaction')
    expect(meta.emoji).toBe('🔥')
    expect(meta.target_timestamp).toBe('777')
    expect(notifications[0]!.params?.content).toBe('(reaction: 🔥)')
  })

  test('view-once media gets flag but no image_path', async () => {
    writeFileSync(join(tmpAttach, 'vo-1'), 'x')
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    await handleReceiveNotification(
      buildPayload({
        dataMessage: {
          timestamp: 1,
          message: null,
          isViewOnce: true,
          attachments: [{ id: 'vo-1', contentType: 'image/jpeg' }],
        },
      }),
      makeConfig(),
      sink,
      sender,
    )
    const meta = notifications[0]!.params?.meta as Record<string, string>
    expect(meta.view_once).toBe('true')
    expect(meta.image_path).toBeUndefined()
  })

  test('edit message carries edited_from_timestamp', async () => {
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    await handleReceiveNotification(
      buildPayload({
        editMessage: {
          targetSentTimestamp: 111,
          dataMessage: { timestamp: 222, message: 'corrected' },
        },
      }),
      makeConfig(),
      sink,
      sender,
    )
    const meta = notifications[0]!.params?.meta as Record<string, string>
    expect(meta.edited_from_timestamp).toBe('111')
    expect(meta.timestamp).toBe('222')
    expect(notifications[0]!.params?.content).toBe('corrected')
  })

  test('typing/receipt/sync frames are dropped', async () => {
    const { sink, notifications } = makeSink()
    const { sender } = makeFakeSender()
    await handleReceiveNotification(
      { account: '+49', envelope: { sourceNumber: '+491234567890', typingMessage: {} } },
      makeConfig(),
      sink,
      sender,
    )
    await handleReceiveNotification(
      { account: '+49', envelope: { sourceNumber: '+491234567890', receiptMessage: { isRead: true, when: 1, timestamps: [1] } } },
      makeConfig(),
      sink,
      sender,
    )
    await handleReceiveNotification(
      { account: '+49', envelope: { sourceNumber: '+491234567890', syncMessage: {} } },
      makeConfig(),
      sink,
      sender,
    )
    expect(notifications).toHaveLength(0)
  })
})

// =============================================================================
// SignalRpcClient — roundtrip against a mock unix-socket server
// =============================================================================

describe('SignalRpcClient', () => {
  let server: NetServer
  let sockPath: string

  afterEach(() => {
    try { server?.close() } catch {}
    try { rmSync(sockPath, { force: true }) } catch {}
  })

  function startMock(
    handler: (req: {
      method?: string
      id?: number | string
      params?: unknown
    }) => Array<object> | undefined,
  ): Promise<void> {
    sockPath = join(mkdtempSync(join(tmpdir(), 'claude-signal-mock-')), 'sock')
    return new Promise(resolve => {
      server = createServer(conn => {
        let buf = ''
        conn.on('data', chunk => {
          buf += chunk.toString('utf8')
          let nl: number
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (!line) continue
            let parsed: { method?: string; id?: number | string; params?: unknown }
            try {
              parsed = JSON.parse(line)
            } catch { continue }
            const outs = handler(parsed) ?? []
            for (const out of outs) {
              conn.write(JSON.stringify(out) + '\n')
            }
          }
        })
      })
      server.listen(sockPath, () => resolve())
    })
  }

  test('request/response roundtrip', async () => {
    await startMock(req => [{
      jsonrpc: '2.0',
      id: req.id,
      result: { version: '0.14.2' },
    }])
    const client = new SignalRpcClient({ socketPath: sockPath })
    await client.connect()
    const res = (await client.call('version', {})) as { version: string }
    expect(res.version).toBe('0.14.2')
    client.close()
  })

  test('error response rejects', async () => {
    await startMock(req => [{
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32600, message: 'bad request' },
    }])
    const client = new SignalRpcClient({ socketPath: sockPath })
    await client.connect()
    await expect(client.call('whatever', {})).rejects.toThrow(/bad request/)
    client.close()
  })

  test('server-pushed notification is delivered to onNotification', async () => {
    const received: unknown[] = []
    await startMock(req => {
      // When the client calls 'subscribe', push two receive notifications.
      if (req.method === 'subscribe') {
        return [
          { jsonrpc: '2.0', method: 'receive', params: { hello: 'world' } },
          { jsonrpc: '2.0', id: req.id, result: null },
        ]
      }
      return []
    })
    const client = new SignalRpcClient({
      socketPath: sockPath,
      onNotification: msg => received.push(msg),
    })
    await client.connect()
    await client.call('subscribe', {})
    expect(received).toHaveLength(1)
    expect((received[0] as { method: string }).method).toBe('receive')
    client.close()
  })

  test('close rejects pending requests', async () => {
    await startMock(() => undefined) // never respond
    const client = new SignalRpcClient({ socketPath: sockPath })
    await client.connect()
    const p = client.call('neverReply', {}, 10_000)
    client.close()
    await expect(p).rejects.toThrow()
  })
})

// =============================================================================
// parseMarkdownStyles — markdown → Signal textStyles
// =============================================================================

describe('parseMarkdownStyles', () => {
  test('plain text passes through untouched', () => {
    expect(parseMarkdownStyles('hello world')).toEqual({
      text: 'hello world',
      styles: [],
    })
  })

  test('bold with **', () => {
    expect(parseMarkdownStyles('say **hi** loud')).toEqual({
      text: 'say hi loud',
      styles: [{ start: 4, length: 2, style: 'BOLD' }],
    })
  })

  test('italic with single *', () => {
    expect(parseMarkdownStyles('this is *important*')).toEqual({
      text: 'this is important',
      styles: [{ start: 8, length: 9, style: 'ITALIC' }],
    })
  })

  test('italic with underscores', () => {
    expect(parseMarkdownStyles('say _hi_')).toEqual({
      text: 'say hi',
      styles: [{ start: 4, length: 2, style: 'ITALIC' }],
    })
  })

  test('underscores in snake_case are literal', () => {
    expect(parseMarkdownStyles('use snake_case_names here')).toEqual({
      text: 'use snake_case_names here',
      styles: [],
    })
  })

  test('inline monospace', () => {
    expect(parseMarkdownStyles('run `bun test` now')).toEqual({
      text: 'run bun test now',
      styles: [{ start: 4, length: 8, style: 'MONOSPACE' }],
    })
  })

  test('fenced triple-backtick block', () => {
    expect(parseMarkdownStyles('before ```const x = 1``` after')).toEqual({
      text: 'before const x = 1 after',
      styles: [{ start: 7, length: 11, style: 'MONOSPACE' }],
    })
  })

  test('asterisks inside backticks are literal', () => {
    expect(parseMarkdownStyles('`**not bold**` yes')).toEqual({
      text: '**not bold** yes',
      styles: [{ start: 0, length: 12, style: 'MONOSPACE' }],
    })
  })

  test('strikethrough with ~~', () => {
    expect(parseMarkdownStyles('~~old~~ new')).toEqual({
      text: 'old new',
      styles: [{ start: 0, length: 3, style: 'STRIKETHROUGH' }],
    })
  })

  test('spoiler with ||', () => {
    expect(parseMarkdownStyles('answer: ||42||')).toEqual({
      text: 'answer: 42',
      styles: [{ start: 8, length: 2, style: 'SPOILER' }],
    })
  })

  test('overlapping bold and italic', () => {
    const res = parseMarkdownStyles('**bold *both* bold**')
    expect(res.text).toBe('bold both bold')
    expect(res.styles).toContainEqual({ start: 0, length: 14, style: 'BOLD' })
    expect(res.styles).toContainEqual({ start: 5, length: 4, style: 'ITALIC' })
  })

  test('multiple independent bold runs', () => {
    const res = parseMarkdownStyles('**a** and **b**')
    expect(res.text).toBe('a and b')
    expect(res.styles).toEqual([
      { start: 0, length: 1, style: 'BOLD' },
      { start: 6, length: 1, style: 'BOLD' },
    ])
  })

  test('unpaired ** becomes literal', () => {
    expect(parseMarkdownStyles('only **one star here')).toEqual({
      text: 'only **one star here',
      styles: [],
    })
  })

  test('unpaired single * becomes literal but prior pair still parses', () => {
    const res = parseMarkdownStyles('*a* leftover *')
    expect(res.text).toBe('a leftover *')
    expect(res.styles).toEqual([{ start: 0, length: 1, style: 'ITALIC' }])
  })

  test('unclosed backtick is literal', () => {
    expect(parseMarkdownStyles('the ` char alone')).toEqual({
      text: 'the ` char alone',
      styles: [],
    })
  })

  test('empty delim pair emits no style', () => {
    expect(parseMarkdownStyles('hi ****')).toEqual({
      text: 'hi ',
      styles: [],
    })
  })

  test('mixed styles in one message', () => {
    const res = parseMarkdownStyles(
      'look: **bold**, *italic*, ~~strike~~, `code`, ||spoil||',
    )
    expect(res.text).toBe('look: bold, italic, strike, code, spoil')
    expect(res.styles).toEqual([
      { start: 6, length: 4, style: 'BOLD' },
      { start: 12, length: 6, style: 'ITALIC' },
      { start: 20, length: 6, style: 'STRIKETHROUGH' },
      { start: 28, length: 4, style: 'MONOSPACE' },
      { start: 34, length: 5, style: 'SPOILER' },
    ])
  })

  test('unicode BMP characters are counted correctly', () => {
    expect(parseMarkdownStyles('**ä é**')).toEqual({
      text: 'ä é',
      styles: [{ start: 0, length: 3, style: 'BOLD' }],
    })
  })

  test('textStylesToRpcStrings formats as START:LENGTH:STYLE', () => {
    expect(
      textStylesToRpcStrings([
        { start: 0, length: 4, style: 'BOLD' },
        { start: 6, length: 6, style: 'ITALIC' },
      ]),
    ).toEqual(['0:4:BOLD', '6:6:ITALIC'])
  })
})

// =============================================================================
// makeOutboundSender — verifies the signal-cli param shape
// =============================================================================

describe('makeOutboundSender', () => {
  test('sendMessage maps args to signal-cli JSON-RPC params', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = []
    const fakeRpc = {
      call: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params })
        return { timestamp: 42 }
      },
    } as unknown as SignalRpcClient
    const sender = makeOutboundSender(fakeRpc, makeConfig())
    await sender.sendMessage({
      recipient: '+491234567890',
      message: 'hi',
      attachments: ['/tmp/a.jpg'],
      voiceNote: true,
      quoteTimestamp: 99,
      quoteAuthor: 'XXX',
    })
    expect(seen[0]!.method).toBe('send')
    expect(seen[0]!.params).toEqual({
      account: '+493045310892',
      recipient: ['+491234567890'],
      message: 'hi',
      attachment: ['/tmp/a.jpg'],
      voiceNote: true,
      quoteTimestamp: 99,
      quoteAuthor: 'XXX',
    })
  })

  test('sendMessage strips markdown and attaches textStyles', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = []
    const fakeRpc = {
      call: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params })
        return { timestamp: 1 }
      },
    } as unknown as SignalRpcClient
    const sender = makeOutboundSender(fakeRpc, makeConfig())
    await sender.sendMessage({
      recipient: '+491234567890',
      message: 'please **try** `bun test` now',
    })
    expect(seen[0]!.params.message).toBe('please try bun test now')
    expect(seen[0]!.params.textStyles).toEqual([
      '7:3:BOLD',
      '11:8:MONOSPACE',
    ])
  })

  test('sendMessage omits textStyles when message is plain', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = []
    const fakeRpc = {
      call: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params })
        return { timestamp: 1 }
      },
    } as unknown as SignalRpcClient
    const sender = makeOutboundSender(fakeRpc, makeConfig())
    await sender.sendMessage({ recipient: '+491234567890', message: 'hello' })
    expect(seen[0]!.params.message).toBe('hello')
    expect(seen[0]!.params.textStyles).toBeUndefined()
  })

  test('sendMessage passes markdown through untouched when parseMarkdown=false', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = []
    const fakeRpc = {
      call: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params })
        return { timestamp: 1 }
      },
    } as unknown as SignalRpcClient
    const sender = makeOutboundSender(
      fakeRpc,
      makeConfig({ parseMarkdown: false }),
    )
    await sender.sendMessage({
      recipient: '+491234567890',
      message: 'raw **bold**',
    })
    expect(seen[0]!.params.message).toBe('raw **bold**')
    expect(seen[0]!.params.textStyles).toBeUndefined()
  })

  test('sendTyping passes stop=!typing', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = []
    const fakeRpc = {
      call: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params })
        return null
      },
    } as unknown as SignalRpcClient
    const sender = makeOutboundSender(fakeRpc, makeConfig())
    await sender.sendTyping('+499', true)
    await sender.sendTyping('+499', false)
    expect(seen[0]!.params.stop).toBe(false)
    expect(seen[1]!.params.stop).toBe(true)
  })

  test('sendReceipt includes type=read + targetTimestamp array', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = []
    const fakeRpc = {
      call: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params })
        return null
      },
    } as unknown as SignalRpcClient
    const sender = makeOutboundSender(fakeRpc, makeConfig())
    await sender.sendReceipt('+499', [123, 456])
    expect(seen[0]!.method).toBe('sendReceipt')
    expect(seen[0]!.params.type).toBe('read')
    expect(seen[0]!.params.targetTimestamp).toEqual([123, 456])
  })

  test('sendReaction includes targetAuthor and remove flag', async () => {
    const seen: Array<{ method: string; params: Record<string, unknown> }> = []
    const fakeRpc = {
      call: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params })
        return { timestamp: 7 }
      },
    } as unknown as SignalRpcClient
    const sender = makeOutboundSender(fakeRpc, makeConfig())
    await sender.sendReaction({
      recipient: '+499',
      emoji: '👍',
      targetAuthor: 'uuid-xxx',
      targetTimestamp: 123,
      remove: false,
    })
    expect(seen[0]!.method).toBe('sendReaction')
    expect(seen[0]!.params.emoji).toBe('👍')
    expect(seen[0]!.params.targetAuthor).toBe('uuid-xxx')
    expect(seen[0]!.params.remove).toBe(false)
  })
})

// =============================================================================
// loadConfig (smoke test)
// =============================================================================

describe('loadConfig', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('SIGNAL_')) delete process.env[k]
    }
    Object.assign(process.env, saved)
  })
  test('throws when required vars missing', () => {
    delete process.env.SIGNAL_ACCOUNT
    delete process.env.SIGNAL_ALLOWED_SENDERS
    expect(() => loadConfig()).toThrow(/missing required env vars/)
  })
  test('parses a minimal config', () => {
    process.env.SIGNAL_ACCOUNT = '+493045310892'
    process.env.SIGNAL_ALLOWED_SENDERS = '+491234567890'
    const cfg = loadConfig()
    expect(cfg.account).toBe('+493045310892')
    expect(cfg.allowedSenders.has('+491234567890')).toBe(true)
    expect(cfg.sendReadReceipts).toBe(true)
  })
  test('rejects non-E.164 account', () => {
    process.env.SIGNAL_ACCOUNT = 'not-a-phone'
    process.env.SIGNAL_ALLOWED_SENDERS = '+491234567890'
    expect(() => loadConfig()).toThrow(/E\.164/)
  })
})


// =============================================================================
// The envelope contract
// =============================================================================
//
// signal-cli publishes the JSON schemas for its envelope format as a release
// asset (since 0.14.6); `schemas/` holds the set for the version named in
// `schemas/VERSION`. This walks every field the adapter reads against them.
//
// The failure it exists for is silent. When the envelope format moved once
// before, inbound DMs stopped arriving: no error, no log line, outbound
// unaffected — the adapter simply found nothing where it looked. A test that
// compares its assumptions against the published format turns that into a red
// test at update time.

describe('the envelope contract', () => {
  const dir = join(import.meta.dir, 'schemas')

  const schemas: Record<string, Record<string, unknown>> = {}
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.schema.json')) continue
    schemas[file] = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  }

  /** A schema node, with a `$ref` to another file followed once. */
  function resolve(node: unknown): Record<string, unknown> | null {
    if (!node || typeof node !== 'object') return null
    const ref = (node as { $ref?: string }).$ref
    if (typeof ref === 'string') {
      const target = schemas[ref.replace(/^\.\//, '')]
      return target ?? null
    }
    return node as Record<string, unknown>
  }

  function properties(schema: Record<string, unknown> | null): Record<string, unknown> {
    return (schema?.properties as Record<string, unknown>) ?? {}
  }

  /** Every field the tree declares, as `dotted.path` → what is claimed of it. */
  function walk(
    tree: Record<string, unknown>,
    schema: Record<string, unknown> | null,
    prefix = '',
  ): { path: string; check: FieldCheck | 'nested'; known: boolean }[] {
    const props = properties(schema)
    const out: { path: string; check: FieldCheck | 'nested'; known: boolean }[] = []
    for (const [name, value] of Object.entries(tree)) {
      const path = prefix ? `${prefix}.${name}` : name
      const known = Object.hasOwn(props, name)
      if (typeof value === 'string') {
        out.push({ path, check: value as FieldCheck, known })
        continue
      }
      out.push({ path, check: 'nested', known })
      out.push(
        ...walk(value as Record<string, unknown>, resolve(props[name]), path),
      )
    }
    return out
  }

  const fields = walk(
    ENVELOPE_FIELDS as unknown as Record<string, unknown>,
    schemas['message-envelope.schema.json'] ?? null,
  )

  test('the vendored schemas are present and name their version', () => {
    expect(Object.keys(schemas).length).toBeGreaterThan(20)
    expect(schemas['message-envelope.schema.json']).toBeDefined()
    expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('every field the adapter reads is in the published format', () => {
    const missing = fields
      .filter(f => f.check !== 'legacy' && !f.known)
      .map(f => f.path)
    // A name here means signal-cli no longer sends the field, or renamed it.
    // Read the release notes for the version in schemas/VERSION before
    // changing the adapter — a wrong guess is another silent inbound outage.
    expect(missing).toEqual([])
  })

  test('a field marked legacy really is absent, so the marker stays honest', () => {
    const stale = fields.filter(f => f.check === 'legacy' && f.known).map(f => f.path)
    // A legacy alias that has reappeared in the schema is documented wrongly:
    // it is current, and should be marked 'schema'.
    expect(stale).toEqual([])
  })

  test('the fields carrying the sender and the text are checked, not assumed', () => {
    // Guards the guard: an empty or accidentally-emptied tree would make the
    // test above pass while checking nothing.
    const paths = fields.map(f => f.path)
    expect(paths).toContain('sourceUuid')
    expect(paths).toContain('dataMessage.message')
    expect(paths).toContain('dataMessage.attachments')
    expect(paths).toContain('dataMessage.reaction')
  })
})
