#!/usr/bin/env bun
/**
 * The vendored signal-cli JSON schemas, against the signal-cli that is
 * installed.
 *
 * signal-cli publishes the schemas for its envelope format as a release asset
 * since 0.14.6. `schemas/` holds the set for the version in `schemas/VERSION`,
 * and `server.test.ts` walks every field the adapter reads against them. That
 * test is only as current as the vendored files, so something has to notice
 * when the installed signal-cli moves — juno updates it daily, unattended.
 *
 *   bun run schemas:check     compare, report, exit 1 on a changed format
 *   bun run schemas:refresh   replace the vendored set with the installed one
 *
 * Exit codes for `check`: 0 when the format is unchanged (including the case
 * where only the version number moved), 1 when a schema differs or the check
 * could not be carried out. A check that cannot run is not a passing check —
 * the outage this guards against was silent for exactly that reason.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ROOT = dirname(import.meta.dir)
const VENDORED = join(ROOT, 'schemas')

function installedVersion(): string {
  const bin =
    process.env.SIGNAL_CLI_BIN ||
    join(process.env.HOME ?? '', '.local', 'signal-cli', 'signal-cli')
  const run = Bun.spawnSync([bin, '--version'])
  if (run.exitCode !== 0) {
    throw new Error(`${bin} --version exited ${run.exitCode}`)
  }
  const out = new TextDecoder().decode(run.stdout).trim()
  const m = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(out)
  if (!m) throw new Error(`cannot read a version out of "${out}"`)
  return m[1]!
}

function vendoredVersion(): string {
  const file = join(VENDORED, 'VERSION')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
}

async function downloadSchemas(version: string): Promise<string> {
  const url =
    `https://github.com/AsamK/signal-cli/releases/download/v${version}` +
    `/signal-cli-${version}-json-schemas.tar.gz`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  const dir = mkdtempSync(join(tmpdir(), 'signal-schemas-'))
  const archive = join(dir, 'schemas.tar.gz')
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()))
  const untar = Bun.spawnSync(['tar', 'xzf', archive, '-C', dir])
  if (untar.exitCode !== 0) throw new Error(`tar exited ${untar.exitCode}`)
  rmSync(archive)
  return dir
}

function schemaFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.schema.json'))
    .sort()
}

/** The property names a schema declares, for a readable diff. */
function properties(path: string): string[] {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      properties?: Record<string, unknown>
    }
    return Object.keys(doc.properties ?? {}).sort()
  } catch {
    return []
  }
}

function describeChange(name: string, fresh: string, vendored: string): string[] {
  const before = properties(join(vendored, name))
  const after = properties(join(fresh, name))
  const added = after.filter((p) => !before.includes(p))
  const removed = before.filter((p) => !after.includes(p))
  const lines = [`  changed: ${name}`]
  if (added.length) lines.push(`    added:   ${added.join(', ')}`)
  if (removed.length) lines.push(`    removed: ${removed.join(', ')}`)
  if (!added.length && !removed.length) {
    lines.push('    same property names, different constraints')
  }
  return lines
}

function compare(fresh: string): string[] {
  const before = schemaFiles(VENDORED)
  const after = schemaFiles(fresh)
  const findings: string[] = []
  for (const name of after.filter((n) => !before.includes(n))) {
    findings.push(`  added:   ${name}`)
  }
  for (const name of before.filter((n) => !after.includes(n))) {
    findings.push(`  removed: ${name}`)
  }
  for (const name of before.filter((n) => after.includes(n))) {
    const a = readFileSync(join(VENDORED, name), 'utf8')
    const b = readFileSync(join(fresh, name), 'utf8')
    if (a !== b) findings.push(...describeChange(name, fresh, VENDORED))
  }
  return findings
}

function install(fresh: string, version: string): void {
  for (const name of schemaFiles(VENDORED)) rmSync(join(VENDORED, name))
  for (const name of schemaFiles(fresh)) {
    writeFileSync(join(VENDORED, name), readFileSync(join(fresh, name)))
  }
  writeFileSync(join(VENDORED, 'VERSION'), `${version}\n`)
}

const mode = process.argv[2] ?? 'check'
if (mode !== 'check' && mode !== 'refresh') {
  console.error('usage: schemas.ts [check|refresh]')
  process.exit(2)
}

let fresh: string | null = null
try {
  const installed = installedVersion()
  const vendored = vendoredVersion()
  if (mode === 'check' && installed === vendored) {
    process.exit(0) // silent: the vendored set is the installed one
  }
  fresh = await downloadSchemas(installed)
  const findings = compare(fresh)
  if (mode === 'refresh') {
    install(fresh, installed)
    console.log(
      findings.length
        ? `schemas refreshed ${vendored || 'none'} -> ${installed}:\n${findings.join('\n')}`
        : `schemas refreshed ${vendored || 'none'} -> ${installed}, no change in content`,
    )
    process.exit(0)
  }
  if (!findings.length) {
    // Worth a log line, not an alert: the adapter's assumptions still hold and
    // only the version number moved. `schemas:refresh` records it.
    console.log(
      `signal-cli ${installed} installed, schemas vendored from ${vendored || 'none'}; ` +
        'format identical — run `bun run schemas:refresh` to record the version',
    )
    process.exit(0)
  }
  console.error(
    `signal-cli ${installed} changed the envelope format against the vendored ` +
      `${vendored || 'none'}:\n${findings.join('\n')}\n` +
      'Check ENVELOPE_FIELDS in server.ts against the new schemas, then run ' +
      '`bun run schemas:refresh`. Inbound DMs stop silently when the adapter ' +
      'reads a field the format no longer has.',
  )
  process.exit(1)
} catch (err) {
  console.error(`signal-cli schema check could not run: ${(err as Error).message}`)
  process.exit(1)
} finally {
  if (fresh) rmSync(fresh, { recursive: true, force: true })
}
