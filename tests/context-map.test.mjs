import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { createUserMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import { buildContextMap, getContextMap, resolveSurfaceAnchor, resolveSurfaceRange } from '../dist/context-map.js'
import { contextMapTool } from '../dist/context-map-tool.js'

const options = { mapPageSize: 20, mapMaxPageSize: 100, mapMaxSpans: 12, previewChars: 240, outputBytes: 24576 }
async function fixture(meter = true) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (meter) await ctx.plugin(TokenMeter)
  const session = ctx.sessions.create(SessionId('map-current'), { meta: { cwd: '/project', createdAt: 1 } })
  let captures = 0
  const observation = () => ({ source: 'live', cursor: session.seq - 1,
    readEvents: (from, to) => Array.from({ length: Math.max(0, Math.min(to, session.seq) - from) }, (_, i) => session.eventAt(from + i)),
    projections: ctx.sessionProjections.snapshot(session),
  })
  const query = {
    filterSessions: async () => [{ header: session.header, live: true, persisted: false }],
    async captureSession(id, callback, config) { assert.equal(config.projectionMode, 'all'); assert.equal(id, session.id); captures++; return callback(session, observation()) },
  }
  ctx.provide('sessionQuery', query)
  const exec = { signal: new AbortController().signal, agent: { session } }
  const append = (text, surfaceOp = 'append', source = { kind: 'user' }) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp, ...(typeof surfaceOp === 'object' ? { sourceEventSeqs: session.surface.nodes.slice(session.surface.nodes.indexOf(surfaceOp.startSeq), session.surface.nodes.indexOf(surfaceOp.endSeq) + 1) } : {}) })
  return { ctx, session, observation, exec, append, get captures() { return captures }, close: () => ctx.fiber.dispose() }
}

test('public builder resolves Surface order, not numeric seq; empty nodes and semantic forms survive', async () => {
  const f = await fixture()
  try {
    const empty = f.session.append('system/message', { message: createSystemMessage('') }, { surfaceOp: 'append' })
    f.session.append('turn/start', { turn: 7 }); const step = f.session.append('step/start', { turn: 7, step: 1 })
    const a = f.append('A'), b = f.append('B'), c = f.append('C')
    const replacement = f.append('checkpoint', { op: 'replace', startSeq: a.seq, endSeq: b.seq })
    const notice = f.append('notice body', 'append', { kind: 'user', form: 'notice', summary: 'An event happened' })
    const instructions = f.append('file instructions', 'append', { kind: 'user', form: 'instructions' })
    const value = buildContextMap(f.session, f.observation(), f.ctx.tokenMeter.measure(f.session), {}, options)
    assert.deepEqual(value.nodes.map(n => n.seq), [empty.seq, replacement.seq, c.seq, notice.seq, instructions.seq])
    assert.equal(value.nodes[0].preview, ''); assert.equal(value.nodes[0].estimated_tokens, 0)
    assert.equal(value.nodes[0].role, 'system'); assert.equal(value.nodes[0].source, 'system-prompt')
    assert.equal(value.nodes[3].form, 'notice'); assert.equal(value.nodes[4].form, 'instructions')
    assert.equal(value.nodes[1].navigation.turn, 7); assert.equal(value.nodes[1].navigation.step_start_seq, step.seq)
    assert.deepEqual(resolveSurfaceRange(value.nodes.map(n => n.seq), { start: { seq: replacement.seq, edge: 'before' }, end: { seq: c.seq, edge: 'after' } }), { start_index: 1, end_index: 3 })
    assert.equal(resolveSurfaceAnchor(value.nodes.map(n => n.seq), { seq: c.seq, edge: 'before' }), 2)
    assert.throws(() => resolveSurfaceRange([5, 2], { start: { seq: 2, edge: 'after' }, end: { seq: 5, edge: 'before' } }), /ordered/)
    assert.equal(value.spans.reduce((n, s) => n + s.estimated_tokens, 0), value.metering.surface_tokens)
    assert.equal(value.nodes.reduce((n, item) => n + item.share_of_surface, 0), 1)
    assert.ok(!('map_id' in value)); assert.equal(value.snapshot_ref.session_id, f.session.id)
    const stored = JSON.stringify(value); f.append('later'); assert.equal(JSON.stringify(value), stored)
  } finally { await f.close() }
})

