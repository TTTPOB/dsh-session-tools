import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startSessionStream } from '../dist/stream.js'

function record(id, cwd = '/one', parentSession) {
  return { header: { id, cwd, parentSession, createdAt: 1 }, live: true, persisted: false }
}
function event(seq, type, data = {}) { return { seq, type, data, time: seq * 10 } }

async function serve(t, query) {
  const dir = await mkdtemp(join(tmpdir(), 'session-stream-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const socketPath = join(dir, 's.sock')
  const stream = startSessionStream(socketPath, query, true)
  t.after(stream.dispose)
  await stream.ready
  return socketPath
}

async function request(socketPath, path, method = 'GET') {
  const [response] = await once(get({ socketPath, path, method, agent: false }), 'response')
  let body = ''
  let completed = true
  try { for await (const chunk of response.setEncoding('utf8')) body += chunk }
  catch (error) {
    assert.equal(error.code, 'ECONNRESET')
    completed = false
  }
  assert.match(response.headers['content-type'], /^application\/x-ndjson/)
  if (body) assert.ok(body.endsWith('\n'))
  return { status: response.statusCode, completed, items: body.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}

function observation(events, dispose = () => {}) {
  return { cursor: events.at(-1)?.seq ?? -1, readEvents: (from, to) => events.slice(from, to), [Symbol.dispose]: dispose }
}

function queryForHistory(history) {
  return {
    async filterSessions([{ values }]) { return values.filter(id => id in history).map(id => record(id)) },
    async observeSession(id) { return observation(history[id]) },
  }
}

test('events preserve raw payloads and order for multiple sessions, excluding defaults only when types is omitted', async t => {
  const history = {
    'live-α': [event(0, 'system/message'), event(1, 'request/header'), event(2, 'user/message', { text: 'line 1\n行２🦀' })],
    'other': [event(0, 'user/message', { text: 'other workspace' })],
  }
  const socket = await serve(t, queryForHistory(history))
  const prefix = '/events?session=live-%CE%B1&session=other'
  const result = await request(socket, prefix)
  assert.deepEqual(result, { status: 200, completed: true, items: [
    { ...history['live-α'][2], session_id: 'live-α' }, { ...history.other[0], session_id: 'other' },
  ] })
  const explicit = await request(socket, prefix + '&types=system%2Fmessage,request%2Fheader')
  assert.deepEqual(explicit.items, history['live-α'].slice(0, 2).map(item => ({ ...item, session_id: 'live-α' })))
})

test('events apply exclusive after_seq and inclusive until_seq without dropping seq zero', async t => {
  const history = { one: Array.from({ length: 4 }, (_, seq) => event(seq, 'user/message')) }
  const socket = await serve(t, queryForHistory(history))
  const getSeqs = async (range) => (await request(socket, '/events?session=one&' + range)).items.map(x => x.seq)
  assert.deepEqual(await getSeqs('after_seq=0&until_seq=2'), [1, 2])
  assert.deepEqual(await getSeqs('until_seq=0'), [0])
  assert.deepEqual(await getSeqs('after_seq=2&until_seq=2'), [])
})

test('validates parameters and every explicit ID before emitting; exactly fifty sessions are accepted', async t => {
  const ids = Array.from({ length: 50 }, (_, i) => `id${i}`)
  let observed = 0
  const query = queryForHistory(Object.fromEntries(ids.map(id => [id, []])))
  const rawObserve = query.observeSession
  query.observeSession = (...args) => { observed++; return rawObserve(...args) }
  const socket = await serve(t, query)
  const path = '/events?' + ids.map(id => `session=${id}`).join('&')
  assert.deepEqual(await request(socket, path), { status: 200, completed: true, items: [] })
  assert.equal(observed, ids.length)
  observed = 0
  for (const invalid of [path + '&session=extra', '/events', '/events?session=id0&foo=ignored', '/events?session=id0&after_seq=1.5', '/events?session=id0&types=']) {
    const { status, items, completed } = await request(socket, invalid)
    assert.equal(status, 400, invalid)
    assert.equal(completed, true)
    assert.equal(items.length, 1)
    assert.deepEqual(Object.keys(items[0]), ['error'])
    assert.equal(items[0].error.code, 'SESSION_STREAM_INVALID_PARAMETER')
    assert.ok(items[0].error.message)
  }
  assert.deepEqual(await request(socket, '/events?session=id0&session=missing&session=also-missing'), {
    status: 404, completed: true, items: [{ error: { code: 'SESSION_QUERY_SESSION_NOT_FOUND', message: 'Sessions not found: missing, also-missing' } }],
  })
  assert.equal(observed, 0)
  assert.equal((await request(socket, '/events?session=id0', 'POST')).status, 405)
})

test('backpressure stops reading more batches; disconnect releases the observation and skips later sessions', { timeout: 5000 }, async t => {
  const payload = 'x'.repeat(512 * 1024)
  let reads = 0
  let opened = 0
  const { promise: released, resolve: release } = Promise.withResolvers()
  const socket = await serve(t, {
    async filterSessions() { return [record('one'), record('two')] },
    async observeSession(_, { signal }) {
      opened++
      return {
        cursor: 10000,
        readEvents(from) { reads++; return [event(from, 'user/message', { payload })] },
        [Symbol.dispose]() { release(signal.aborted) },
      }
    },
  })
  const [response] = await once(get({ socketPath: socket, path: '/events?session=one&session=two', agent: false }), 'response')
  response.pause()
  await delay(60)
  assert.equal(reads, 1, 'paused client must retain the current batch')
  response.destroy()
  assert.equal(await released, true)
  assert.equal(reads, 1)
  assert.equal(opened, 1)
})

test('before-first and mid-stream provider failures have distinct HTTP framing', async t => {
  const socket = await serve(t, {
    async filterSessions() { return [record('one'), record('broken')] },
    async observeSession(id) {
      if (id === 'broken') throw Object.assign(new Error('damaged log'), { code: 'SESSION_QUERY_CORRUPT_SESSION' })
      return observation([event(0, 'user/message')])
    },
  })
  const failure = { error: { code: 'SESSION_QUERY_CORRUPT_SESSION', message: 'damaged log' } }
  assert.deepEqual(await request(socket, '/events?session=broken'), { status: 500, completed: true, items: [failure] })
  const late = await request(socket, '/events?session=one&session=broken')
  assert.deepEqual(late, { status: 200, completed: false, items: [{ ...event(0, 'user/message'), session_id: 'one' }, failure] })
})

test('session list pages internally, pushes cwd into the provider and joins each latest title', async t => {
  const first = record('first', '/two', 'parent')
  const second = record('second', '/two')
  const socket = await serve(t, {
    async pageSessions({ cursor, filters, limit }) {
      assert.deepEqual(filters, [{ kind: 'cwd', values: ['/two'] }])
      if (cursor === undefined) { assert.equal(limit, 2); return { items: [first], nextCursor: 'keep-going' } }
      assert.equal(cursor, 'keep-going')
      assert.equal(limit, 1)
      return { items: [second], nextCursor: 'do-not-fetch' }
    },
    async readTitleSnapshots(ids) {
      return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: sessionId === 'first' ? { title: { title: 'Latest title' } } : {} }))
    },
    async traceSession(id) { assert.equal(id, 'first'); return { target: first, ancestors: [record('parent')], descendants: [], complete: true } },
  })
  const listed = await request(socket, '/sessions?cwd=%2Ftwo&limit=2')
  assert.deepEqual(listed.items, [{ ...first, title: 'Latest title' }, { ...second, title: null }].map(x => JSON.parse(JSON.stringify(x))))
  const trace = await request(socket, '/trace?session=first')
  assert.equal(trace.items[0].target.header.parentSession, trace.items[0].ancestors[0].header.id)
})

