import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BadRequest } from './supervisor.js'
import { envParam, transcriptParam } from './params.js'

const VALID_UUID = '53907a7f-c39f-4226-92ba-8e55aac853cc'

test('envParam: undefined/null -> {}', () => {
  assert.deepEqual(envParam(undefined), {})
  assert.deepEqual(envParam(null), {})
})

test('envParam: coerces values to strings', () => {
  assert.deepEqual(envParam({ CHANNEL_TOKEN: 't1', CHANNEL_N: 42 }), { CHANNEL_TOKEN: 't1', CHANNEL_N: '42' })
})

test('envParam: rejects non-objects', () => {
  assert.throws(() => envParam('nope'), BadRequest)
  assert.throws(() => envParam(['array']), BadRequest)
})

test('transcriptParam: undefined/null -> undefined (no transcript on this spawn)', () => {
  assert.equal(transcriptParam(undefined), undefined)
  assert.equal(transcriptParam(null), undefined)
})

test('transcriptParam: valid uuid + content passes through', () => {
  const result = transcriptParam({ sessionUuid: VALID_UUID, content: '{"a":1}\n' })
  assert.deepEqual(result, { sessionUuid: VALID_UUID, content: '{"a":1}\n' })
})

test('transcriptParam: invalid uuid -> 400', () => {
  assert.throws(() => transcriptParam({ sessionUuid: 'too-short', content: 'x' }), BadRequest)
})

test('transcriptParam: non-string content -> 400', () => {
  assert.throws(() => transcriptParam({ sessionUuid: VALID_UUID, content: 123 }), BadRequest)
})

test('transcriptParam: content over 20MB -> 400', () => {
  const tooBig = 'x'.repeat(20 * 1024 * 1024 + 1)
  assert.throws(() => transcriptParam({ sessionUuid: VALID_UUID, content: tooBig }), BadRequest)
})
