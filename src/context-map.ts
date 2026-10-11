import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionCaptureReader, SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { authorize, caller, fitsOrThrow, integer, trim } from './shared.js'
import { resolveSurfaceAnchor } from './context-map-anchors.js'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { sampleMeter } from './context-map-adapter.js'
import type { ContextMapInput, ContextMapOptions, ContextMapOutput, ContextMapNavigation, ContextMapSpan, SurfaceLocator } from './context-map-types.js'

export type * from './context-map-types.js'
export { resolveSurfaceAnchor, resolveSurfaceRange } from './context-map-anchors.js'

type CapturedMessage = ReturnType<SessionCaptureReader['deriveEventMessage']>

function previewMessage(message: CapturedMessage, chars: number): { preview: string; text_truncated: boolean } {
  if (message === null) return { preview: '', text_truncated: false }
  let text = ''
  for (const block of message.content) {
    let value: string
    switch (block.type) {
      case 'text': case 'reasoning': value = block.text; break
      case 'tool-call': value = `[tool ${block.name}] ${block.arguments}`; break
      case 'tool-addition': case 'tool-removal': value = `[${block.type} ${block.toolName}]`; break
      default: value = `[${block.type}]`
    }
    text += (text ? '\n' : '') + trim(value, chars + 1).preview
    if (Array.from(text).length > chars) return trim(text, chars)
  }
  return trim(text, chars)
}

function navigation(observation: Pick<SessionObservation, 'cursor' | 'readEvents'>, wanted: ReadonlySet<number>): Map<number, ContextMapNavigation> {
  const found = new Map<number, ContextMapNavigation>()
  let current: ContextMapNavigation = { turn: null, step: null, turn_start_seq: null, step_start_seq: null }
  for (let from = 0; from <= observation.cursor; from += 128) {
    for (const event of observation.readEvents(SessionLogOffset(from), SessionLogOffset(Math.min(from + 128, observation.cursor + 1)))) {
      if (event.type === 'turn/start') current = { turn: event.data.turn, step: null, turn_start_seq: event.seq, step_start_seq: null }
      if (event.type === 'step/start') current = { ...current, turn: event.data.turn, step: event.data.step, step_start_seq: event.seq }
      if (wanted.has(event.seq)) found.set(event.seq, { ...current })
      if (event.type === 'step/end') current = { ...current, step: null, step_start_seq: null }
      if (event.type === 'turn/end') current = { turn: null, step: null, turn_start_seq: null, step_start_seq: null }
    }
  }
  return found
}

function locator(seqs: readonly number[], start: number, end: number): SurfaceLocator {
  const first = seqs[start], last = seqs[end - 1]
  if (first === undefined || last === undefined) throw new Error('Context map interval is outside the current Surface')
  return { start: { seq: first, edge: 'before' }, end: { seq: last, edge: 'after' } }
}

/** Build a detached map from one synchronous borrowed sample, without services or I/O.
 * @param reader - Current Session reading view, also structurally satisfied by Session.
 * @param observation - Same-sample source cut, event access and all-mode summary projections.
 * @param measurement - Optional meter result from this exact Session; index and seq must align.
 * @param input - Validated display selection.
 * @param options - Display budgets shared with the tool.
 * @returns Detached bounded current map; does not authorize or retain a sample.
 */
