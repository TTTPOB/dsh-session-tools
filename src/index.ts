import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionSearchCursor } from '@deepseek-ai/dsh-session-query'

import { integer, bounded, trim, record, caller, authorize, fitsOrThrow, searchError } from './shared.js'
import { output, scopeParam, targetParam, limitParam, call } from './definitions.js'
import { readTools } from './read-tools.js'

/** Loader-visible plugin identity. */
export const name = 'dsh-session-tools'
/** Services required before tools are registered. */
export const inject = ['tools', 'sessionQuery', 'sessionProjections']
/** Limits applied to complete native JSON output and indexed searches. */
export interface Config { pageSize: number; maxPageSize: number; previewChars: number; outputBytes: number; searchTimeoutMs: number }
/** Loader-validated defaults and numeric limits. */
export const Config: Schema<Config> = Schema.object({
  pageSize: Schema.number().step(1).min(1).max(100).default(30),
  maxPageSize: Schema.number().step(1).min(1).max(100).default(100),
  previewChars: Schema.number().step(1).min(0).max(4000).default(240),
  outputBytes: Schema.number().step(1).min(1024).max(1048576).default(24576),
  searchTimeoutMs: Schema.number().step(1).min(1).max(2147483647).default(30000),
})
/** Register seven reversible, native-object session query tools.
 * @param ctx - Cordis services shared with the active agent.
 * @param config - Validated page, preview, output, and search timeout limits.
 */