test('windows resample current state, removed anchors fail and boundary sides are exact', async () => {
  const f = await fixture()
  try {
    const refs = Array.from({ length: 30 }, (_, i) => f.append(String(i)))
    const tail = await getContextMap(f.ctx, f.exec, {}, options)
    assert.equal(tail.window.returned, 20); assert.equal(tail.window.start_index, 10); assert.equal(tail.spans.length, 12)
    const input = { view: 'messages', limit: 5, window: { anchor: { seq: refs[2].seq, edge: 'before' }, side: 'before' } }
    const head = await getContextMap(f.ctx, f.exec, input, options)
    assert.deepEqual(head.nodes.map(n => n.seq), refs.slice(0, 2).map(e => e.seq)); assert.deepEqual(head.spans, [])
    const after = await getContextMap(f.ctx, f.exec, { limit: 2, window: { anchor: { seq: refs[2].seq, edge: 'after' }, side: 'after' } }, options)
    assert.deepEqual(after.nodes.map(n => n.seq), refs.slice(3, 5).map(e => e.seq))
    f.append('new tail')
    const next = await getContextMap(f.ctx, f.exec, {}, options)
    assert.equal(next.window.total, 31); assert.notEqual(next.snapshot_ref.map_id, tail.snapshot_ref.map_id)
    f.append('replaced', { op: 'replace', startSeq: refs[2].seq, endSeq: refs[2].seq })
    await assert.rejects(getContextMap(f.ctx, f.exec, input, options), /no longer current/)
    assert.equal(tail.window.total, 30)
  } finally { await f.close() }
})

test('scope is exact caller cwd and authorizes before capture for tool and library', async () => {
  const f = await fixture(false)
  try {
    f.append('private')
    f.exec.agent = { session: { id: 'caller', header: { cwd: '/project/child' } } }
    await assert.rejects(getContextMap(f.ctx, f.exec, { session_id: f.session.id }, options), /outside/)
    assert.equal(f.captures, 0)
    const tool = contextMapTool(f.ctx, options)
    await assert.rejects(tool.execute({ session_id: f.session.id }, f.exec), /outside/)
    assert.equal(f.captures, 0)
    assert.equal((await getContextMap(f.ctx, f.exec, { session_id: f.session.id, scope: 'all' }, options)).nodes.length, 1)
    f.exec.agent.session.header.cwd = undefined
    await assert.rejects(getContextMap(f.ctx, f.exec, { session_id: f.session.id }, options), /header.cwd/)
    assert.equal(f.captures, 1)
    await assert.rejects(tool.execute({ session_id: f.session.id }, f.exec), /header.cwd/)
    assert.equal((await tool.execute({ session_id: f.session.id, scope: 'all' }, f.exec)).nodes.length, 1)
  } finally { await f.close() }
})

test('meter auto/none/require, exact alignment, independent source cut and route capacity', async () => {
  const f = await fixture(false)
  try {
    f.append('text')
    const auto = await getContextMap(f.ctx, f.exec, {}, options)
    assert.equal(auto.metering.available, false); assert.match(auto.metering.reason, /unavailable/)
    assert.equal(auto.nodes[0].estimated_tokens, null); assert.equal(auto.context_summary.pressure, null)
    await assert.rejects(getContextMap(f.ctx, f.exec, { metering: 'require' }, options), /requires/)
    const none = await getContextMap(f.ctx, f.exec, { metering: 'none' }, options)
    assert.match(none.metering.reason, /disabled/)
  } finally { await f.close() }
  const g = await fixture()
  try {
    g.append('text')
    const observed = g.observation(), measurement = g.ctx.tokenMeter.measure(g.session)
    assert.throws(() => buildContextMap(g.session, observed, { ...measurement, nodes: [{ ...measurement.nodes[0], seq: 900 }] }, {}, options), /alignment/)
    const value = buildContextMap(g.session, observed, { ...measurement, logRevision: measurement.logRevision + 3 }, {}, options)
    assert.equal(value.metering.log_revision, value.snapshot_ref.read_seq + 4)
    assert.equal(value.metering.capacity, null)
    const reader = { id: g.session.id, surface: g.session.surface, deriveEventMessage: g.session.deriveEventMessage.bind(g.session),
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 100 }) }
    assert.equal(buildContextMap(reader, observed, measurement, {}, options).metering.share_of_capacity, measurement.totalTokens / 100)
    reader.requestContext = () => ({ provider: 'p', model: 'other', contextWindow: 100 })
    assert.equal(buildContextMap(reader, observed, measurement, {}, options).metering.capacity, null)
    reader.requestContext = () => ({ provider: 'p', model: 'm', contextWindow: 0 })
    assert.equal(buildContextMap(reader, observed, measurement, {}, options).metering.capacity, null)
  } finally { await g.close() }
})

