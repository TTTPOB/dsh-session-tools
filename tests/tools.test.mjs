import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../dist/index.js'

const config = { pageSize: 30, maxPageSize: 100, previewChars: 240, outputBytes: 24576 }
function setup(query, options = {}) {
  const definitions = new Map()
  let cleanup
  const ctx = { sessionQuery: query, tools: { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } }, effect(fn) { cleanup = fn() } }
  apply(ctx, { ...config, ...options })
  const controller = new AbortController()
  const exec = { signal: controller.signal, agent: { session: { id: 'self', header: { cwd: '/one' } } } }
  return { definitions, exec, dispose: () => cleanup() }
}
const header = (id, cwd = '/one') => ({ id, cwd, createdAt: 1 })
const rows = [header('a'), header('b', '/two'), header('self')].map(header => ({ header, live: false, persisted: true }))
function provider(extra = {}) { return { listSessions: async () => rows, filterSessions: async filters => rows.filter(x => x.header.id === filters[0].values[0]), listEvents: async () => [], filterEvents: async () => [], readEvent: async () => ({ session: header('a'), target: { seq: 0, type: 'user/message', text: '你好' } }), traceSession: async () => ({ target: rows[0], ancestors: [rows[1]], descendants: [{ session: rows[1], descendants: [{ session: rows[0], descendants: [] }] }], complete: true, root: rows[1] }), traceEvent: async () => ({ session: header('a'), target: { sessionId: 'a', seq: 0, type: 'user/message', time: 0, surface: 'current' }, replacementChain: [2], replacedEventSeqs: [], sourceEventSeqs: [1], derivedEventSeqs: [3] }), ...extra } }
const run = (fixture, tool, args) => fixture.definitions.get(tool).execute(args, fixture.exec)
test('all seven native-object tools register and dispose', () => {
  const fixture = setup(provider()); assert.equal(fixture.definitions.size, 7)
  fixture.dispose(); assert.equal(fixture.definitions.size, 0)
})
test('project exact cwd and explicit all; missing cwd rejects project', async () => {
  const f = setup(provider()); assert.deepEqual((await run(f, 'session_list', {})).items.map(x => x.sessionId), ['a', 'self'])
  assert.equal((await run(f, 'session_list', { scope: 'all' })).items.length, 3)
  f.exec.agent.session.header.cwd = undefined
  await assert.rejects(run(f, 'session_list', {}), /header.cwd/)
  assert.equal((await run(f, 'session_list', { scope: 'all' })).items.length, 3)
})
test('search uses index and preserves cursor when output budget stops page', async () => {
  const calls = []
  const f = setup(provider({ searchSessions: async request => { calls.push(request); const n = Number(request.cursor ?? 0); return { items: [{ ...rows[0], header: header('a' + n), bestMatch: { seq: n, type: 'user/message', snippet: 'hello'.repeat(140) } }], nextCursor: String(n + 1) } } }), { outputBytes: 1024 })
  const page = await run(f, 'session_search', { query: 'hello', limit: 3 })
  assert.equal(page.items.length, 2); assert.equal(page.nextCursor, '2'); assert.equal(calls[0].sessionFilters[0].values[0], '/one')
  assert.equal(calls[0].limit, 1)
})
test('disabled search does not call listing or fall back, retains code', async () => {
  let listed = false
  const error = Object.assign(new Error('disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
  const f = setup(provider({ listSessions: async () => { listed = true; return rows }, searchSessions: async () => { throw error } }))
  await assert.rejects(run(f, 'session_search', { query: 'hello' }), e => e.code === error.code && /no logs were scanned/i.test(e.message))
  assert.equal(listed, false)
})
test('event list includes structural events, EOF and explicit type filters', async () => {
  const f = setup(provider({ listEvents: async () => [0, 1, 2].map(seq => ({ sessionId: 'a', seq, type: seq === 1 ? 'user/message' : 'turn/start', time: 0, surface: 'log-only' })) }))
  assert.deepEqual((await run(f, 'session_event_list', { session_id: 'a', view: 'metadata' })).items.map(x => x.seq), [0, 1, 2])
  assert.deepEqual((await run(f, 'session_event_list', { session_id: 'a', event_types: ['user/message'] })).items.map(x => x.seq), [1])
  assert.deepEqual((await run(f, 'session_event_list', { session_id: 'a', after_seq: 2 })).items, [])
})
test('event raw JSON base64 fragments reassemble UTF-8 without fabricated full text', async () => {
  const text = '中文'.repeat(4000)
  const f = setup(provider({ readEvent: async () => ({ session: header('a'), target: { seq: 0, type: 'user/message', text } }) }), { outputBytes: 1024 })
  let offset = 0; const chunks = []
  do { const part = await run(f, 'session_event_read', { session_id: 'a', seq: 0, offset_bytes: offset }); assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 1024); chunks.push(Buffer.from(part.dataBase64, 'base64')); offset = part.nextOffsetBytes } while (offset !== null)
  assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8')).text, text)
})
test('trace omits cross-project identities and event relationships remain complete', async () => {
  const f = setup(provider()); const trace = await run(f, 'session_trace', { session_id: 'a' })
  assert.equal(JSON.stringify(trace).includes('/two'), false); assert.equal(JSON.stringify(trace).includes('"b"'), false)
  assert.deepEqual((await run(f, 'session_event_trace', { session_id: 'a', seq: 0 })).derivedEventSeqs, [3])
})
test('event search index unavailable never falls back to semantic scan', async () => {
  let scanned = false
  const error = Object.assign(new Error('index failed'), { code: 'SESSION_QUERY_INDEX_FAILED' })
  const f = setup(provider({ filterEvents: async () => { scanned = true; return [] }, searchEvents: async () => { throw error } }))
  await assert.rejects(run(f, 'session_event_search', { session_id: 'a', query: 'hello' }), e => e.code === 'SESSION_QUERY_INDEX_FAILED' && /no logs were scanned/i.test(e.message))
  assert.equal(scanned, false)
})
test('cross-project event target is rejected unless all selected', async () => {
  const f = setup(provider({ readEvent: async () => ({ session: header('b', '/two'), target: { seq: 0 } }) }))
  await assert.rejects(run(f, 'session_event_read', { session_id: 'b', seq: 0 }), /outside the caller project/)
  assert.ok((await run(f, 'session_event_read', { session_id: 'b', seq: 0, scope: 'all' })).dataBase64)
})