export function buildContextMap(reader: SessionCaptureReader, observation: Pick<SessionObservation, 'cursor' | 'source' | 'readEvents' | 'projections'>, measurement: TokenMeasurement | undefined, input: ContextMapInput, options: ContextMapOptions): ContextMapOutput {
  const limit = integer(input.limit, 'limit', options.mapPageSize, options.mapMaxPageSize)
  if (!limit) throw new RangeError('limit must be positive')
  const seqs = [...reader.surface.nodes]
  const mode = input.metering ?? 'auto'
  if (mode === 'none') measurement = undefined
  if (mode === 'require' && !measurement) throw new Error('Context map requires tokenMeter measurement')
  const snapshot = observation.projections
  const pressure = snapshot?.values.contextPressure
  const pressureTokens = pressure?.projectedTokens ?? pressure?.pressureTokens ?? null
  if (measurement && (measurement.nodes.length !== seqs.length || measurement.nodes.some((node, i) => node.seq !== seqs[i]))) throw new Error('Context map token-meter Surface index/seq alignment failed')
  const view = input.view ?? 'overview'
  let start = Math.max(0, seqs.length - limit)
  if (input.window) {
    const boundary = resolveSurfaceAnchor(seqs, input.window.anchor)
    start = input.window.side === 'before' ? Math.max(0, boundary - limit) : input.window.side === 'after' ? boundary : Math.max(0, boundary - Math.floor(limit / 2))
  }
  const end = Math.min(seqs.length, start + limit)
  // Before windows must end at the selected boundary, including short head windows.
  const windowEnd = input.window?.side === 'before' ? resolveSurfaceAnchor(seqs, input.window.anchor) : end
  const selected = seqs.slice(start, windowEnd)
  const nav = navigation(observation, new Set(selected))
  const sum = (a: number, b: number): number | null => measurement ? measurement.nodes.slice(a, b).reduce((n, node) => n + node.tokens, 0) : null
  const share = (tokens: number | null): number | null => tokens !== null && measurement && measurement.surfaceTokens > 0 ? tokens / measurement.surfaceTokens : null
  const nodes = selected.map((seq, i) => {
    const event: SessionEvent | undefined = observation.readEvents(SessionLogOffset(seq), SessionLogOffset(seq + 1))[0]
    if (!event) throw new Error(`Context map Surface event ${seq} is outside the captured source cut`)
    const message = reader.deriveEventMessage(event)
    const declared = event.type === 'user/message' ? event.data
      : event.type === 'system/message' || event.type === 'developer/message' || event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.message : null
    // Dormant nodes omit a model message but retain the producer's declared identity.
    const identity = message ?? declared
    const preview = previewMessage(message, options.previewChars)
    const tokens = measurement?.nodes[start + i]?.tokens ?? null
    return { surface_index: start + i, seq, read_seq: seq, event_type: event.type,
      role: identity?.role ?? 'unknown', source: identity?.source.kind ?? 'unknown',
      form: identity && 'form' in identity.source && typeof identity.source.form === 'string' ? identity.source.form : 'unknown',
      preview: preview.preview, preview_basis: 'session-message' as const, preview_truncated: preview.text_truncated,
      locator: locator(seqs, start + i, start + i + 1),
      navigation: nav.get(seq) ?? { turn: null, step: null, turn_start_seq: null, step_start_seq: null },
      estimated_tokens: tokens, share_of_surface: share(tokens) }
  })
  const spans: ContextMapSpan[] = []
  if (view === 'overview') {
    const count = Math.min(options.mapMaxSpans, seqs.length)
    for (let i = 0; i < count; i++) {
      const a = Math.floor(i * seqs.length / count), b = Math.floor((i + 1) * seqs.length / count)
      const tokens = sum(a, b)
      spans.push({ ...locator(seqs, a, b), start_index: a, end_index: b, node_count: b - a, estimated_tokens: tokens, share_of_surface: share(tokens) })
    }
  }
  const header = reader.requestHeader(), context = reader.requestContext()
  const routeMatches = !!header && !!context && header.config.provider === context.provider && header.config.model === context.model
  const contextWindow = context?.contextWindow
  const capacity = routeMatches && contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null
  const capacityReason = capacity === null ? 'Current request route and positive context capacity are unavailable or do not match' : null
  return fitsOrThrow({ snapshot_ref: { session_id: reader.id, read_seq: observation.cursor, map_id: randomUUID() },
    source: { kind: observation.source, replace_generation: reader.surface.replaceGeneration, content_generation: reader.surface.contentGeneration }, view,
    window: { start_index: start, end_index: windowEnd, returned: nodes.length, total: seqs.length, locator: nodes.length ? locator(seqs, start, windowEnd) : null }, nodes, spans,
    metering: { available: !!measurement, basis: measurement ? 'token-meter/raw-event-fold' : null,
      reason: measurement ? null : mode === 'none' ? 'Metering disabled by request' : 'tokenMeter service is unavailable',
      log_revision: measurement?.logRevision ?? null, surface_tokens: measurement?.surfaceTokens ?? null, total_tokens: measurement?.totalTokens ?? null,
      baseline: measurement ? { kind: measurement.baseline.kind, tokens: measurement.baseline.tokens } : null,
      capacity, share_of_capacity: capacity !== null && measurement ? measurement.totalTokens / capacity : null, capacity_reason: capacityReason },
    context_summary: structuredClone({ basis: 'recorded-context-projections' as const, as_of_seq: snapshot?.asOfSeq ?? null,
      pressure: pressure ?? null, breakdown: snapshot?.values.contextBreakdown ?? null,
      pressure_tokens: pressureTokens, capacity, share_of_capacity: pressureTokens !== null && capacity !== null ? pressureTokens / capacity : null,
      reason: pressureTokens === null ? 'Recorded pressure baseline is unavailable' : capacityReason }) }, options.outputBytes)
}

/** Authorize the exact caller project, then synchronously sample current Surface and meter.
 * @param ctx - Query and projection services, with an optional tokenMeter.
 * @param exec - Agent-bound caller identity and cancellation.
 * @param input - Current-map window and display request; no old sample or cursor.
 * @param options - Validated plugin display budgets.
 * @returns Detached bounded JSON; anchors replaced since an earlier call fail explicitly.
 */
export async function getContextMap(ctx: Context, exec: ToolRunContext, input: ContextMapInput, options: ContextMapOptions): Promise<ContextMapOutput> {
  const access = caller(exec, input.scope)
  if (input.view !== undefined && !['overview', 'messages'].includes(input.view)) throw new Error('view must be overview or messages')
  if (input.metering !== undefined && !['auto', 'none', 'require'].includes(input.metering)) throw new Error('metering must be auto, none or require')
  if (input.window && !['before', 'after', 'around'].includes(input.window.side)) throw new Error('window.side must be before, after or around')
  const limit = integer(input.limit, 'limit', options.mapPageSize, options.mapMaxPageSize)
  if (!limit) throw new RangeError('limit must be positive')
  const text = input.session_id ?? access.id
  if (!text.trim()) throw new Error('session_id must not be empty')
  const id = SessionId(text)
  exec.signal.throwIfAborted()
  const records = await ctx.sessionQuery.filterSessions([{ kind: 'id', values: [id] }], exec.signal)
  exec.signal.throwIfAborted()
  const record = records.find(item => item.header.id === id)
  if (!record) throw new Error(`Session ${id} not found`)
  authorize(record.header, access)
  const result = await ctx.sessionQuery.captureSession(id, (reader, observation) => {
    authorize(reader.header, access)
    exec.signal.throwIfAborted()
    return buildContextMap(reader, observation, sampleMeter(ctx, reader, input.metering ?? 'auto'), input, options)
  }, { signal: exec.signal, projectionMode: 'all' })
  exec.signal.throwIfAborted()
  return result
}