test('preview is Session interpretation; Unicode codepoint preview and whole-result bytes are independent', async () => {
  const f = await fixture()
  try {
    f.append('raw event text')
    const reader = { id: f.session.id, surface: f.session.surface, requestHeader: () => undefined, requestContext: () => undefined,
      deriveEventMessage: event => ({ ...f.session.deriveEventMessage(event), content: [{ type: 'text', text: '中😀'.repeat(200) }] }) }
    const measurement = f.ctx.tokenMeter.measure(f.session)
    const value = buildContextMap(reader, f.observation(), measurement, {}, { ...options, previewChars: 7 })
    assert.equal(value.nodes[0].preview, '中😀中😀中😀中'); assert.equal(value.nodes[0].preview_truncated, true)
    assert.equal(value.nodes[0].preview_basis, 'session-message'); assert.equal(value.metering.basis, 'token-meter/raw-event-fold')
    assert.equal(value.nodes[0].estimated_tokens, measurement.nodes[0].tokens)
    const bytes = Buffer.byteLength(JSON.stringify(value))
    assert.doesNotThrow(() => buildContextMap(reader, f.observation(), measurement, {}, { ...options, previewChars: 7, outputBytes: bytes }))
    assert.throws(() => buildContextMap(reader, f.observation(), measurement, {}, { ...options, previewChars: 7, outputBytes: bytes - 1 }), /outputBytes/)
    await assert.rejects(getContextMap(f.ctx, f.exec, { limit: 101 }, options), /limit/)
    await assert.rejects(getContextMap(f.ctx, f.exec, { limit: 0 }, options), /positive/)
  } finally { await f.close() }
})

test('public subpath exports and empty maps remain usable without a map cache', async () => {
  const entry = await import('dsh-session-tools/context-map')
  assert.equal(entry.buildContextMap, buildContextMap)
  assert.equal(entry.getContextMap, getContextMap)
  const f = await fixture()
  try {
    const value = await getContextMap(f.ctx, f.exec, {}, options)
    assert.equal(value.snapshot_ref.read_seq, -1)
    assert.deepEqual(value.nodes, []); assert.deepEqual(value.spans, [])
    assert.equal(value.window.locator, null); assert.equal(value.metering.surface_tokens, 0)
    assert.equal(value.context_summary.share_of_capacity, null)
    f.ctx.tokenMeter.measure = () => { throw new Error('none must not measure') }
    assert.equal((await getContextMap(f.ctx, f.exec, { metering: 'none' }, options)).metering.available, false)
  } finally { await f.close() }
})

test('attachment previews stay structural and recorded summary uses its own projected numerator', async () => {
  const f = await fixture()
  try {
    f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'image', attachment: { attachmentId: 'map-image', mediaType: 'image/png', bytes: 50, width: 8, height: 8 } },
      { type: 'file', attachment: { attachmentId: 'map-file', name: 'notes.txt', bytes: 40 } },
    ] }), { surfaceOp: 'append' })
    const reader = { id: f.session.id, surface: f.session.surface, deriveEventMessage: f.session.deriveEventMessage.bind(f.session),
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 200 }) }
    const observation = { ...f.observation(), projections: { asOfSeq: 0, values: {
      contextPressure: { pressureTokens: 80, projectedTokens: 100, contextWindow: 900 },
      contextBreakdown: { systemTokens: 5, toolsTokens: 7, messageTokens: 11 },
    } } }
    const meter = f.ctx.tokenMeter.measure(f.session)
    const value = buildContextMap(reader, observation, meter, {}, options)
    assert.equal(value.nodes[0].preview, '[image]\n[file]')
    assert.equal(value.nodes[0].estimated_tokens, meter.nodes[0].tokens)
    assert.equal(value.context_summary.pressure_tokens, 100)
    assert.equal(value.context_summary.capacity, 200)
    assert.equal(value.context_summary.share_of_capacity, .5)
    assert.equal(value.context_summary.pressure.contextWindow, 900)
    assert.deepEqual(value.context_summary.breakdown, { systemTokens: 5, toolsTokens: 7, messageTokens: 11 })
    delete observation.projections.values.contextPressure.projectedTokens
    assert.equal(buildContextMap(reader, observation, meter, {}, options).context_summary.pressure_tokens, 80)
    reader.requestContext = () => ({ provider: 'other', model: 'm', contextWindow: 200 })
    const mismatch = buildContextMap(reader, observation, meter, {}, options)
    assert.equal(mismatch.context_summary.share_of_capacity, null)
    assert.match(mismatch.context_summary.reason, /do not match/)
  } finally { await f.close() }
})