export function apply(ctx: Context, config: Config): void {
  const { pageSize, maxPageSize, previewChars, outputBytes, searchTimeoutMs } = config
  if (pageSize > maxPageSize) throw new RangeError('pageSize cannot exceed maxPageSize')
  const size = (n?: number) => { const value = integer(n, 'limit', pageSize, maxPageSize); if (!value) throw new RangeError('limit must be positive'); return value }
  const id = (text: string) => { if (!text.trim()) throw new Error('session_id is required'); return SessionId(text) }
  const target = async (text: string, exec: ToolRunContext, access: ReturnType<typeof caller>) => {
    const sessionId = id(text)
    const records = await ctx.sessionQuery.filterSessions([{ kind: 'id', values: [sessionId] }], exec.signal)
    exec.signal.throwIfAborted()
    const match = records.find(item => item.header.id === sessionId)
    if (!match) throw new Error(`Session ${sessionId} not found`)
    authorize(match.header, access)
    return sessionId
  }
  const titles = async (ids: readonly ReturnType<typeof id>[], exec: ToolRunContext, access: ReturnType<typeof caller>) => {
    if (!ids.length) return new Map<string, string>()
    const results = await ctx.sessionQuery.readTitleSnapshots(ids, exec.signal)
    exec.signal.throwIfAborted()
    const map = new Map<string, string>()
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
      authorize(result.value.session, access)
      map.set(result.sessionId, trim(result.value.title?.title ?? '(untitled)', previewChars).preview)
    }
    return map
  }
  // The effect disposes registrations; add rolls back partial registration failures.
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const add = (definition: Parameters<typeof ctx.tools.register>[0]) => { try { disposers.push(ctx.tools.register(definition)) } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error } }
    add(defineTool({ name: 'session_list', description: 'List session metadata. project uses exact caller cwd; all uses the current provider only.', parameters: { scope: scopeParam, ...limitParam, offset: { type: 'integer', description: 'Number of sessions to skip (default 0).' } }, output, presentCall: call('List sessions'), async execute(args, exec) {
      const access = caller(exec, args.scope)
      const records = await ctx.sessionQuery.listSessions(exec.signal)
      exec.signal.throwIfAborted()
      const visible = records.filter(item => !access.project || item.header.cwd === access.cwd)
      const start = integer(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER)
      const requested = size(args.limit)
      const selected = visible.slice(start, start + requested)
      const names = await titles(selected.map(item => item.header.id), exec, access)
      const items: ReturnType<typeof record>[] = []
      for (const item of selected) {
        const next = record(item, names.get(item.header.id), !access.project)
        const candidate = { items: [...items, next], has_more: start + items.length + 1 < visible.length, next_offset: start + items.length + 1 < visible.length ? start + items.length + 1 : null }
        if (!bounded(candidate, outputBytes)) break
        items.push(next)
      }
      if (!items.length && selected.length) throw new Error('outputBytes cannot fit one session record')
      while (items.length && !bounded({ items, has_more: start + items.length < visible.length, next_offset: start + items.length < visible.length ? start + items.length : null }, outputBytes)) items.pop()
      if (!items.length && selected.length) throw new Error('outputBytes cannot fit one session record')
      const result = { items, has_more: start + items.length < visible.length, next_offset: start + items.length < visible.length ? start + items.length : null }
      return fitsOrThrow(result, outputBytes)
    } }))
    add(defineTool({ name: 'session_search', description: 'Indexed FTS token search across sessions; not arbitrary substring matching. Never scans logs. Excludes caller session by default.', parameters: { query: { type: 'string', required: true }, scope: scopeParam, ...limitParam, cursor: { type: 'string', description: 'Opaque continuation cursor.' }, include_current: { type: 'boolean', description: 'Include current session (default false).' } }, output, timeoutMs: searchTimeoutMs, presentCall: call('Search sessions'), async execute(args, exec) {
      const access = caller(exec, args.scope)
      const query = args.query.trim(); if (!query) throw new Error('query must not be empty')
      const requested = size(args.limit)
      exec.signal.throwIfAborted()
      let page
      try { page = await ctx.sessionQuery.searchSessions({ query, limit: requested, sessionFilters: access.project ? [{ kind: 'cwd', values: [access.cwd!] }] : [], ...(args.cursor ? { cursor: args.cursor as SessionSearchCursor } : {}) }, { signal: exec.signal }) }
      catch (error) { searchError(error) }
      exec.signal.throwIfAborted()
      const hits = page.items.filter(hit => args.include_current || hit.header.id !== access.id)
      const names = await titles(hits.map(hit => hit.header.id), exec, access)
      const items = hits.map(hit => ({ ...record(hit, names.get(hit.header.id), !access.project), seq: hit.bestMatch.seq, type: hit.bestMatch.type, snippet: trim(hit.bestMatch.snippet, previewChars).preview, snippet_truncated: trim(hit.bestMatch.snippet, previewChars).text_truncated }))
      const result = { items, has_more: !!page.nextCursor, next_cursor: page.nextCursor ?? null }
      if (!bounded(result, outputBytes)) throw new Error('Indexed search page exceeds outputBytes; lower limit and start a new search without a cursor, or increase configured outputBytes; no partial result was returned')
      return result
    } }))
    add(defineTool({ name: 'session_event_search', description: 'Indexed FTS token search within a session; not arbitrary substring matching. Never scans logs. Current session excludes executing step.', parameters: { ...targetParam, query: { type: 'string', required: true }, scope: scopeParam, ...limitParam, cursor: { type: 'string' } }, output, timeoutMs: searchTimeoutMs, presentCall: call('Search events'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const query = args.query.trim(); if (!query) throw new Error('query must not be empty')
      const requested = size(args.limit)
      // The active step is never searchable; prior steps in the same session remain available.
      const boundary = sessionId === access.id ? ctx.sessionProjections.stateOf(exec.agent!.session, 'turnBoundary')?.lastStepStartSeq : undefined
      if (sessionId === access.id && boundary == null) throw new Error('Current-session search requires a step/start event')
      const filters = boundary == null ? [] : [{ kind: 'seq' as const, to: boundary - 1 }]
      if (boundary === 0) return { session_id: sessionId, items: [], has_more: false, next_cursor: null }
      exec.signal.throwIfAborted()
      let page
      try { page = await ctx.sessionQuery.searchEvents({ sessionId, query, filters, limit: requested, ...(args.cursor ? { cursor: args.cursor as SessionSearchCursor } : {}) }, { signal: exec.signal }) }
      catch (error) { searchError(error) }
      authorize(page.session, access)
      exec.signal.throwIfAborted()
      const items = page.items.map(hit => ({ seq: hit.seq, type: hit.type, snippet: trim(hit.snippet, previewChars).preview, snippet_truncated: trim(hit.snippet, previewChars).text_truncated }))
      const result = { session_id: sessionId, items, has_more: !!page.nextCursor, next_cursor: page.nextCursor ?? null }
      if (!bounded(result, outputBytes)) throw new Error('Indexed search page exceeds outputBytes; lower limit and start a new search without a cursor, or increase configured outputBytes; no partial result was returned')
      return result
    } }))
    for (const tool of readTools(ctx, { previewChars, outputBytes, size, target })) add(tool)
    return () => { for (const dispose of disposers.reverse()) dispose() }
  })
}
