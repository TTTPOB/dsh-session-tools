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
    const own = await execute('session_event_search', { session_id: 'one', query: 'needle' })
    assert.equal(own.items.length, 1); assert.equal(own.has_more, false)
    const list = await execute('session_list', { limit: 1 })
    assert.equal(list.items.length, 1); assert.equal(list.has_more, true)
    const events = await execute('session_event_list', { session_id: 'one' })
    assert.equal(events.items[0].seq, 0)
    const raw = await execute('session_event_read', { session_id: 'one', seq: 0 })
    assert.equal(raw.format, 'event-json')
    const trace = await execute('session_event_trace', { session_id: 'one', seq: 0 })
    assert.equal(trace.target.seq, 0)
    const lineage = await execute('session_trace', { session_id: 'one' })
    assert.equal(lineage.target.session_id, 'one')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
