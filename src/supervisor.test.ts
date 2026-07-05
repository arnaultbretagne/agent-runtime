import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from './supervisor.js'

const CWD = '/home/node/work'
const SLUG = '-home-node-work' // cwd.replace(/[/.]/g, '-') — confirmed empirically, verrou V1
const UUID = '53907a7f-c39f-4226-92ba-8e55aac853cc'

/** Builds a Supervisor whose transcripts land under a fresh temp HOME. Restores process.env.HOME
 *  after the test (the supervisor reads it once, in a class field initializer, at construction). */
function withSupervisor(fn: (sup: Supervisor, home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'agent-runtime-test-'))
  const prevHome = process.env.HOME
  process.env.HOME = home
  try {
    fn(new Supervisor({ cwd: CWD }), home)
  } finally {
    process.env.HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
}

test('writeTranscriptIfAbsent writes to <HOME>/.claude/projects/<slug(cwd)>/<uuid>.jsonl', () => {
  withSupervisor((sup, home) => {
    sup.writeTranscriptIfAbsent(UUID, '{"line":1}\n')
    const file = join(home, '.claude', 'projects', SLUG, `${UUID}.jsonl`)
    assert.equal(readFileSync(file, 'utf8'), '{"line":1}\n')
  })
})

test('writeTranscriptIfAbsent never clobbers an existing file', () => {
  withSupervisor((sup, home) => {
    sup.writeTranscriptIfAbsent(UUID, 'original')
    sup.writeTranscriptIfAbsent(UUID, 'attempted overwrite')
    const file = join(home, '.claude', 'projects', SLUG, `${UUID}.jsonl`)
    assert.equal(readFileSync(file, 'utf8'), 'original')
  })
})

test('listTranscriptUuids lists uuids written across project slugs', () => {
  withSupervisor((sup) => {
    assert.deepEqual(sup.listTranscriptUuids(), [])
    sup.writeTranscriptIfAbsent(UUID, '{}')
    assert.deepEqual(sup.listTranscriptUuids(), [UUID])
  })
})

test('readTranscript returns the raw content, or undefined if absent', () => {
  withSupervisor((sup) => {
    assert.equal(sup.readTranscript(UUID), undefined)
    sup.writeTranscriptIfAbsent(UUID, '{"line":1}\n{"line":2}\n')
    assert.equal(sup.readTranscript(UUID), '{"line":1}\n{"line":2}\n')
  })
})
