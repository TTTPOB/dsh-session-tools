import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../dist/index.js'

test('actual SQLite index honors project/all, cursor and native tool results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-tools-sqlite-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'index.db') })
    const archives = { archivedSessionIds: [] }
    ctx.provide('workspaceRegistry', archives)
    await ctx.plugin(plugin)
    await ctx.loader?.await?.()
    for (const [id, cwd] of [['one', '/one'], ['two', '/one'], ['foreign', '/two']]) {
      const session = ctx.sessions.create(SessionId(id), { meta: { createdAt: id === 'one' ? 1 : id === 'two' ? 2 : 3, cwd } })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `indexed needle ${id}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    const caller = ctx.sessions.create(SessionId('caller'), { meta: { createdAt: 4, cwd: '/one' } })
    caller.append('turn/start', { turn: 1 }); caller.append('step/start', { turn: 1, step: 1 })
    let serial = 0
    const execute = async (name, arguments_) => {
      const result = await ctx.tools.execute({ name, arguments: arguments_, callId: ToolCallId(`sqlite-${++serial}`), signal: new AbortController().signal, agent: { id: caller.id, session: caller } })
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.ok(result.value && typeof result.value === 'object')
      assert.equal(JSON.parse(result.content.find(x => x.type === 'text').text).has_more, result.value.has_more)
      return result.value
    }
    const first = await execute('session_search', { query: 'needle', limit: 1 })
    assert.equal(first.items.length, 1); assert.equal(first.has_more, true)
    const second = await execute('session_search', { query: 'needle', limit: 1, cursor: first.next_cursor })
    assert.equal(second.items.length, 1); assert.notEqual(second.items[0].session_id, first.items[0].session_id)
    const all = await execute('session_search', { query: 'needle', scope: 'all' })
    assert.equal(all.items.length, 3); assert.ok(all.items.every(item => 'cwd' in item))
    archives.archivedSessionIds = [SessionId('one'), SessionId('foreign')]
    const active = await execute('session_search', { query: 'needle', scope: 'all' })
    assert.deepEqual(active.items.map(item => [item.session_id, item.archived]), [['two', false]])
    const withArchives = await execute('session_search', { query: 'needle', include_archived: true })
    assert.deepEqual(new Set(withArchives.items.map(item => item.session_id)), new Set(['one', 'two']))
    assert.equal(withArchives.items.find(item => item.session_id === 'one').archived, true)
    archives.archivedSessionIds = []
    const own = await execute('session_event_search', { session_id: 'one', query: 'needle' })
    assert.equal(own.items.length, 1); assert.equal(own.has_more, false)
    const list = await execute('session_list', { limit: 1 })
    assert.equal(list.items.length, 1); assert.equal(list.has_more, true)
    const inserted = ctx.sessions.create(SessionId('inserted'), { meta: { createdAt: 100, cwd: '/one' } })
    inserted.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new session' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const listSecond = await execute('session_list', { limit: 1, cursor: list.next_cursor })
    assert.equal(listSecond.items[0].session_id, 'two')
    const listThird = await execute('session_list', { limit: 1, cursor: listSecond.next_cursor })
    assert.equal(listThird.items[0].session_id, 'one'); assert.equal(listThird.has_more, false)
    const events = await execute('session_event_list', { session_id: 'one' })
    assert.equal(events.items[0].seq, 0)
    const raw = await execute('session_event_read', { session_id: 'one', seq: 0 })
    assert.equal(raw.format, 'event-json')
    const trace = await execute('session_event_trace', { session_id: 'one', seq: 0 })
    assert.equal(trace.target.seq, 0)
    const lineage = await execute('session_trace', { session_id: 'one' })
    assert.equal(lineage.target.session_id, 'one')
    const one = ctx.sessions.get(SessionId('one'))
    one.append('session/title', { title: '真实标题', messageSeqs: [], source: { kind: 'user' } })
    assert.equal((await execute('session_trace', { session_id: 'one' })).target.title, '真实标题')
    const largeText = '原始中文😀'.repeat(5000)
    const original = one.append('user/message', createUserMessage({ content: [{ type: 'text', text: largeText }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const exactRead = ctx.sessionQuery.readEvent.bind(ctx.sessionQuery)
    let rawReads = 0
    ctx.sessionQuery.readEvent = async (...args) => { rawReads++; return exactRead(...args) }
    const beginning = await execute('session_event_read', { session_id: 'one', seq: original.seq })
    const replacement = one.append('user/message', createUserMessage({ content: [{ type: 'text', text: '替换后' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
    const parts = [beginning.json_fragment]; let offset = beginning.next_offset
    while (offset !== null) {
      const part = await execute('session_event_read', { session_id: 'one', seq: original.seq, offset_chars: offset })
      parts.push(part.json_fragment); offset = part.next_offset
    }
    assert.equal(rawReads, 1)
    assert.equal(JSON.parse(parts.join('')).data.content[0].text, largeText)
    assert.equal((await execute('session_event_read', { session_id: 'one', seq: replacement.seq })).event.data.content[0].text, '替换后')
    ctx.sessionQuery.readEvent = exactRead
    // Use multiple requested hits so the old internal paging loop would fail.
    for (const id of ['three', 'four']) {
      const session = ctx.sessions.create(SessionId(id), { meta: { createdAt: 5, cwd: '/one' } })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `indexed needle ${id}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    // A live update after the provider returns must not invalidate this first tool call.
    const originalSearch = ctx.sessionQuery.searchSessions.bind(ctx.sessionQuery)
    let providerCalls = 0
    ctx.sessionQuery.searchSessions = async (...args) => {
      providerCalls++
      const page = await originalSearch(...args)
      caller.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'indexed needle live' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      return page
    }
    const livePage = await execute('session_search', { query: 'needle', limit: 3 })
    assert.equal(providerCalls, 1); assert.equal(livePage.items.length, 3)
    assert.equal(livePage.has_more, true)
    const stale = await ctx.tools.execute({ name: 'session_search', arguments: { query: 'needle', limit: 3, cursor: livePage.next_cursor }, callId: ToolCallId(`sqlite-${++serial}`), signal: new AbortController().signal, agent: { id: caller.id, session: caller } })
    assert.equal(stale.isError, true); assert.match(JSON.stringify(stale), /stale|cursor/i)
    ctx.sessionQuery.searchSessions = originalSearch
    for (const text of ['indexed needle extra first', 'indexed needle extra second']) {
      ctx.sessions.get(SessionId('one')).append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    const originalEvents = ctx.sessionQuery.searchEvents.bind(ctx.sessionQuery)
    let eventCalls = 0
    ctx.sessionQuery.searchEvents = async (...args) => {
      eventCalls++
      const page = await originalEvents(...args)
      ctx.sessions.get(SessionId('one')).append('user/message', createUserMessage({ content: [{ type: 'text', text: 'indexed needle appended' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      return page
    }
    const eventPage = await execute('session_event_search', { session_id: 'one', query: 'needle', limit: 2 })
    assert.equal(eventCalls, 1); assert.equal(eventPage.items.length, 2)
    ctx.sessionQuery.searchEvents = originalEvents

    const surfaceSession = ctx.sessions.get(SessionId('one'))
    const shadowed = surfaceSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'surfaceprobe original' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const current = surfaceSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'surfaceprobe replacement' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: shadowed.seq, endSeq: shadowed.seq }, sourceEventSeqs: [shadowed.seq] })
    const logOnly = surfaceSession.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('surface-call'), name: 'read', arguments: JSON.stringify({ file_path: 'surfaceprobe' }) })
    surfaceSession.append('system/message', { role: 'system', content: [{ type: 'text', text: 'unindexedprobe' }] }, { surfaceOp: 'append' })
    const search = extra => execute('session_event_search', { session_id: 'one', query: 'surfaceprobe', ...extra })
    const expected = [[shadowed.seq, 'shadowed'], [current.seq, 'current'], [logOnly.seq, 'log-only']]
    const defaults = await search({})
    assert.deepEqual(new Set(defaults.items.map(item => item.surface)), new Set(expected.map(([, surface]) => surface)))
    for (const [seq, surface] of expected) {
      const selected = await search({ surfaces: [surface], limit: 1 })
      assert.deepEqual(selected.items.map(item => [item.seq, item.surface, item.read_seq]), [[seq, surface, seq]])
      assert.equal(selected.has_more, false)
      assert.equal(typeof selected.items[0].time, 'number')
      assert.match(selected.items[0].snippet, /surfaceprobe/)
    }
    const selection = { surfaces: ['shadowed', 'log-only'], limit: 1 }
    const surfaceFirst = await search(selection)
    assert.equal(surfaceFirst.has_more, true)
    const surfaceNext = await search({ ...selection, cursor: surfaceFirst.next_cursor })
    assert.equal(surfaceNext.has_more, false)
    assert.deepEqual(new Set([...surfaceFirst.items, ...surfaceNext.items].map(item => item.seq)), new Set([shadowed.seq, logOnly.seq]))
    assert.deepEqual((await execute('session_event_search', { session_id: 'one', query: 'unindexedprobe' })).items, [])
    const invalidSurface = await ctx.tools.execute({ name: 'session_event_search', arguments: { session_id: 'one', query: 'surfaceprobe', surfaces: ['invalid'] }, callId: ToolCallId(`sqlite-${++serial}`), signal: new AbortController().signal, agent: { id: caller.id, session: caller } })
    assert.equal(invalidSurface.isError, true)

    const prior = caller.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'ceilingprobe prior' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    caller.append('step/start', { turn: 1, step: 2 })
    caller.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'ceilingprobe executing' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const ceiling = await execute('session_event_search', { session_id: 'caller', query: 'ceilingprobe', surfaces: ['current'] })
    assert.deepEqual(ceiling.items.map(item => item.read_seq), [prior.seq])
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
