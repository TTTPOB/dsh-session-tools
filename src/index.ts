type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionRecord, SessionLineageNode, SessionSearchCursor } from '@deepseek-ai/dsh-session-query'

export const name = 'dsh-session-tools'
export const inject = ['tools', 'sessionQuery']
export interface Config { pageSize: number; maxPageSize: number; previewChars: number; outputBytes: number }
export const Config: Schema<Config> = Schema.object({
  pageSize: Schema.number().step(1).min(1).max(100).default(30),
  maxPageSize: Schema.number().step(1).min(1).max(100).default(100),
  previewChars: Schema.number().step(1).min(0).max(4000).default(240),
  outputBytes: Schema.number().step(1).min(1024).max(1048576).default(24576),
})
const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}
const scopeParam = { type: 'string' as const, enum: ['project', 'all'] as const, description: 'project (default): exact caller session cwd; all: current provider DSH_HOME only.' }
const targetParam = { session_id: { type: 'string' as const, required: true as const, description: 'Exact session ID.' } }
const limitParam = { limit: { type: 'integer' as const, description: 'Page size; defaults to configured pageSize.' } }
const call = (verb: string) => (args: {session_id?: string; seq?: number; scope?: string}) => ({
  card: 'generic' as const, kind: 'read' as const, title: `${verb}${args.session_id ? ` ${args.session_id}` : ''}${args.seq === undefined ? '' : ` #${args.seq}`}`,
})
function integer(value: number | undefined, name: string, fallback: number, max: number): number {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new RangeError(`${name} must be an integer between 0 and ${max}`)
  return n
}
function bounded(value: object, bytes: number): boolean { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes }
function trim(text: string, chars: number): string { return text.length > chars ? `${text.slice(0, chars)}…` : text }
function record(record: SessionRecord) { return { sessionId: record.header.id, cwd: record.header.cwd ?? null, createdAt: record.header.createdAt, live: record.live, persisted: record.persisted } }
function caller(exec: ToolRunContext, scope: string | undefined): { cwd?: string; id: string; project: boolean } {
  if (!exec.agent) throw new Error('An agent-bound session is required')
  if (scope !== undefined && scope !== 'project' && scope !== 'all') throw new Error('scope must be project or all')
  const cwd = exec.agent.session.header.cwd
  if (scope !== 'all' && cwd === undefined) throw new Error('project scope requires caller session header.cwd; use scope all explicitly')
  return { cwd, id: exec.agent.session.id, project: scope !== 'all' }
}
function authorize(header: SessionHeader, access: ReturnType<typeof caller>): void {
  if (access.project && header.cwd !== access.cwd) throw new Error('Session is outside the caller project')
}
function safeTrace(node: SessionLineageNode, access: ReturnType<typeof caller>): JsonValue | null {
  if (access.project && node.session.header.cwd !== access.cwd) return null
  return { session: record(node.session), descendants: node.descendants.map(child => safeTrace(child, access)).filter(child => child !== null) }
}
function fitsOrThrow<T extends object>(value: T, budget: number): T {
  if (!bounded(value, budget)) throw new Error('Trace exceeds outputBytes; narrow the target or increase configured outputBytes; no relationships were omitted')
  return value
}
function searchError(error: unknown): never {
  if (error instanceof Error) {
    // Preserve the provider's error identity and code while adding actionable guidance.
    error.message += ' (Indexed search failed; no logs were scanned. Report this to the user; do not scan logs as a workaround. FTS matches tokens, not arbitrary substrings.)'
  }
  throw error
}
/** Register seven reversible, native-object session query tools. */
export function apply(ctx: Context, config: Config): void {
  const { pageSize, maxPageSize, previewChars, outputBytes } = config
  if (pageSize > maxPageSize) throw new RangeError('pageSize cannot exceed maxPageSize')
  const size = (n?: number) => { const value = integer(n, 'limit', pageSize, maxPageSize); if (!value) throw new RangeError('limit must be positive'); return value }
  const id = (text: string) => { if (!text.trim()) throw new Error('session_id is required'); return SessionId(text) }
  const target = async (text: string, exec: ToolRunContext, access: ReturnType<typeof caller>) => {
    const sessionId = id(text)
    const records = await ctx.sessionQuery.filterSessions([{ kind: 'id', values: [sessionId] }], exec.signal)
    const match = records.find(item => item.header.id === sessionId)
    if (!match) throw new Error(`Session ${sessionId} not found`)
    authorize(match.header, access)
    return sessionId
  }
  // Effect owns all registrations, including rollback if a later registration fails.
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const add = (definition: Parameters<typeof ctx.tools.register>[0]) => disposers.push(ctx.tools.register(definition))
    add(defineTool({ name: 'session_list', description: 'List session metadata. project uses exact caller cwd; all uses the current provider only.', parameters: { scope: scopeParam, ...limitParam, offset: { type: 'integer', description: 'Number of sessions to skip (default 0).' } }, output, presentCall: call('List sessions'), async execute(args, exec) {
      const access = caller(exec, args.scope)
      const records = await ctx.sessionQuery.listSessions(exec.signal)
      exec.signal.throwIfAborted()
      const visible = records.filter(item => !access.project || item.header.cwd === access.cwd)
      const start = integer(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER)
      const items: ReturnType<typeof record>[] = []
      const requested = size(args.limit)
      let pos = start
      while (pos < visible.length && items.length < requested) {
        const next = record(visible[pos]!)
        const candidate = { items: [...items, next], nextOffset: pos + 1 < visible.length ? pos + 1 : null, scope: args.scope ?? 'project' }
        if (!bounded(candidate, outputBytes)) break
        items.push(next); pos++
      }
      if (!items.length && pos < visible.length) throw new Error('outputBytes cannot fit one session record')
      return { items, nextOffset: pos < visible.length ? pos : null, scope: args.scope ?? 'project' }
    } }))
    add(defineTool({ name: 'session_search', description: 'Indexed FTS token search across sessions; not arbitrary substring matching. Never scans logs. Excludes caller session by default.', parameters: { query: { type: 'string', required: true }, scope: scopeParam, ...limitParam, cursor: { type: 'string', description: 'Opaque continuation cursor.' }, include_current: { type: 'boolean', description: 'Include current session (default false).' } }, output, presentCall: call('Search sessions'), async execute(args, exec) {
      const access = caller(exec, args.scope)
      const query = args.query.trim(); if (!query) throw new Error('query must not be empty')
      const items: JsonValue[] = []
      let cursor = args.cursor as SessionSearchCursor | undefined
      const seen = new Set<string>()
      while (items.length < size(args.limit)) {
        exec.signal.throwIfAborted()
        let page
        try { page = await ctx.sessionQuery.searchSessions({ query, limit: 1, sessionFilters: access.project ? [{ kind: 'cwd', values: [access.cwd!] }] : [], ...(cursor ? { cursor } : {}) }, { signal: exec.signal }) }
        catch (error) { searchError(error) }
        const hit = page.items[0]
        if (hit && (!access.project || hit.header.cwd === access.cwd) && (args.include_current || hit.header.id !== access.id)) {
          const next = { ...record(hit), match: { seq: hit.bestMatch.seq, type: hit.bestMatch.type, snippet: trim(hit.bestMatch.snippet, previewChars) } }
          if (!bounded({ items: [...items, next], nextCursor: page.nextCursor ?? null, scope: args.scope ?? 'project' }, outputBytes)) {
            if (!items.length) throw new Error('outputBytes cannot fit one indexed hit')
            break
          }
          items.push(next)
        }
        if (!page.nextCursor) { cursor = undefined; break }
        if (seen.has(page.nextCursor) || page.nextCursor === cursor) throw new Error('Provider repeated search cursor')
        seen.add(page.nextCursor); cursor = page.nextCursor
      }
      return { items, nextCursor: cursor ?? null, scope: args.scope ?? 'project' }
    } }))
    add(defineTool({ name: 'session_event_search', description: 'Indexed FTS token search within a session; not arbitrary substring matching. Never scans logs. Current session excludes executing step.', parameters: { ...targetParam, query: { type: 'string', required: true }, scope: scopeParam, ...limitParam, cursor: { type: 'string' } }, output, presentCall: call('Search events'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const query = args.query.trim(); if (!query) throw new Error('query must not be empty')
      const items: JsonValue[] = []; let cursor = args.cursor as SessionSearchCursor | undefined
      const seen = new Set<string>()
      // The active step is never searchable; prior steps in the same session remain available.
      const boundary = sessionId === access.id ? (await ctx.sessionQuery.listEvents(sessionId)).findLast(event => event.type === 'step/start')?.seq : undefined
      if (sessionId === access.id && boundary === undefined) throw new Error('Current-session search requires a step/start event')
      const filters = boundary === undefined ? [] : [{ kind: 'seq' as const, to: boundary - 1 }]
      if (boundary === 0) return { sessionId, items: [], nextCursor: null }
      while (items.length < size(args.limit)) {
        exec.signal.throwIfAborted()
        let page
        try { page = await ctx.sessionQuery.searchEvents({ sessionId, query, filters, limit: 1, ...(cursor ? { cursor } : {}) }, { signal: exec.signal }) }
        catch (error) { searchError(error) }
        authorize(page.session, access)
        const hit = page.items[0]
        if (hit) {
          const next = { seq: hit.seq, type: hit.type, time: hit.time, surface: hit.surface, snippet: trim(hit.snippet, previewChars) }
          if (!bounded({ sessionId, items: [...items, next], nextCursor: page.nextCursor ?? null }, outputBytes)) {
            if (!items.length) throw new Error('outputBytes cannot fit one indexed hit')
            break
          }
          items.push(next)
        }
        if (!page.nextCursor) { cursor = undefined; break }
        if (seen.has(page.nextCursor) || page.nextCursor === cursor) throw new Error('Provider repeated search cursor')
        seen.add(page.nextCursor); cursor = page.nextCursor
      }
      return { sessionId, items, nextCursor: cursor ?? null }
    } }))
    add(defineTool({ name: 'session_event_list', description: 'List every raw event including structural events, in ascending seq order; empty EOF page is normal.', parameters: { ...targetParam, scope: scopeParam, ...limitParam, after_seq: { type: 'integer', description: 'Last seen seq; omit to start at zero.' }, event_types: { type: 'array', items: { type: 'string' }, description: 'Explicit event type filter.' }, view: { type: 'string', enum: ['compact', 'metadata'], description: 'Default compact.' } }, output, presentCall: call('List events'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const records = await ctx.sessionQuery.listEvents(sessionId)
      const start = args.after_seq === undefined ? 0 : integer(args.after_seq, 'after_seq', 0, Number.MAX_SAFE_INTEGER) + 1
      const types = args.event_types === undefined ? undefined : new Set(args.event_types)
      const items: JsonValue[] = []
      let pos = records.findIndex(item => item.seq >= start)
      if (pos < 0) pos = records.length
      const selected = size(args.limit)
      let preview = new Map<number, string>()
      if (args.view !== 'metadata' && pos < records.length && previewChars > 0) {
        const end = Math.min(records.length - 1, pos + selected - 1)
        const docs = await ctx.sessionQuery.filterEvents(sessionId, [{ kind: 'seq', from: start, to: records[end]!.seq }])
        preview = new Map(docs.map(doc => [doc.seq, trim(doc.text, previewChars)]))
      }
      let lastSeq = args.after_seq ?? null
      for (; pos < records.length && items.length < selected; pos++) {
        const item = records[pos]!
        if (types && !types.has(item.type)) { lastSeq = item.seq; continue }
        let entry = args.view === 'metadata' ? { ...item } : { ...item, ...(preview.has(item.seq) ? { preview: preview.get(item.seq) } : {}) }
        if (!bounded({ sessionId, items: [...items, entry], nextAfterSeq: item.seq }, outputBytes) && 'preview' in entry) entry = { ...item }
        if (!bounded({ sessionId, items: [...items, entry], nextAfterSeq: item.seq }, outputBytes)) {
          if (!items.length) throw new Error('outputBytes cannot fit one event record')
          break
        }
        items.push(entry); lastSeq = item.seq
      }
      return { sessionId, items, nextAfterSeq: pos < records.length ? lastSeq : null }
    } }))
    add(defineTool({ name: 'session_event_read', description: 'Read raw event as an exact JSON UTF-8 byte fragment; use offset_bytes to continue. Fragments are NOT complete JSON until concatenated.', parameters: { ...targetParam, scope: scopeParam, seq: { type: 'integer', required: true }, offset_bytes: { type: 'integer', description: 'UTF-8 byte offset, default zero.' } }, output, presentCall: call('Read event'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const seq = integer(args.seq, 'seq', 0, Number.MAX_SAFE_INTEGER)
      const window = await ctx.sessionQuery.readEvent({ sessionId, seq: SessionSeq(seq) }, exec.signal)
      authorize(window.session, access)
      const bytes = Buffer.from(JSON.stringify(window.target), 'utf8')
      const offset = integer(args.offset_bytes, 'offset_bytes', 0, Number.MAX_SAFE_INTEGER)
      if (offset > bytes.length) throw new RangeError('offset_bytes exceeds serialized event length')
      const base = { sessionId, seq, format: 'base64-encoded exact UTF-8 JSON byte slice', offsetBytes: offset, totalBytes: bytes.length }
      let length = Math.min(bytes.length - offset, outputBytes)
      while (length > 0 && !bounded({ ...base, dataBase64: bytes.subarray(offset, offset + length).toString('base64'), nextOffsetBytes: offset + length < bytes.length ? offset + length : null }, outputBytes)) length = Math.floor(length * 0.75)
      if (offset < bytes.length && length === 0) throw new Error('outputBytes cannot fit one event fragment')
      return { ...base, dataBase64: bytes.subarray(offset, offset + length).toString('base64'), nextOffsetBytes: offset + length < bytes.length ? offset + length : null }
    } }))
    add(defineTool({ name: 'session_trace', description: 'Trace complete visible ancestry and descendants; project hides relations outside exact cwd, all reveals current provider.', parameters: { ...targetParam, scope: scopeParam }, output, presentCall: call('Trace session'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const trace = await ctx.sessionQuery.traceSession(sessionId, exec.signal)
      authorize(trace.target.header, access)
      const ancestors = trace.ancestors.filter(item => !access.project || item.header.cwd === access.cwd)
      const descendants = trace.descendants.map(node => safeTrace(node, access)).filter(node => node !== null)
      return fitsOrThrow({ target: record(trace.target), ancestors: ancestors.map(record), descendants, complete: trace.complete && ancestors.length === trace.ancestors.length, ...(access.project ? {} : trace.complete ? { root: record(trace.root) } : { unresolvedParentId: trace.unresolvedParentId }) }, outputBytes)
    } }))
    add(defineTool({ name: 'session_event_trace', description: 'Trace direct event replacement and citation relationships without omitting links.', parameters: { ...targetParam, scope: scopeParam, seq: { type: 'integer', required: true } }, output, presentCall: call('Trace event'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const seq = integer(args.seq, 'seq', 0, Number.MAX_SAFE_INTEGER)
      const trace = await ctx.sessionQuery.traceEvent({ sessionId, seq: SessionSeq(seq) }, exec.signal)
      authorize(trace.session, access)
      return fitsOrThrow({ sessionId, target: { ...trace.target }, replacedBy: trace.replacedBy ?? null, replacementChain: trace.replacementChain, replacedEventSeqs: trace.replacedEventSeqs, sourceEventSeqs: trace.sourceEventSeqs, derivedEventSeqs: trace.derivedEventSeqs }, outputBytes)
    } }))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  })
}
