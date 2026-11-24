import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionSeq, SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord, SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import { integer, bounded, record, caller, authorize, hiddenDescendant, fitsOrThrow, type JsonValue } from './shared.js'
import { output, eventListOutput, scopeParam, targetParam, limitParam, call } from './definitions.js'
import { BoundedReader, commitReadingPage, type ReaderBudget } from './bounded-reader.js'
import { associateEvents, type AssociatedActivity } from './event-association.js'
import { projectTarget, projectActivity, type EventProjection, type ProjectionBudget } from './event-projection.js'

/** Build exact-read and trace tool definitions against public services. */
export function readTools(ctx: Context, options: {
  outputBytes: number
  readTimeoutMs: number
  readerBudget: ReaderBudget
  projectionBudget: ProjectionBudget
  eventReadCacheEntries: number
  eventReadCacheBytes: number
  titles: (records: readonly SessionRecord[], exec: ToolRunContext, access: ReturnType<typeof caller>) => Promise<Map<string, { title: string; cached?: true }>>
  pageSize: number
  maxPageSize: number
  target: (id: string, exec: ToolRunContext, access: ReturnType<typeof caller>) => Promise<SessionId>
}) {
  const { outputBytes, pageSize, maxPageSize, target } = options
  const eventLimitParam = limitParam(pageSize, maxPageSize, 'Larger positive safe integers are capped and reported in notices.')
  const tools: Array<Parameters<typeof ctx.tools.register>[0]> = []
  type Prepared = { session: Awaited<ReturnType<typeof ctx.sessionQuery.observeSession>>['header']; capturedThroughSeq: number; points: string[]; bytes: number }
  const prepared = new Map<string, Prepared>()
  let cacheBytes = 0
  let disposed = false
  const remove = (key: string) => { const old = prepared.get(key); if (old) cacheBytes -= old.bytes; prepared.delete(key) }
  const retain = (key: string, value: Prepared) => {
    remove(key)
    if (disposed || options.eventReadCacheEntries === 0 || value.bytes > options.eventReadCacheBytes) return
    while (prepared.size >= options.eventReadCacheEntries || cacheBytes + value.bytes > options.eventReadCacheBytes) remove(prepared.keys().next().value!)
    prepared.set(key, value); cacheBytes += value.bytes
  }
  tools.push(defineTool({ name: 'session_event_list', description: 'Browse a fixed session cut. items contains activity projections in compact (default) or exact {seq, type} entries in metadata. limit counts original events, not activities. The byte budget can shorten the page; pass next_after_seq as after_seq to continue. Supplemental reads never advance that position, and an activity can recur across pages.', parameters: { ...targetParam, scope: scopeParam, ...eventLimitParam, after_seq: { type: 'integer', description: 'Last delivered original event seq; omit to start at zero.' }, event_types: { type: 'array', items: { type: 'string' }, description: 'Filter page anchors only; supplemental reads may use other types.' }, view: { type: 'string', enum: ['compact', 'metadata'], description: 'compact (default) shows activities; metadata shows exact seq and type.' } }, output: eventListOutput, timeoutMs: options.readTimeoutMs, presentCall: call('List events'), async execute(args, exec) {
    exec = { ...exec, signal: AbortSignal.any([exec.signal, AbortSignal.timeout(options.readTimeoutMs)]) }
    const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
    const after = args.after_seq === undefined ? -1 : integer(args.after_seq, 'after_seq', 0, Number.MAX_SAFE_INTEGER)
    const view = args.view ?? 'compact'
    const requested = args.limit ?? pageSize
    if (!Number.isSafeInteger(requested) || requested < 1) throw new RangeError('limit must be a positive safe integer')
    const effective = Math.min(requested, maxPageSize)
    const cap = requested > effective ? { requested_limit: requested, effective_limit: effective } : {}
    const capNotice = requested > effective ? [`Requested limit ${requested} exceeds the maximum ${maxPageSize}; read at most ${effective} events.`] : []
    exec.signal.throwIfAborted()
    const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal: exec.signal })
    try {
      authorize(observation.header, access)
      const reader = new BoundedReader(observation, options.readerBudget, exec.signal, options.projectionBudget)
      const page = await reader.page(after, effective, args.event_types, view === 'metadata')
      const anchors = page.selected.map(event => event.seq)
      if (view === 'compact') await reader.completeActivities(anchors)
      const model = view === 'compact' ? associateEvents([...reader.events.values()], options.projectionBudget) : undefined
      const overflow = 'Event list page exceeds outputBytes; use view:"metadata" to find the seq, then pass it to session_event_read (use view:"raw" for the original event).'
      // Builds the page for an anchor prefix; projections are recomputed because evidence depends on the prefix.
      const build = (count: number) => {
        exec.signal.throwIfAborted()
        const prefix = anchors.slice(0, count)
        let projections: EventProjection[] = []
        if (model) {
          const byActivity = new Map<AssociatedActivity, number[]>()
          for (const seq of prefix) {
            const activity = model.activityBySeq.get(seq)!
            const activityAnchors = byActivity.get(activity)
            if (activityAnchors) activityAnchors.push(seq)
            else byActivity.set(activity, [seq])
          }
          try {
            projections = model.activities.filter(activity => byActivity.has(activity)).map(activity => projectActivity(model, activity, {
              view: 'compact', budget: options.projectionBudget, evidence: reader.evidence(activity, byActivity.get(activity)!),
            }))
          } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('Projection metadata exceeds outputBytes;')) throw error
            return undefined
          }
        }
        const reduced = count < anchors.length
        const notices = [...capNotice]
        if (reduced) notices.push(`Page reduced to ${count} of ${anchors.length} events to fit outputBytes (${outputBytes} bytes); continue from next_after_seq.`)
        const result = {
          session_id: sessionId, captured_through_seq: reader.cut, view,
          items: model ? projections : page.selected.slice(0, count).map(({ seq, type }) => ({ seq, type })),
          has_more: reduced || page.hasMore, next_after_seq: reduced ? prefix.at(-1)! : page.nextAfterSeq,
          ...cap, ...(reduced ? { page_truncated: { reason: 'output_bytes', delivered: count, selected: anchors.length } } : {}),
          ...(notices.length ? { notices } : {}),
        }
        const json = JSON.stringify(result)
        return { result, projections, json, fits: Buffer.byteLength(json, 'utf8') <= outputBytes }
      }
      const full = build(anchors.length)
      if (full?.fits) return JSON.parse(full.json) as Record<string, JsonValue>
      // Page size grows with the prefix, so binary search finds the longest prefix that fits.
      let best: ReturnType<typeof build>
      for (let low = 1, high = anchors.length - 1; low <= high;) {
        const count = Math.floor((low + high) / 2)
        const candidate = build(count)
        if (candidate?.fits) { best = candidate; low = count + 1 } else high = count - 1
      }
      if (best) return JSON.parse(best.json) as Record<string, JsonValue>
      const single = anchors.length > 1 ? build(1) : full
      if (!single) throw new Error(overflow)
      return commitReadingPage(single.result, single.projections, outputBytes, overflow)
    } finally { observation[Symbol.dispose]() }
  } }))
  tools.push(defineTool({ name: 'session_event_read', description: 'Read Detail by default, scoped to the target event or its own tool pair; never expands parent, sibling or child calls. read_scope:activity explicitly expands bounded activity evidence. Compact changes density only. Explicit view:raw reads the exact requested seq, including replacements; only Raw accepts Unicode code-point offset_chars. No spill, attachment or child-session bodies are fetched.', parameters: { ...targetParam, scope: scopeParam, seq: { type: 'integer', required: true }, view: { type: 'string', enum: ['compact', 'detail', 'raw'], description: 'Default detail. Raw must be explicit.' }, read_scope: { type: 'string', enum: ['target', 'activity'], description: 'Default target. Raw rejects activity.' }, offset_chars: { type: 'integer', description: 'Raw only: Unicode code-point offset into serialized event JSON.' } }, output, timeoutMs: options.readTimeoutMs, presentCall: call('Read event'), async execute(args, exec) {
    exec = { ...exec, signal: AbortSignal.any([exec.signal, AbortSignal.timeout(options.readTimeoutMs)]) }
    const view = args.view ?? 'detail'
    const readScope = args.read_scope ?? 'target'
    if (args.offset_chars !== undefined && view !== 'raw') throw new Error('offset_chars is only available with explicit view:raw')
    if (view === 'raw' && readScope === 'activity') throw new Error('view:raw cannot be combined with read_scope:activity')
    const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
    const seq = integer(args.seq, 'seq', 0, Number.MAX_SAFE_INTEGER)
    if (view !== 'raw') {
      exec.signal.throwIfAborted()
      const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal: exec.signal })
      try {
        authorize(observation.header, access)
        const reader = new BoundedReader(observation, options.readerBudget, exec.signal, options.projectionBudget)
        const event = reader.target(seq)
        if (readScope === 'target') await reader.completeTarget(event)
        else await reader.completeActivities([seq])
        const model = associateEvents([...reader.events.values()], options.projectionBudget)
        const activity = model.activityBySeq.get(seq)!
        const projection = readScope === 'target'
          ? projectTarget(model, seq, { view, budget: options.projectionBudget, evidence: reader.targetEvidence(event) })
          : projectActivity(model, activity, { view, budget: options.projectionBudget, evidence: reader.evidence(activity, [seq]) })
        exec.signal.throwIfAborted()
        const result = { session_id: sessionId, captured_through_seq: reader.cut, ...projection, requested_seq: seq }
        return commitReadingPage(result, [result], outputBytes, 'Reading metadata exceeds outputBytes; narrow read_scope or use view:"raw".')
      } finally { observation[Symbol.dispose]() }
    }
    const offset = integer(args.offset_chars, 'offset_chars', 0, Number.MAX_SAFE_INTEGER)
    const key = JSON.stringify([sessionId, seq])
    // Continuations retain the exact raw-seq snapshot; restarting refreshes it.
    let value = offset > 0 ? prepared.get(key) : undefined
    if (!value) {
      remove(key)
      exec.signal.throwIfAborted()
      const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal: exec.signal })
      try {
        authorize(observation.header, access)
        exec.signal.throwIfAborted()
        const event = observation.readEvents(SessionLogOffset(seq), SessionLogOffset(seq + 1))[0]
        if (!event || event.seq !== seq) throw new RangeError('Requested seq is outside the captured observation')
        const json = JSON.stringify(event)
        const raw = { session_id: sessionId, seq, captured_through_seq: observation.cursor, format: 'event-json', event, has_more: false, next_offset: null }
        if (args.offset_chars === undefined && bounded(raw, outputBytes)) return { ...raw, event: JSON.parse(json) as JsonValue }
        const points = Array.from(json)
        value = { session: observation.header, capturedThroughSeq: observation.cursor, points, bytes: Buffer.byteLength(json) + json.length * 2 + points.length * 32 }
        exec.signal.throwIfAborted()
        retain(key, value)
      } finally { observation[Symbol.dispose]() }
    } else {
      prepared.delete(key); prepared.set(key, value)
    }
    authorize(value.session, access)
    exec.signal.throwIfAborted()
    const { points } = value
    if (offset > points.length) throw new RangeError('offset_chars exceeds JSON Unicode code point length')
    const base = { session_id: sessionId, seq, captured_through_seq: value.capturedThroughSeq, format: 'json-unicode-code-points', offset_chars: offset, total_chars: points.length }
    let low = 0, high = Math.min(points.length - offset, outputBytes)
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const probe = { ...base, json_fragment: points.slice(offset, offset + mid).join(''), has_more: offset + mid < points.length, next_offset: offset + mid < points.length ? offset + mid : null }
      if (bounded(probe, outputBytes)) low = mid
      else high = mid - 1
    }
    if (offset < points.length && !low) throw new Error('outputBytes cannot fit one JSON fragment')
    return fitsOrThrow({ ...base, json_fragment: points.slice(offset, offset + low).join(''), has_more: offset + low < points.length, next_offset: offset + low < points.length ? offset + low : null }, outputBytes)
  } }))
    tools.push(defineTool({ name: 'session_trace', description: 'Trace complete visible ancestry and descendants; project hides relations outside exact cwd, all reveals current provider.', parameters: { ...targetParam, scope: scopeParam }, output, presentCall: call('Trace session'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const trace = await ctx.sessionQuery.traceSession(sessionId, exec.signal)
      exec.signal.throwIfAborted()
      authorize(trace.target.header, access)
      const ancestors: SessionRecord[] = []
      for (const item of trace.ancestors) { if (access.project && item.header.cwd !== access.cwd) break; ancestors.push(item) }
      const visible: SessionRecord[] = [trace.target, ...ancestors]
      const collect = (nodes: readonly SessionLineageNode[]): SessionLineageNode[] => nodes.flatMap(node => {
        if (access.project && node.session.header.cwd !== access.cwd) return []
        visible.push(node.session)
        return [{ session: node.session, descendants: collect(node.descendants) }]
      })
      const nodes = collect(trace.descendants)
      if (!access.project && trace.complete) visible.push(trace.root)
      const names = await options.titles(visible, exec, access)
      const summary = (item: SessionRecord) => record(item, names.get(item.header.id)?.title, !access.project, names.get(item.header.id)?.cached)
      const render = (node: SessionLineageNode): JsonValue => ({ session: summary(node.session), descendants: node.descendants.map(render) })
      const descendants = nodes.map(render)
      const scope_limited = access.project && (ancestors.length !== trace.ancestors.length || hiddenDescendant(trace.descendants, access.cwd!))
      return fitsOrThrow({ target: summary(trace.target), ancestors: ancestors.map(summary), descendants, scope_limited, complete: trace.complete && !scope_limited, ...(access.project ? {} : trace.complete ? { root: summary(trace.root) } : { unresolvedParentId: trace.unresolvedParentId }) }, outputBytes)
    } }))
    tools.push(defineTool({ name: 'session_event_trace', description: 'Trace direct event replacement and citation relationships without omitting links.', parameters: { ...targetParam, scope: scopeParam, seq: { type: 'integer', required: true } }, output, presentCall: call('Trace event'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const seq = integer(args.seq, 'seq', 0, Number.MAX_SAFE_INTEGER)
      const trace = await ctx.sessionQuery.traceEvent({ sessionId, seq: SessionSeq(seq) }, exec.signal)
      exec.signal.throwIfAborted()
      authorize(trace.session, access)
      return fitsOrThrow({ session_id: sessionId, target: { ...trace.target }, replacedBy: trace.replacedBy ?? null, replacementChain: trace.replacementChain, replacedEventSeqs: trace.replacedEventSeqs, sourceEventSeqs: trace.sourceEventSeqs, derivedEventSeqs: trace.derivedEventSeqs }, outputBytes)
    } }))
  return { tools, dispose() { disposed = true; prepared.clear(); cacheBytes = 0 } }
}
