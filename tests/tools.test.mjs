import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../dist/index.js'

const config = { pageSize: 30, maxPageSize: 100, previewChars: 240, outputBytes: 24576, searchTimeoutMs: 30000, eventReadCacheEntries: 8, eventReadCacheBytes: 67108864 }
function setup(query, options = {}) {
  const definitions = new Map()
  let cleanup
  const ctx = { get(name) { return this[name] }, sessionQuery: query, workspaceRegistry: { archivedSessionIds: [] }, sessionProjections: { stateOf: () => ({ lastStepStartSeq: 3 }) }, tools: { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } }, effect(fn) { cleanup = fn() } }
  apply(ctx, { ...config, ...options })
  const controller = new AbortController()
  const exec = { signal: controller.signal, agent: { session: { id: 'self', header: { cwd: '/one' } } } }
  return { ctx, definitions, exec, dispose: () => cleanup() }
}
const header = (id, cwd = '/one') => ({ id, cwd, createdAt: 1 })
const rows = [header('a'), header('b', '/two'), header('self')].map(header => ({ header, live: false, persisted: true }))
function provider(extra = {}) {
  return {
    async pageSessions(request) {
      const source = await (extra.listSessions?.() ?? rows)
      const visible = source.filter(row => !request.filters?.length || row.header.cwd === request.filters[0].values[0])
      const offset = Number(request.cursor ?? 0)
      return { items: visible.slice(offset, offset + request.limit), ...(offset + request.limit < visible.length ? { nextCursor: String(offset + request.limit) } : {}) }
    },
    async pageEvents(request) {
      const records = await (extra.listEvents?.() ?? [])
      const selected = records.filter(item => item.seq > (request.afterSeq ?? -1) && (request.types === undefined || request.types.includes(item.type)))
      const items = selected.slice(0, request.limit)
      const docs = request.includeText && items.length ? await (extra.filterEvents?.(request.sessionId, [{ kind: 'seq', from: items[0].seq, to: items.at(-1).seq }]) ?? []) : []
      return {
        session: header(request.sessionId),
        items: items.map(item => { const doc = docs.find(doc => doc.seq === item.seq); return { ...item, ...(doc ? { text: doc.text } : {}) } }),
        ...(selected.length > items.length ? { nextAfterSeq: items.at(-1).seq } : {}),
        capturedThroughSeq: records.at(-1)?.seq ?? -1,
      }
    },
    readTitleSnapshots: async ids => ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { session: rows.find(item => item.header.id === sessionId)?.header ?? header(sessionId), title: { title: 'Test title' } } })),
    listSessions: async () => rows,
    filterSessions: async filters => rows.filter(x => x.header.id === filters[0].values[0]),
    listEvents: async () => [], filterEvents: async () => [],
    readEvent: async () => ({ session: header('a'), target: { seq: 0, type: 'user/message', text: '你好' } }),
    traceSession: async () => ({ target: rows[0], ancestors: [rows[1]], descendants: [{ session: rows[1], descendants: [{ session: rows[0], descendants: [] }] }], complete: true, root: rows[1] }),
    traceEvent: async () => ({ session: header('a'), target: { sessionId: 'a', seq: 0, type: 'user/message', time: 0, surface: 'current' }, replacementChain: [2], replacedEventSeqs: [], sourceEventSeqs: [1], derivedEventSeqs: [3] }),
    ...extra,
  }
}
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
test('session search excludes archives by default and includes them only on request', async () => {
  const calls = []; const titleBatches = []
  const f = setup(provider({
    searchSessions: async request => { calls.push(request); return { items: [rows[0], rows[2]].map(row => ({ ...row, bestMatch: { seq: 1, type: 'user/message', snippet: 'hello' } })) } },
    readTitleSnapshots: async ids => { titleBatches.push(ids); return provider().readTitleSnapshots(ids) },
  }))
  f.ctx.workspaceRegistry.archivedSessionIds = ['a']
  const tool = f.definitions.get('session_search')
  assert.match(tool.description, /Do not search archived sessions unless there is a specific need/)
  for (const include_archived of [undefined, false]) {
    const args = { query: 'hello', include_current: true, ...(include_archived === undefined ? {} : { include_archived }) }
    const page = await run(f, 'session_search', args)
    assert.deepEqual(page.items.map(item => [item.session_id, item.archived]), [['self', false]])
  }
  assert.deepEqual(titleBatches, [['self'], ['self']])
  const included = await run(f, 'session_search', { query: 'hello', include_archived: true })
  assert.deepEqual(included.items.map(item => [item.session_id, item.archived]), [['a', true]])
  assert.deepEqual(calls[2].sessionFilters, [{ kind: 'cwd', values: ['/one'] }])
  f.ctx.workspaceRegistry.archivedSessionIds = []
  const restored = await run(f, 'session_search', { query: 'hello', scope: 'all' })
  assert.deepEqual(restored.items.map(item => [item.session_id, item.archived]), [['a', false]])
  assert.deepEqual(calls[3].sessionFilters, [])
})
test('archive-only provider page stays empty with its cursor and does not refill', async () => {
  const calls = []
  const f = setup(provider({ searchSessions: async request => {
    calls.push(request)
    const row = request.cursor ? rows[2] : rows[0]
    return { items: [{ ...row, bestMatch: { seq: 1, type: 'user/message', snippet: 'hello' } }], ...(request.cursor ? {} : { nextCursor: 'next' }) }
  } }))
  f.ctx.workspaceRegistry.archivedSessionIds = ['a']
  const first = await run(f, 'session_search', { query: 'hello', limit: 1, include_current: true })
  assert.deepEqual(first, { items: [], has_more: true, next_cursor: 'next' })
  assert.equal(calls.length, 1)
  const next = await run(f, 'session_search', { query: 'hello', limit: 1, include_current: true, cursor: first.next_cursor })
  assert.deepEqual(next.items.map(item => item.session_id), ['self'])
  assert.equal(next.has_more, false); assert.equal(calls[1].cursor, 'next')
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
test('cached current title, empty string and explicit null avoid exact title reads', async () => {
  for (const title of ['Checkpoint title', '', null]) {
    const f = setup(provider({ readTitleSnapshots: async () => { throw new Error('exact title read forbidden') } }))
    const seen = []
    f.ctx.sessionProjectionCache = {
      cachedSnapshot(meta, keys) { seen.push(meta); assert.deepEqual(keys, ['title']); return { values: { title } } },
      cachedPredecessorTitle() { throw new Error('usable current title must win') },
    }
    const result = await run(f, 'session_list', {})
    assert.deepEqual(seen, [rows[0].header, rows[2].header])
    assert.deepEqual(result.items, ['a', 'self'].map(session_id => ({ session_id, title: title ?? '(untitled)', title_cached: true })))
  }
})
test('missing current title uses predecessor hint, including explicit null', async () => {
  const f = setup(provider({ readTitleSnapshots: async () => { throw new Error('exact title read forbidden') } }))
  const seen = []
  f.ctx.sessionProjectionCache = {
    cachedSnapshot: () => ({ values: {} }),
    cachedPredecessorTitle(meta) { seen.push(meta); return { values: { title: meta.id === 'a' ? 'Older title' : null } } },
  }
  assert.deepEqual((await run(f, 'session_list', {})).items, [
    { session_id: 'a', title: 'Older title', title_cached: true },
    { session_id: 'self', title: '(untitled)', title_cached: true },
  ])
  assert.deepEqual(seen, [rows[0].header, rows[2].header])
})
test('unusable cache snapshots without title keys fall back to the exact batch', async () => {
  const batches = []
  const f = setup(provider({ readTitleSnapshots: async ids => { batches.push(ids); return provider().readTitleSnapshots(ids) } }))
  f.ctx.sessionProjectionCache = { cachedSnapshot: () => ({ values: {} }), cachedPredecessorTitle: () => ({ values: {} }) }
  const result = await run(f, 'session_list', {})
  assert.deepEqual(batches, [['a', 'self']])
  assert.deepEqual(result.items, ['a', 'self'].map(session_id => ({ session_id, title: 'Test title' })))
})
test('mixed list and search hints batch only unresolved ids and omit fallback flags', async () => {
  const batches = []
  const f = setup(provider({
    readTitleSnapshots: async ids => { batches.push(ids); return provider().readTitleSnapshots(ids) },
    searchSessions: async () => ({ items: [rows[0], rows[2]].map(row => ({ ...row, bestMatch: { seq: 1, type: 'user/message', snippet: 'matched' } })), nextCursor: 'next' }),
  }))
  f.ctx.sessionProjectionCache = {
    cachedSnapshot: meta => meta.id === 'a' ? { values: { title: 'Cached' } } : undefined,
    cachedPredecessorTitle: () => undefined,
  }
  const list = await run(f, 'session_list', {})
  const search = await run(f, 'session_search', { query: 'matched', include_current: true })
  for (const page of [list, search]) {
    assert.equal(page.items[0].title_cached, true); assert.equal(page.items[0].title, 'Cached')
    assert.equal(Object.hasOwn(page.items[1], 'title_cached'), false); assert.equal(page.items[1].title, 'Test title')
  }
  assert.deepEqual(batches, [['self'], ['self']])
  assert.deepEqual(search.items.map(item => [item.session_id, item.seq, item.snippet]), [['a', 1, 'matched'], ['self', 1, 'matched']])
  assert.equal(search.next_cursor, 'next')
})
test('live record and newly attached Session skip stale hints and use exact title reads', async () => {
  const batches = []
  const f = setup(provider({
    listSessions: async () => [{ ...rows[0], live: true }, rows[2]],
    readTitleSnapshots: async ids => { batches.push(ids); return provider().readTitleSnapshots(ids) },
  }))
  f.ctx.sessions = { get: id => id === 'self' ? f.exec.agent.session : undefined }
  f.ctx.sessionProjectionCache = { cachedSnapshot() { throw new Error('stale hint forbidden for live Session') } }
  const result = await run(f, 'session_list', {})
  assert.deepEqual(batches, [['a', 'self']])
  assert.equal(result.items.some(item => Object.hasOwn(item, 'title_cached')), false)
})
test('cache cannot bypass search header or fallback title authorization', async () => {
  let consulted = false
  const f = setup(provider({ searchSessions: async () => ({ items: [{ ...rows[1], bestMatch: { seq: 1, type: 'user/message', snippet: 'foreign' } }] }) }))
  f.ctx.sessionProjectionCache = { cachedSnapshot() { consulted = true; return { values: { title: 'Foreign' } } } }
  await assert.rejects(run(f, 'session_search', { query: 'foreign' }), /outside the caller project/)
  assert.equal(consulted, false)
  assert.deepEqual((await run(f, 'session_list', {})).items.map(item => item.session_id), ['a', 'self'])
  const fallback = setup(provider({ readTitleSnapshots: async ids => ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { session: header(sessionId, '/two'), title: null } })) }))
  await assert.rejects(run(fallback, 'session_list', {}), /outside the caller project/)
})
test('cache read failures and exact title provider rejections propagate unchanged', async () => {
  const error = new Error('cache unavailable')
  for (const method of ['cachedSnapshot', 'cachedPredecessorTitle']) {
    const f = setup(provider({ readTitleSnapshots: async () => { throw new Error('silent fallback forbidden') } }))
    f.ctx.sessionProjectionCache = { cachedSnapshot: () => undefined, [method]() { throw error } }
    await assert.rejects(run(f, 'session_list', {}), e => e === error)
  }
  const f = setup(provider({ readTitleSnapshots: async ids => ids.map(sessionId => ({ sessionId, status: 'rejected', reason: error })) }))
  await assert.rejects(run(f, 'session_list', {}), e => e === error)
})
test('complete list and search output budgets count cached flags', async () => {
  const f = setup(provider({
    listSessions: async () => [rows[0], rows[2]],
    readTitleSnapshots: async () => { throw new Error('exact title read forbidden') },
    searchSessions: async () => ({ items: [{ ...rows[0], bestMatch: { seq: 1, type: 'user/message', snippet: 'hit' } }] }),
  }), { previewChars: 1000 })
  f.ctx.sessionProjectionCache = { cachedSnapshot: () => ({ values: { title: '中'.repeat(300) } }) }
  const list = await run(f, 'session_list', {})
  const listBudget = Buffer.byteLength(JSON.stringify({ ...list, items: list.items.map(({ title_cached, ...item }) => item) }))
  const limitedList = setup(f.ctx.sessionQuery, { previewChars: 1000, outputBytes: listBudget })
  limitedList.ctx.sessionProjectionCache = f.ctx.sessionProjectionCache
  await assert.rejects(run(limitedList, 'session_list', {}), /lower limit.*no partial result/)
  const search = await run(f, 'session_search', { query: 'hit' })
  const searchBudget = Buffer.byteLength(JSON.stringify({ ...search, items: search.items.map(({ title_cached, ...item }) => item) }))
  const limitedSearch = setup(f.ctx.sessionQuery, { previewChars: 1000, outputBytes: searchBudget })
  limitedSearch.ctx.sessionProjectionCache = f.ctx.sessionProjectionCache
  await assert.rejects(run(limitedSearch, 'session_search', { query: 'hit' }), /no partial result/)
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
  assert.equal(page.items[0].text_truncated, true); assert.equal(page.has_more, false)
  assert.equal(page.next_after_seq, null)
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
  assert.throws(() => Config({ eventReadCacheEntries: -1 }), /eventReadCacheEntries/)
  assert.throws(() => Config({ eventReadCacheBytes: -1 }), /eventReadCacheBytes/)
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

test('trace titles batch only visible nodes, deduplicate root and preserve cached flags', async () => {
  const batches = []; const cacheIds = []
  const child = { header: header('child'), live: false, persisted: true }
  const f = setup(provider({ traceSession: async () => ({ target: rows[0], ancestors: [rows[2], rows[1]], descendants: [{ session: child, descendants: [] }, { session: rows[1], descendants: [{ session: rows[0], descendants: [] }] }], complete: true, root: rows[1] }), readTitleSnapshots: async ids => { batches.push(ids); return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { session: header(sessionId), title: { title: sessionId + ' title' } } })) } }))
  f.ctx.sessionProjectionCache = { cachedSnapshot(meta) { cacheIds.push(meta.id); return meta.id === 'child' ? { values: { title: 'Child hint' } } : meta.id === 'b' ? { values: { title: 'Root hint' } } : undefined }, cachedPredecessorTitle: () => undefined }
  const project = await run(f, 'session_trace', { session_id: 'a' })
  assert.deepEqual(batches, [['a', 'self']]); assert.deepEqual(cacheIds, ['a', 'self', 'child'])
  assert.equal(project.target.title, 'a title'); assert.equal(project.ancestors[0].title, 'self title')
  assert.deepEqual(project.descendants[0].session, { session_id: 'child', title: 'Child hint', title_cached: true })
  batches.length = 0; cacheIds.length = 0
  const all = await run(f, 'session_trace', { session_id: 'a', scope: 'all' })
  assert.deepEqual(batches, [['a', 'self']]); assert.equal(all.root.title, 'Root hint'); assert.equal(all.root.title_cached, true)
  assert.equal(all.descendants[1].descendants[0].session.title, 'a title')
})
test('large-event continuations reuse preparation, refresh on restart and reauthorize every call', async () => {
  let reads = 0; let text = '旧😀'.repeat(3000)
  const f = setup(provider({ readEvent: async () => { reads++; return { session: header('a'), target: { seq: 0, text } } } }), { outputBytes: 1024 })
  const first = await run(f, 'session_event_read', { session_id: 'a', seq: 0 })
  text = '新😀'.repeat(3000)
  const second = await run(f, 'session_event_read', { session_id: 'a', seq: 0, offset_chars: first.next_offset })
  assert.equal(reads, 1); assert.ok(second.json_fragment.includes('旧'))
  f.exec.agent.session.header.cwd = '/two'
  await assert.rejects(run(f, 'session_event_read', { session_id: 'a', seq: 0, offset_chars: first.next_offset }), /outside/)
  assert.equal(reads, 1)
  f.exec.agent.session.header.cwd = '/one'
  const restarted = await run(f, 'session_event_read', { session_id: 'a', seq: 0, offset_chars: 0 })
  assert.equal(reads, 2); assert.ok(restarted.json_fragment.includes('新'))
  const oldDefinition = f.definitions.get('session_event_read')
  f.dispose()
  await oldDefinition.execute({ session_id: 'a', seq: 0, offset_chars: first.next_offset }, f.exec)
  assert.equal(reads, 3)
  await oldDefinition.execute({ session_id: 'a', seq: 0, offset_chars: first.next_offset }, f.exec)
  assert.equal(reads, 4)
})
test('large-event entry and byte limits evict or disable preparation without cross-session reuse', async () => {
  for (const options of [{ eventReadCacheEntries: 1 }, { eventReadCacheBytes: 0 }, { eventReadCacheEntries: 0 }]) {
    const reads = []
    const f = setup(provider({ readEvent: async request => { reads.push(request.sessionId); return { session: header(request.sessionId), target: { seq: 0, text: request.sessionId.repeat(3000) } } } }), { outputBytes: 1024, ...options })
    const a = await run(f, 'session_event_read', { session_id: 'a', seq: 0 })
    await run(f, 'session_event_read', { session_id: 'self', seq: 0 })
    const continuation = await run(f, 'session_event_read', { session_id: 'a', seq: 0, offset_chars: a.next_offset })
    assert.deepEqual(reads, ['a', 'self', 'a']); assert.ok(continuation.json_fragment.includes('aaa'))
  }
})
test('event listing calls only public page API once with cancellation and metadata/text selection', async () => {
  const calls = []
  const f = setup(provider({ listEvents() { throw new Error('full list forbidden') }, filterEvents() { throw new Error('second log read forbidden') }, pageEvents: async (request, signal) => { calls.push({ request, signal }); return { session: header('a'), items: [{ seq: 2, type: 'user/message', ...(request.includeText ? { text: '中文😀' } : {}) }], nextAfterSeq: 2, capturedThroughSeq: 5 } } }))
  const compact = await run(f, 'session_event_list', { session_id: 'a', after_seq: 0, event_types: ['user/message'], limit: 1 })
  assert.equal(calls.length, 1); assert.equal(calls[0].signal, f.exec.signal)
  assert.deepEqual(calls[0].request, { sessionId: 'a', afterSeq: 0, types: ['user/message'], limit: 1, includeText: true })
  assert.equal(compact.items[0].preview, '中文😀'); assert.equal(compact.next_after_seq, 2)
  await run(f, 'session_event_list', { session_id: 'a', view: 'metadata' })
  assert.equal(calls[1].request.includeText, false)
})
test('session list forwards snapshot cursor and scope to one public page request', async () => {
  const calls = []
  const f = setup(provider({ listSessions() { throw new Error('full list forbidden') }, pageSessions: async (request, signal) => { calls.push({ request, signal }); return { items: [rows[0]], nextCursor: 'snapshot' } } }))
  const first = await run(f, 'session_list', { limit: 1 })
  assert.equal(first.next_cursor, 'snapshot'); assert.equal(Object.hasOwn(first, 'next_offset'), false)
  await run(f, 'session_list', { limit: 1, cursor: first.next_cursor })
  assert.equal(calls.length, 2); assert.equal(calls[1].request.cursor, 'snapshot')
  assert.deepEqual(calls[0].request.filters, [{ kind: 'cwd', values: ['/one'] }]); assert.equal(calls[0].signal, f.exec.signal)
})

