import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as plugin from '../dist/index.js'
import { readFile } from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendReadingHistory, readingContract } from './fixtures/reading.mjs'

test('real Cordis Loader mounts built ESM through cordis.yml then disposes tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-tools-loader-'))
  const configPath = join(root, 'cordis.yml')
  const tools = new Map()
  const ctx = new Context()
  try {
    await writeFile(configPath, "- name: 'dsh-session-tools'\n")
    ctx.baseUrl = pathToFileURL(root).href + '/'
    ctx.provide('tools', { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } })
    ctx.provide('workspaceRegistry', { archivedSessionIds: ['archived'] })
    ctx.provide('sessionProjections', { stateOf: () => ({ lastStepStartSeq: 3 }) })
    ctx.provide('sessionQuery', {
      pageSessions: async () => ({ items: [] }),
      pageEvents: async () => ({ session: {}, items: [], capturedThroughSeq: -1 }),
      observeSession: async () => { throw new Error('search must not observe logs') },
      searchSessions: async () => ({ items: [{ header: { id: 'archived', cwd: '/one' }, live: false, persisted: true, bestMatch: { seq: 1, type: 'user/message', snippet: 'archived needle' } }] }),
      readTitleSnapshots: async ids => ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { session: { id: sessionId, cwd: '/one' }, title: { title: 'Archived work' } } })),
    })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', async import(specifier) {
      assert.equal(specifier, 'dsh-session-tools')
      return plugin
    } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    assert.equal(tools.size, 7)
    assert.equal(typeof tools.get('session_search').execute, 'function')
    const listed = await tools.get('session_list').execute({}, { signal: new AbortController().signal, agent: { session: { id: 'caller', header: { cwd: '/one' } } } })
    assert.deepEqual(listed, { items: [], has_more: false, next_cursor: null })
    const exec = { signal: new AbortController().signal, agent: { session: { id: 'caller', header: { cwd: '/one' } } } }
    const search = tools.get('session_search')
    assert.deepEqual(await search.execute({ query: 'needle' }, exec), { items: [], has_more: false, next_cursor: null })
    const included = await search.execute({ query: 'needle', include_archived: true }, exec)
    assert.equal(included.items[0].session_id, 'archived')
    assert.equal(included.items[0].archived, true)
    await ctx.fiber.dispose()
    assert.equal(tools.size, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Loader + actual SQLite executes compact/target/activity/Raw contracts and releases cancelled cuts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-tools-loader-sqlite-'))
  const ctx = new Context()
  try {
    const packages = ['session', 'session-projection', 'system-prompt', 'tools', 'session-persistence-jsonl', 'session-query-sqlite']
    const modules = new Map(await Promise.all(packages.map(async name => [name, await import(`@deepseek-ai/dsh-${name}`)])))
    modules.set('dsh-session-tools', plugin)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      ...packages.map(name => `- name: '${name}'${name === 'session-persistence-jsonl' ? `\n  config: {root: '${root}', compression: none}` : name === 'session-query-sqlite' ? `\n  config: {path: '${join(root, 'index.db')}'}` : ''}`),
      '- name: dsh-session-tools\n  config: {readTimeoutMs: 200, readBatchSize: 16, projectionItems: 256, projectionNodes: 4096, outputBytes: 262144}',
    ].join('\n') + '\n')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', async import(specifier) { return modules.get(specifier) } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const caller = ctx.sessions.create(SessionId('reading-caller'), { meta: { createdAt: 1, cwd: '/one' } })
    const session = ctx.sessions.create(SessionId('reading-history'), { meta: { createdAt: 2, cwd: '/one' } })
    const history = appendReadingHistory(session)
    let serial = 0
    const execute = async (name, args, signal = new AbortController().signal) => ctx.tools.execute({ name, arguments: { session_id: session.id, ...args }, callId: ToolCallId(`loader-reading-${++serial}`), signal, agent: { id: caller.id, session: caller } })
    const value = async (name, args) => {
      const result = await execute(name, args)
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.deepEqual(JSON.parse(result.content.find(block => block.type === 'text').text), result.value)
      return result.value
    }
    const page = await value('session_event_list', { after_seq: 1, limit: 1 })
    const expected = JSON.parse(await readFile(new URL('./fixtures/reading-expected.json', import.meta.url), 'utf8'))
    assert.deepEqual(readingContract(page), expected)
    const next = await value('session_event_list', { after_seq: page.next_after_seq, limit: 1 })
    assert.equal(next.activities[0].activity_id, page.activities[0].activity_id)
    assert.deepEqual(next.activities[0].page_source_seqs, [3]); assert.equal(next.next_after_seq, 3)
    const filtered = await value('session_event_list', { event_types: ['tool/result'], limit: 1 })
    assert.deepEqual(filtered.activities[0].page_source_seqs, [history.result])
    assert.equal(filtered.activities[0].tools[0].start_seq, history.call)
    assert.equal(filtered.next_after_seq, history.result)
    const target = await value('session_event_read', { seq: history.failed.result })
    assert.equal(target.read_scope, 'target'); assert.equal(target.complete, true)
    assert.deepEqual(target.source_seqs, [history.failed.start, history.failed.result])
    assert.equal(target.tools.length, 1); assert.equal(target.tools[0].call_id, 'reading-child-42')
    assert.equal(target.tools[0].children, undefined)
    assert.deepEqual(target.activity_locator, { root_call_id: 'reading-root', parent_call_id: 'reading-root' })
    const activity = await value('session_event_read', { seq: history.failed.result, read_scope: 'activity' })
    assert.equal(activity.activity_id, 'step:1:1'); assert.equal(activity.complete, true)
    assert.equal(activity.tools[0].is_error, false)
    assert.equal(activity.tools[0].children[42].is_error, true)
    const replaced = await value('session_event_read', { seq: history.replacement })
    assert.equal(replaced.requested_seq, history.replacement)
    assert.equal(replaced.tools[0].result_seq, history.result)
    assert.match(JSON.stringify(replaced.tools[0].result), /parent succeeded/)
    const raw = await value('session_event_read', { seq: history.replacement, view: 'raw' })
    assert.equal(raw.event.seq, history.replacement); assert.equal(raw.event.surfaceOp.op, 'replace')
    assert.match(JSON.stringify(raw.event), /PRUNED/)
    for (const args of [{ seq: history.call, offset_chars: 0 }, { seq: history.call, view: 'raw', read_scope: 'activity' }]) {
      const rejected = await execute('session_event_read', args)
      assert.equal(rejected.isError, true)
    }
    // The reader owns the sole lease; appends during scanning stay beyond its captured cut.
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    let released = 0, captured, cancelAfterRead
    ctx.sessionQuery.observeSession = async (...args) => {
      const lease = await observe(...args); captured = lease.cursor
      let appended = false
      return { header: lease.header, cursor: lease.cursor, get events() { throw new Error('full .events materialization forbidden') },
        readEvents(from, to) {
          if (cancelAfterRead) { const controller = cancelAfterRead; cancelAfterRead = undefined; setImmediate(() => controller.abort(new Error('reading cancelled'))) }
          if (!appended) { appended = true; session.append('user/message', createUserMessage({ content: [], source: { kind: 'user' } }), { surfaceOp: 'append' }) }
          return lease.readEvents(from, to)
        },
        [Symbol.dispose]() { released++; lease[Symbol.dispose]() },
      }
    }
    const fixed = await value('session_event_list', { after_seq: history.end, view: 'metadata', limit: 100 })
    assert.equal(fixed.captured_through_seq, captured)
    assert.ok(fixed.items.every(item => item.seq <= captured)); assert.equal(fixed.has_more, false); assert.equal(released, 1)
    // Sparse filtering must yield to cancellation rather than returning a false EOF.
    for (let i = 0; i < 1000; i++) session.append('todo/write', { todos: [] })
    const abort = new AbortController()
    cancelAfterRead = abort
    const pending = execute('session_event_list', { event_types: ['session/title'], view: 'metadata' }, abort.signal)
    const cancelled = await pending
    assert.equal(cancelled.isError, true); assert.match(JSON.stringify(cancelled), /cancel/i)
    assert.equal(released, 2)
    // A configured real executor deadline must reject and release an already acquired lease.
    ctx.sessionQuery.observeSession = async (id, options) => {
      const lease = await observe(id, options)
      await new Promise(resolve => options.signal.aborted ? resolve() : options.signal.addEventListener('abort', resolve, { once: true }))
      return { header: lease.header, cursor: lease.cursor, readEvents: lease.readEvents,
        [Symbol.dispose]() { released++; lease[Symbol.dispose]() },
      }
    }
    const timedOut = await execute('session_event_list', { view: 'metadata' })
    assert.equal(timedOut.isError, true); assert.match(JSON.stringify(timedOut), /timeout|timed out/i)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(released, 3)
    ctx.sessionQuery.observeSession = observe
    const toolRegistry = ctx.tools
    await ctx.fiber.dispose()
    assert.equal(toolRegistry.get('session_event_list'), undefined)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
