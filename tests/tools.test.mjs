import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../dist/index.js'

const config = { pageSize: 30, maxPageSize: 100, previewChars: 240, outputBytes: 24576, searchTimeoutMs: 30000 }
function setup(query, options = {}) {
  const definitions = new Map()
  let cleanup
  const ctx = { sessionQuery: query, sessionProjections: { stateOf: () => ({ lastStepStartSeq: 3 }) }, tools: { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } }, effect(fn) { cleanup = fn() } }
  apply(ctx, { ...config, ...options })
  const controller = new AbortController()
  const exec = { signal: controller.signal, agent: { session: { id: 'self', header: { cwd: '/one' } } } }
  return { ctx, definitions, exec, dispose: () => cleanup() }
}
const header = (id, cwd = '/one') => ({ id, cwd, createdAt: 1 })
const rows = [header('a'), header('b', '/two'), header('self')].map(header => ({ header, live: false, persisted: true }))
function provider(extra = {}) { return { readTitleSnapshots: async ids => ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { session: rows.find(item => item.header.id === sessionId)?.header ?? header(sessionId), title: { title: 'Test title' } } })), listSessions: async () => rows, filterSessions: async filters => rows.filter(x => x.header.id === filters[0].values[0]), listEvents: async () => [], filterEvents: async () => [], readEvent: async () => ({ session: header('a'), target: { seq: 0, type: 'user/message', text: '你好' } }), traceSession: async () => ({ target: rows[0], ancestors: [rows[1]], descendants: [{ session: rows[1], descendants: [{ session: rows[0], descendants: [] }] }], complete: true, root: rows[1] }), traceEvent: async () => ({ session: header('a'), target: { sessionId: 'a', seq: 0, type: 'user/message', time: 0, surface: 'current' }, replacementChain: [2], replacedEventSeqs: [], sourceEventSeqs: [1], derivedEventSeqs: [3] }), ...extra } }
const run = (fixture, tool, args) => fixture.definitions.get(tool).execute(args, fixture.exec)
test('all seven native-object tools register and dispose', () => {
  const fixture = setup(provider()); assert.equal(fixture.definitions.size, 7)
  fixture.dispose(); assert.equal(fixture.definitions.size, 0)
})
test('project exact cwd and explicit all; missing cwd rejects project', async () => {
  const f = setup(provider()); assert.deepEqual((await run(f, 'session_list', {})).items.map(x => x.session_id), ['a', 'self'])
  assert.equal((await run(f, 'session_list', { scope: 'all' })).items.length, 3)
  f.exec.agent.session.header.cwd = undefined
  await assert.rejects(run(f, 'session_list', {}), /header.cwd/)
  assert.equal((await run(f, 'session_list', { scope: 'all' })).items.length, 3)
})
test('session search returns the full provider page and one call with requested limit', async () => {
  const calls = []
  const f = setup(provider({ searchSessions: async request => { calls.push(request); return { items: [rows[0], rows[2]].map((row, seq) => ({ ...row, bestMatch: { seq, type: 'user/message', snippet: 'hello' } })), nextCursor: 'opaque' } } }))
  const page = await run(f, 'session_search', { query: 'hello', limit: 2 })
  assert.equal(calls.length, 1); assert.equal(calls[0].limit, 2)
  assert.deepEqual(calls[0].sessionFilters, [{ kind: 'cwd', values: ['/one'] }])
  assert.deepEqual(page.items.map(x => x.session_id), ['a'])
  assert.equal(page.has_more, true); assert.equal(page.next_cursor, 'opaque')
})
test('self-only provider page may be empty with continuation and no refill', async () => {
  let count = 0
  const f = setup(provider({ searchSessions: async () => { count++; return { items: [{ ...rows[2], bestMatch: { seq: 1, type: 'user/message', snippet: 'hello' } }], nextCursor: 'next' } } }))
  assert.deepEqual(await run(f, 'session_search', { query: 'hello', limit: 1 }), { items: [], has_more: true, next_cursor: 'next' })
  assert.equal(count, 1)
})
test('both indexed tools reject oversized full pages without partial results or retries', async () => {
  let sessions = 0; let events = 0
  const f = setup(provider({
    searchSessions: async () => { sessions++; return { items: [0, 1].map(seq => ({ ...rows[0], bestMatch: { seq, type: 'user/message', snippet: 'x'.repeat(700) } })), nextCursor: 'next' } },
    searchEvents: async () => { events++; return { session: header('a'), items: [0, 1].map(seq => ({ seq, type: 'user/message', snippet: 'x'.repeat(700) })), nextCursor: 'next' } },
  }), { outputBytes: 1024, previewChars: 700 })
  for (const [name, args] of [['session_search', { query: 'x', limit: 2 }], ['session_event_search', { session_id: 'a', query: 'x', limit: 2 }]]) {
    await assert.rejects(run(f, name, args), /lower limit and start a new search without a cursor.*no partial result/)
  }
  assert.equal(sessions, 1); assert.equal(events, 1)
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
test('event JSON readable fragments reassemble without splitting Unicode', async () => {
  const text = '中文😀'.repeat(4000)
  const f = setup(provider({ readEvent: async () => ({ session: header('a'), target: { seq: 0, type: 'user/message', text } }) }), { outputBytes: 1024 })
  let offset = 0; const fragments = []
  do { const part = await run(f, 'session_event_read', { session_id: 'a', seq: 0, offset_chars: offset }); assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 1024); assert.equal(part.format, 'json-unicode-code-points'); fragments.push(part.json_fragment); offset = part.next_offset } while (offset !== null)
  assert.equal(JSON.parse(fragments.join('')).text, text)
  const small = await run(setup(provider()), 'session_event_read', { session_id: 'a', seq: 0 })
  assert.equal(small.format, 'event-json'); assert.equal(small.event.text, '你好')
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
  assert.ok((await run(f, 'session_event_read', { session_id: 'b', seq: 0, scope: 'all' })).event)
})
test('titles batch once and compact records omit per-item metadata in project scope', async () => {
  const ids = []
  const f = setup(provider({ readTitleSnapshots: async batch => { ids.push(batch); return batch.map(sessionId => ({ sessionId, status: 'fulfilled', value: { session: header(sessionId), title: { title: '项目标题' } } })) } }))
  const result = await run(f, 'session_list', {})
  assert.equal(ids.length, 1); assert.equal(ids[0].length, 2)
  assert.deepEqual(Object.keys(result.items[0]), ['session_id', 'title'])
  assert.equal(result.items[0].title, '项目标题')
})
test('filtered event previews use selected seq range and count Chinese code points', async () => {
  const ranges = []
  const f = setup(provider({
    listEvents: async () => [0, 1, 2, 3, 4].map(seq => ({ sessionId: 'a', seq, type: seq % 2 ? 'user/message' : 'turn/start', time: 0, surface: 'log-only' })),
    filterEvents: async (_, filters) => { ranges.push(filters[0]); return [1, 3].map(seq => ({ seq, text: '中文😀测试' })) },
  }), { previewChars: 3 })
  const page = await run(f, 'session_event_list', { session_id: 'a', event_types: ['user/message'], limit: 2 })
  assert.deepEqual(ranges[0], { kind: 'seq', from: 1, to: 3 })
  assert.deepEqual(page.items.map(x => x.seq), [1, 3]); assert.equal(page.items[0].preview, '中文😀')
  assert.equal(page.items[0].text_truncated, true); assert.equal(page.has_more, true)
  assert.equal(page.next_after_seq, 3)
})
test('current-session indexed search uses projection boundary, never lists raw events', async () => {
  let range
  const f = setup(provider({ listEvents: async () => { throw new Error('full log read forbidden') }, searchEvents: async request => { range = request.filters[0]; return { session: header('self'), items: [], nextCursor: undefined } } }))
  assert.equal((await run(f, 'session_event_search', { session_id: 'self', query: 'token' })).has_more, false)
  assert.deepEqual(range, { kind: 'seq', to: 2 })
})
test('event search returns provider page in one call with cursor unchanged', async () => {
  const requests = []
  const f = setup(provider({ searchEvents: async request => { requests.push(request); return { session: header('a'), items: [0, 1].map(seq => ({ seq, type: 'user/message', snippet: 'token' })), nextCursor: 'opaque' } } }))
  const result = await run(f, 'session_event_search', { session_id: 'a', query: 'token', limit: 2 })
  assert.equal(requests.length, 1); assert.equal(requests[0].limit, 2)
  assert.deepEqual(result.items.map(item => item.seq), [0, 1]); assert.equal(result.next_cursor, 'opaque')
})
test('abort before indexed query and mid-provider result prevents success', async () => {
  let searched = false
  const f = setup(provider({ searchSessions: async () => { searched = true; return { items: [], nextCursor: undefined } } }))
  f.exec.signal = AbortSignal.abort()
  await assert.rejects(run(f, 'session_search', { query: 'token' }))
  assert.equal(searched, false)
})
test('registration failure rolls back earlier registrations', () => {
  const definitions = new Map()
  const ctx = { sessionQuery: provider(), tools: { register(definition) { if (definitions.size === 3) throw new Error('registry failure'); definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } }, effect(fn) { fn() } }
  assert.throws(() => apply(ctx, config), /registry failure/)
  assert.equal(definitions.size, 0)
})
test('config schema defaults and rejects invalid values', async () => {
  const { Config } = await import('../dist/index.js')
  assert.deepEqual(Config({}), config)
  assert.throws(() => Config({ outputBytes: 128 }), /outputBytes/)
  assert.throws(() => Config({ searchTimeoutMs: 0 }), /searchTimeoutMs/)
  assert.throws(() => setup(provider(), { pageSize: 90, maxPageSize: 10 }), /pageSize/)
})
test('long cursor cannot escape final output UTF-8 budget', async () => {
  const f = setup(provider({ searchEvents: async () => ({ session: header('a'), items: [{ seq: 0, type: 'user/message', snippet: '短句' }], nextCursor: 'x'.repeat(2000) }) }), { outputBytes: 1024 })
  await assert.rejects(run(f, 'session_event_search', { session_id: 'a', query: '短句' }), /outputBytes/)
})
test('trace stops ancestry at hidden parent and marks omitted descendants', async () => {
  const f = setup(provider({ traceSession: async () => ({ target: rows[0], ancestors: [rows[1], rows[2]], descendants: [{ session: rows[1], descendants: [{ session: rows[0], descendants: [] }] }], complete: true, root: rows[2] }) }))
  const result = await run(f, 'session_trace', { session_id: 'a' })
  assert.equal(result.ancestors.length, 0); assert.equal(result.scope_limited, true); assert.equal(result.complete, false)
  assert.equal(JSON.stringify(result).includes('foreign'), false)
})
test('budget omission of preview is explicit, never metadata impersonation', async () => {
  const f = setup(provider({ listEvents: async () => [{ sessionId: 'a', seq: 0, type: 'user/message', time: 0, surface: 'current' }], filterEvents: async () => [{ seq: 0, text: '中文'.repeat(1000) }] }), { previewChars: 900, outputBytes: 1024 })
  const result = await run(f, 'session_event_list', { session_id: 'a' })
  assert.deepEqual(result.items[0], { seq: 0, type: 'user/message', preview_omitted: true, text_truncated: true })
})
test('own-session cursor across a new step rejects stale provider cursor', async () => {
  let boundary = 3
  const f = setup(provider({ searchEvents: async request => {
    if (request.cursor && request.filters[0].to !== 2) throw Object.assign(new Error('stale cursor'), { code: 'SESSION_QUERY_STALE_CURSOR' })
    return { session: header('self'), items: [{ seq: 0, type: 'user/message', snippet: 'needle' }], nextCursor: 'opaque' }
  } }))
  f.exec.agent.session.id = 'self'
  const original = f.definitions.get('session_event_search')
  const first = await original.execute({ session_id: 'self', query: 'needle', limit: 1 }, f.exec)
  assert.equal(first.next_cursor, 'opaque')
  // A new step changes the formal projection and invalidates the old provider query fingerprint.
  boundary = 9
  f.ctx.sessionProjections.stateOf = () => ({ lastStepStartSeq: boundary })
  await assert.rejects(original.execute({ session_id: 'self', query: 'needle', limit: 1, cursor: first.next_cursor }, f.exec), e => e.code === 'SESSION_QUERY_STALE_CURSOR' && /no logs were scanned/i.test(e.message))
})