test('old query engine fails clearly at plugin load', () => {
  assert.throws(() => setup(provider({ pageSessions: undefined })), /requires sessionQuery/)
})
test('event page never drops metadata records or advances a partial page', async () => {
  const f = setup(provider({ pageEvents: async () => ({ session: header('a'), items: Array.from({ length: 100 }, (_, seq) => ({ seq, type: 'turn/start' })), nextAfterSeq: 99, capturedThroughSeq: 120 }) }), { outputBytes: 1024 })
  await assert.rejects(run(f, 'session_event_list', { session_id: 'a', view: 'metadata', limit: 100 }), /lower limit.*same after_seq.*no partial result/)
})

test('default preparation cache reuses a one-MiB ASCII event across three pages', async () => {
  let reads = 0
  const f = setup(provider({ readEvent: async () => { reads++; return { session: header('a'), target: { seq: 0, text: 'x'.repeat(1024 * 1024) } } } }))
  let offset
  for (let page = 0; page < 3; page++) {
    const part = await run(f, 'session_event_read', { session_id: 'a', seq: 0, ...(offset === undefined ? {} : { offset_chars: offset }) })
    assert.equal(part.format, 'json-unicode-code-points'); assert.ok(part.next_offset > (offset ?? 0))
    assert.ok(Buffer.byteLength(JSON.stringify(part)) <= config.outputBytes)
    offset = part.next_offset
  }
  assert.equal(reads, 1)
})

test('deleted snapshot title source requires restarting listing, preserving provider error', async () => {
  let deleted = false
  const error = Object.assign(new Error('session no longer exists'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
  const f = setup(provider({ pageSessions: async () => ({ items: [rows[0]], nextCursor: 'snapshot' }), readTitleSnapshots: async ids => deleted ? ids.map(sessionId => ({ sessionId, status: 'rejected', reason: error })) : provider().readTitleSnapshots(ids) }))
  const first = await run(f, 'session_list', { limit: 1 }); deleted = true
  await assert.rejects(run(f, 'session_list', { limit: 1, cursor: first.next_cursor }), failure => failure === error && /Snapshot item no longer available; start a new listing without a cursor/.test(failure.message))
})
