import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionSeq, type SessionId, type SessionEventType } from '@deepseek-ai/dsh-session'
import type { SessionRecord, SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import { integer, bounded, trim, record, caller, authorize, hiddenDescendant, fitsOrThrow, type JsonValue } from './shared.js'
import { output, scopeParam, targetParam, limitParam, call } from './definitions.js'

/** Build exact-read and trace tool definitions against public services. */
export function readTools(ctx: Context, options: {
  previewChars: number
  outputBytes: number
  eventReadCacheEntries: number
  eventReadCacheBytes: number
  titles: (records: readonly SessionRecord[], exec: ToolRunContext, access: ReturnType<typeof caller>) => Promise<Map<string, { title: string; cached?: true }>>
  size: (limit?: number) => number
  target: (id: string, exec: ToolRunContext, access: ReturnType<typeof caller>) => Promise<SessionId>
}) {
  const { previewChars, outputBytes, size, target } = options
  const tools: Array<Parameters<typeof ctx.tools.register>[0]> = []
  type Prepared = { session: Awaited<ReturnType<typeof ctx.sessionQuery.readEvent>>['session']; points: string[]; bytes: number }
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
    tools.push(defineTool({ name: 'session_event_list', description: 'List every raw event including structural events, in ascending seq order; empty EOF page is normal.', parameters: { ...targetParam, scope: scopeParam, ...limitParam, after_seq: { type: 'integer', description: 'Last seen seq; omit to start at zero.' }, event_types: { type: 'array', items: { type: 'string' }, description: 'Explicit event type filter.' }, view: { type: 'string', enum: ['compact', 'metadata'], description: 'Default compact.' } }, output, presentCall: call('List events'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const afterSeq = args.after_seq === undefined ? undefined : SessionSeq(integer(args.after_seq, 'after_seq', 0, Number.MAX_SAFE_INTEGER))
      exec.signal.throwIfAborted()
      const page = await ctx.sessionQuery.pageEvents({ sessionId, ...(afterSeq === undefined ? {} : { afterSeq }), ...(args.event_types === undefined ? {} : { types: args.event_types as SessionEventType[] }), limit: size(args.limit), includeText: args.view !== 'metadata' && previewChars > 0 }, exec.signal)
      exec.signal.throwIfAborted()
      authorize(page.session, access)
      const items: JsonValue[] = page.items.map(item => ({ seq: item.seq, type: item.type, ...(args.view === 'metadata' || item.text === undefined ? {} : trim(item.text, previewChars)) }))
      const result = { session_id: sessionId, items, has_more: page.nextAfterSeq !== undefined, next_after_seq: page.nextAfterSeq ?? null }
      if (!bounded(result, outputBytes)) {
        for (let i = 0; i < items.length; i++) {
          const item = page.items[i]!
          if (args.view !== 'metadata' && item.text !== undefined) items[i] = { seq: item.seq, type: item.type, preview_omitted: true, text_truncated: true }
        }
      }
      if (!bounded(result, outputBytes)) throw new Error('Event list page exceeds outputBytes; lower limit and retry from the same after_seq, or increase configured outputBytes; no partial result was returned')
      return result
    } }))
    tools.push(defineTool({ name: 'session_event_read', description: 'Read small raw events directly; large events return readable JSON fragments continued by Unicode code-point offset_chars.', parameters: { ...targetParam, scope: scopeParam, seq: { type: 'integer', required: true }, offset_chars: { type: 'integer', description: 'Unicode code-point offset into serialized JSON, default zero.' } }, output, presentCall: call('Read event'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const seq = integer(args.seq, 'seq', 0, Number.MAX_SAFE_INTEGER)
      const offset = integer(args.offset_chars, 'offset_chars', 0, Number.MAX_SAFE_INTEGER)
      const key = JSON.stringify([sessionId, seq])
      // Continuations use the prepared raw-seq snapshot; restarting refreshes it.
      let value = offset > 0 ? prepared.get(key) : undefined
      if (!value) {
        remove(key)
        const window = await ctx.sessionQuery.readEvent({ sessionId, seq: SessionSeq(seq) }, exec.signal)
        exec.signal.throwIfAborted()
        authorize(window.session, access)
        const json = JSON.stringify(window.target)
        const raw = { session_id: sessionId, seq, format: 'event-json', event: JSON.parse(json) as JsonValue, has_more: false, next_offset: null }
        if (args.offset_chars === undefined && bounded(raw, outputBytes)) return raw
        const points = Array.from(json)
        // Account for serialized text, point strings and array slots conservatively.
        value = { session: window.session, points, bytes: Buffer.byteLength(json) + json.length * 2 + points.length * 32 }
        retain(key, value)
      } else {
        prepared.delete(key); prepared.set(key, value)
      }
      authorize(value.session, access)
      exec.signal.throwIfAborted()
      const { points } = value
      if (offset > points.length) throw new RangeError('offset_chars exceeds JSON Unicode code point length')
      const base = { session_id: sessionId, seq, format: 'json-unicode-code-points', offset_chars: offset, total_chars: points.length }
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