test('search waits on index warmup then streams ranked pages with exact provider filters', async t => {
  let calls = 0
  const ready = { header: { id: 'one' }, bestMatch: { seq: 9, snippet: 'the first ranked event' } }
  const next = { header: { id: 'two' }, bestMatch: { seq: 0, snippet: 'the second ranked event' } }
  const socket = await serve(t, {
    async filterSessions([{ values }]) { return values.filter(id => id === 'one' || id === 'two').map(id => record(id)) },
    async searchSessions({ query, sessionFilters, cursor }) {
      calls++
      assert.equal(query, '"connection refused" -obsolete')
      assert.deepEqual(sessionFilters, [{ kind: 'cwd', values: ['/one'] }, { kind: 'id', values: ['two', 'one'] }])
      if (calls === 1) throw Object.assign(new Error('warming'), { code: 'SESSION_QUERY_INDEX_WARMING' })
      if (cursor === undefined) return { items: [ready], nextCursor: 'p2' }
      assert.equal(cursor, 'p2')
      return { items: [next], nextCursor: 'must-not-fetch' }
    },
    async searchEvents({ sessionFilters }) {
      assert.deepEqual(sessionFilters, [])
      return { items: [{ sessionId: 'two', session: record('two').header, seq: 4 }] }
    },
  })
  const path = '/search?group=session&q=%22connection+refused%22+-obsolete&session=two&session=one&cwd=%2Fone&limit=2'
  assert.deepEqual(await request(socket, path), { status: 200, completed: true, items: [ready, next] })
  assert.equal(calls, 3)
  assert.equal((await request(socket, path + '&session=unknown')).status, 404)
  assert.equal(calls, 3, 'unknown session IDs must not run an indexed search')
  assert.equal((await request(socket, '/search?q=words&group=event')).items[0].sessionId, 'two')
  for (const invalid of ['/search?q=words&group=other', '/search?q=%20&group=event', '/search?q=words&group=event&limit=0']) {
    assert.equal((await request(socket, invalid)).status, 400)
  }
})

test('only index warming retries; warmup deadline returns a single 503 error line', async t => {
  const timeout = AbortSignal.timeout
  t.mock.method(AbortSignal, 'timeout', () => timeout(50))
  let calls = 0
  const socket = await serve(t, {
    async searchEvents({ query }) {
      calls++
      throw Object.assign(new Error(query), { code: query === 'warming' ? 'SESSION_QUERY_INDEX_WARMING' : 'SESSION_QUERY_INDEX_FAILED' })
    },
  })
  const warm = await request(socket, '/search?group=event&q=warming')
  assert.equal(warm.status, 503)
  assert.equal(warm.completed, true)
  assert.equal(warm.items.length, 1)
  assert.equal(warm.items[0].error.code, 'SESSION_QUERY_INDEX_WARMING')
  const before = calls
  const failed = await request(socket, '/search?group=event&q=failed')
  assert.deepEqual(failed, { status: 500, completed: true, items: [{ error: { code: 'SESSION_QUERY_INDEX_FAILED', message: 'failed' } }] })
  assert.equal(calls, before + 1)
})
