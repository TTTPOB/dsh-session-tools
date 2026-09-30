import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { integer, bounded, trim, record, caller, authorize, safeTrace, hiddenDescendant, fitsOrThrow, type JsonValue } from './shared.js'
import { output, scopeParam, targetParam, limitParam, call } from './definitions.js'

/** Build exact-read and trace tool definitions against public services. */
export function readTools(ctx: Context, options: {
  previewChars: number
  outputBytes: number
  size: (limit?: number) => number
  target: (id: string, exec: ToolRunContext, access: ReturnType<typeof caller>) => Promise<SessionId>
}) {
  const { previewChars, outputBytes, size, target } = options
  const tools: Array<Parameters<typeof ctx.tools.register>[0]> = []
    tools.push(defineTool({ name: 'session_event_list', description: 'List every raw event including structural events, in ascending seq order; empty EOF page is normal.', parameters: { ...targetParam, scope: scopeParam, ...limitParam, after_seq: { type: 'integer', description: 'Last seen seq; omit to start at zero.' }, event_types: { type: 'array', items: { type: 'string' }, description: 'Explicit event type filter.' }, view: { type: 'string', enum: ['compact', 'metadata'], description: 'Default compact.' } }, output, presentCall: call('List events'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const records = await ctx.sessionQuery.listEvents(sessionId)
      exec.signal.throwIfAborted()
      const start = args.after_seq === undefined ? 0 : integer(args.after_seq, 'after_seq', 0, Number.MAX_SAFE_INTEGER) + 1
      const types = args.event_types === undefined ? undefined : new Set(args.event_types)
      const items: JsonValue[] = []
      let pos = records.findIndex(item => item.seq >= start)
      if (pos < 0) pos = records.length
      const selected = size(args.limit)
      const eligible = records.slice(pos).filter(item => !types || types.has(item.type)).slice(0, selected)
      let preview = new Map<number, string>()
      if (args.view !== 'metadata' && eligible.length && previewChars > 0) {
        const docs = await ctx.sessionQuery.filterEvents(sessionId, [{ kind: 'seq', from: eligible[0]!.seq, to: eligible.at(-1)!.seq }])
        preview = new Map(docs.map(doc => [doc.seq, doc.text]))
      }
      let lastSeq = args.after_seq ?? null
      for (; pos < records.length && items.length < selected; pos++) {
        const item = records[pos]!
        if (types && !types.has(item.type)) { lastSeq = item.seq; continue }
        const text = preview.get(item.seq)
        let entry: JsonValue = args.view === 'metadata' ? { seq: item.seq, type: item.type } : {
          seq: item.seq, type: item.type,
          ...(text === undefined ? {} : trim(text, previewChars)),
        }
        let result = { session_id: sessionId, items: [...items, entry], has_more: pos + 1 < records.length, next_after_seq: item.seq }
        if (!bounded(result, outputBytes) && text !== undefined) {
          entry = { seq: item.seq, type: item.type, preview_omitted: true, text_truncated: true }
          result = { session_id: sessionId, items: [...items, entry], has_more: pos + 1 < records.length, next_after_seq: item.seq }
        }
        if (!bounded(result, outputBytes)) {
          if (!items.length) throw new Error('outputBytes cannot fit one event record')
          break
        }
        items.push(entry); lastSeq = item.seq
      }
      return fitsOrThrow({ session_id: sessionId, items, has_more: pos < records.length, next_after_seq: pos < records.length ? lastSeq : null }, outputBytes)
    } }))
    tools.push(defineTool({ name: 'session_event_read', description: 'Read small raw events directly; large events return readable JSON fragments continued by Unicode code-point offset_chars.', parameters: { ...targetParam, scope: scopeParam, seq: { type: 'integer', required: true }, offset_chars: { type: 'integer', description: 'Unicode code-point offset into serialized JSON, default zero.' } }, output, presentCall: call('Read event'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const seq = integer(args.seq, 'seq', 0, Number.MAX_SAFE_INTEGER)
      const window = await ctx.sessionQuery.readEvent({ sessionId, seq: SessionSeq(seq) }, exec.signal)
      exec.signal.throwIfAborted()
      authorize(window.session, access)
      const json = JSON.stringify(window.target)
      const raw = { session_id: sessionId, seq, format: 'event-json', event: JSON.parse(JSON.stringify(window.target)) as JsonValue, has_more: false, next_offset: null }
      if (bounded(raw, outputBytes) && args.offset_chars === undefined) return raw
      const points = Array.from(json)
      const offset = integer(args.offset_chars, 'offset_chars', 0, Number.MAX_SAFE_INTEGER)
      if (offset > points.length) throw new RangeError('offset_chars exceeds JSON Unicode code point length')
      const base = { session_id: sessionId, seq, format: 'json-unicode-code-points', offset_chars: offset, total_chars: points.length }
      let low = 0, high = points.length - offset
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        const probe = { ...base, json_fragment: points.slice(offset, offset + mid).join(''), has_more: offset + mid < points.length, next_offset: offset + mid < points.length ? offset + mid : null }
        if (bounded(probe, outputBytes)) low = mid
        else high = mid - 1
      }
      if (offset < points.length && !low) throw new Error('outputBytes cannot fit one JSON fragment')
      return { ...base, json_fragment: points.slice(offset, offset + low).join(''), has_more: offset + low < points.length, next_offset: offset + low < points.length ? offset + low : null }
    } }))
    tools.push(defineTool({ name: 'session_trace', description: 'Trace complete visible ancestry and descendants; project hides relations outside exact cwd, all reveals current provider.', parameters: { ...targetParam, scope: scopeParam }, output, presentCall: call('Trace session'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const trace = await ctx.sessionQuery.traceSession(sessionId, exec.signal)
      exec.signal.throwIfAborted()
      authorize(trace.target.header, access)
      const ancestors: SessionRecord[] = []
      for (const item of trace.ancestors) { if (access.project && item.header.cwd !== access.cwd) break; ancestors.push(item) }
      const descendants = trace.descendants.map(node => safeTrace(node, access)).filter(node => node !== null)
      const scope_limited = access.project && (ancestors.length !== trace.ancestors.length || hiddenDescendant(trace.descendants, access.cwd!))
      return fitsOrThrow({ target: record(trace.target, undefined, !access.project), ancestors: ancestors.map(item => record(item, undefined, !access.project)), descendants, scope_limited, complete: trace.complete && !scope_limited, ...(access.project ? {} : trace.complete ? { root: record(trace.root, undefined, true) } : { unresolvedParentId: trace.unresolvedParentId }) }, outputBytes)
    } }))
    tools.push(defineTool({ name: 'session_event_trace', description: 'Trace direct event replacement and citation relationships without omitting links.', parameters: { ...targetParam, scope: scopeParam, seq: { type: 'integer', required: true } }, output, presentCall: call('Trace event'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const seq = integer(args.seq, 'seq', 0, Number.MAX_SAFE_INTEGER)
      const trace = await ctx.sessionQuery.traceEvent({ sessionId, seq: SessionSeq(seq) }, exec.signal)
      exec.signal.throwIfAborted()
      authorize(trace.session, access)
      return fitsOrThrow({ session_id: sessionId, target: { ...trace.target }, replacedBy: trace.replacedBy ?? null, replacementChain: trace.replacementChain, replacedEventSeqs: trace.replacedEventSeqs, sourceEventSeqs: trace.sourceEventSeqs, derivedEventSeqs: trace.derivedEventSeqs }, outputBytes)
    } }))
  return tools
}
