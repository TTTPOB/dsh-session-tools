import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-workspace'
import Schema from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord, SessionSearchCursor, SessionEventMetadataFilter } from '@deepseek-ai/dsh-session-query'

import { integer, bounded, trim, record, caller, authorize, searchError } from './shared.js'
import { output, scopeParam, targetParam, limitParam, call } from './definitions.js'
import { readTools } from './read-tools.js'

/** Loader-visible plugin identity. */
export const name = 'dsh-session-tools'
/** Services required before tools are registered. */
export const inject = ['tools', 'sessionQuery', 'sessionProjections', 'workspaceRegistry']
/** Limits applied to native output, indexed searches and prepared event fragments. */
export interface Config { pageSize: number; maxPageSize: number; previewChars: number; outputBytes: number; searchTimeoutMs: number; eventReadCacheEntries: number; eventReadCacheBytes: number }
/** Loader-validated defaults and numeric limits. */
export const Config: Schema<Config> = Schema.object({
  pageSize: Schema.number().step(1).min(1).max(100).default(30),
  maxPageSize: Schema.number().step(1).min(1).max(100).default(100),
  previewChars: Schema.number().step(1).min(0).max(4000).default(240),
  outputBytes: Schema.number().step(1).min(1024).max(1048576).default(24576),
  searchTimeoutMs: Schema.number().step(1).min(1).max(2147483647).default(30000),
  eventReadCacheEntries: Schema.number().step(1).min(0).max(1000).default(8),
  eventReadCacheBytes: Schema.number().step(1).min(0).max(1073741824).default(67108864),
})
/** Register seven reversible, native-object session query tools.
 * @param ctx - Cordis services shared with the active agent.
 * @param config - Validated page, preview, output, and search timeout limits.
 */
export function apply(ctx: Context, config: Config): void {
  const { pageSize, maxPageSize, previewChars, outputBytes, searchTimeoutMs } = config
  if (typeof ctx.sessionQuery.pageSessions !== 'function' || typeof ctx.sessionQuery.pageEvents !== 'function') throw new Error('dsh-session-tools requires sessionQuery pageSessions/pageEvents (query 0.1.7-rc.2-fork2 or a compatible engine)')
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
  const titles = async (records: readonly SessionRecord[], exec: ToolRunContext, access: ReturnType<typeof caller>) => {
    const map = new Map<string, { title: string; cached?: true }>()
    if (!records.length) return map
    const cache = ctx.get('sessionProjectionCache')
    const sessions = ctx.get('sessions')
    const unresolved: ReturnType<typeof id>[] = []
    for (const item of new Map(records.map(item => [item.header.id, item])).values()) {
      authorize(item.header, access)
      // Live results retain the exact query read, never a stale checkpoint hint.
      if (item.live || sessions?.get(item.header.id) !== undefined) {
        unresolved.push(item.header.id)
        continue
      }
      let title = cache?.cachedSnapshot(item.header, ['title'])?.values.title
      if (title === undefined) title = cache?.cachedPredecessorTitle(item.header)?.values.title
      if (title === undefined) unresolved.push(item.header.id)
      else map.set(item.header.id, { title: trim(title ?? '(untitled)', previewChars).preview, cached: true })
    }
    exec.signal.throwIfAborted()
    if (!unresolved.length) return map
    const results = await ctx.sessionQuery.readTitleSnapshots(unresolved, exec.signal)
    exec.signal.throwIfAborted()
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
      authorize(result.value.session, access)
      map.set(result.sessionId, { title: trim(result.value.title?.title ?? '(untitled)', previewChars).preview })
    }
    return map
  }
  // The effect disposes registrations; add rolls back partial registration failures.
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const add = (definition: Parameters<typeof ctx.tools.register>[0]) => { try { disposers.push(ctx.tools.register(definition)) } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error } }
    add(defineTool({ name: 'session_list', description: 'List a stable snapshot of session metadata. Titles are display hints; title_cached:true marks cached hints that may lag renames. project uses exact caller cwd; all uses the current provider only.', parameters: { scope: scopeParam, ...limitParam, cursor: { type: 'string', description: 'Opaque snapshot continuation; keep scope and limit unchanged.' } }, output, presentCall: call('List sessions'), async execute(args, exec) {
      const access = caller(exec, args.scope)
      exec.signal.throwIfAborted()
      const page = await ctx.sessionQuery.pageSessions({ filters: access.project ? [{ kind: 'cwd', values: [access.cwd!] }] : [], limit: size(args.limit), ...(args.cursor === undefined ? {} : { cursor: args.cursor as SessionSearchCursor }) }, exec.signal)
      exec.signal.throwIfAborted()
      let names: Awaited<ReturnType<typeof titles>>
      try { names = await titles(page.items, exec, access) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') error.message += ' (Snapshot item no longer available; start a new listing without a cursor.)'
        throw error
      }
      const items = page.items.map(item => record(item, names.get(item.header.id)?.title, !access.project, names.get(item.header.id)?.cached))
      const result = { items, has_more: !!page.nextCursor, next_cursor: page.nextCursor ?? null }
      if (!bounded(result, outputBytes)) throw new Error('Session list page exceeds outputBytes; lower limit and start a new listing without a cursor, or increase configured outputBytes; no partial result was returned')
      return result
    } }))
    add(defineTool({
      name: 'session_search',
      description: 'Indexed FTS token search across sessions; not arbitrary substring matching. Titles are display hints; title_cached:true marks cached hints that may lag renames. Never scans logs for search. Excludes caller session and archived sessions by default. Do not search archived sessions unless there is a specific need; set include_archived:true only then. Filtered pages can be empty with has_more:true; continue with next_cursor.',
      parameters: {
        query: { type: 'string', required: true },
        scope: scopeParam,
        ...limitParam,
        cursor: { type: 'string', description: 'Opaque continuation cursor.' },
        include_current: { type: 'boolean', description: 'Include current session (default false).' },
        include_archived: { type: 'boolean', description: 'Include archived sessions (default false). Use only for a specific need to retrieve archived work; keep unchanged across continuation requests.' },
      },
      output,
      timeoutMs: searchTimeoutMs,
      presentCall: call('Search sessions'),
      async execute(args, exec) {
        const access = caller(exec, args.scope)
        const query = args.query.trim(); if (!query) throw new Error('query must not be empty')
        const requested = size(args.limit)
        exec.signal.throwIfAborted()
        let page
        try {
          page = await ctx.sessionQuery.searchSessions({
            query,
            limit: requested,
            sessionFilters: access.project ? [{ kind: 'cwd', values: [access.cwd!] }] : [],
            ...(args.cursor ? { cursor: args.cursor as SessionSearchCursor } : {}),
          }, { signal: exec.signal })
        } catch (error) { searchError(error) }
        exec.signal.throwIfAborted()
        const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
        const hits = page.items.filter(hit =>
          (args.include_current || hit.header.id !== access.id)
          && (args.include_archived === true || !archived.has(hit.header.id)))
        const names = await titles(hits, exec, access)
        const items = hits.map(hit => {
          const snippet = trim(hit.bestMatch.snippet, previewChars)
          return {
            ...record(hit, names.get(hit.header.id)?.title, !access.project, names.get(hit.header.id)?.cached),
            archived: archived.has(hit.header.id),
            seq: hit.bestMatch.seq,
            type: hit.bestMatch.type,
            snippet: snippet.preview,
            snippet_truncated: snippet.text_truncated,
          }
        })
        const result = { items, has_more: !!page.nextCursor, next_cursor: page.nextCursor ?? null }
        if (!bounded(result, outputBytes)) throw new Error('Indexed search page exceeds outputBytes; lower limit and start a new search without a cursor, or increase configured outputBytes; no partial result was returned')
        return result
      },
    }))
    add(defineTool({ name: 'session_event_search', description: 'Indexed FTS token search within a session; not arbitrary substring matching. Searches existing indexed documents across all surfaces by default. PTC dispatch records are not indexed; no match does not mean no record. Snippets are index excerpts; use read_seq with session_event_read for Detail or Raw. Never scans logs or reads activities for hits. Current session excludes executing step.', parameters: { ...targetParam, query: { type: 'string', required: true }, scope: scopeParam, ...limitParam, surfaces: { type: 'array', items: { type: 'string', enum: ['current', 'shadowed', 'log-only'] }, description: 'OR filter on indexed surfaces; omit for all three. Empty arrays are rejected. Keep unchanged on continuation.' }, cursor: { type: 'string', description: 'Opaque continuation; keep query, scope, limit and surfaces unchanged.' } }, output, timeoutMs: searchTimeoutMs, presentCall: call('Search events'), async execute(args, exec) {
      const access = caller(exec, args.scope); const sessionId = await target(args.session_id, exec, access)
      const query = args.query.trim(); if (!query) throw new Error('query must not be empty')
      const requested = size(args.limit)
      // The active step is never searchable; prior steps in the same session remain available.
      const boundary = sessionId === access.id ? ctx.sessionProjections.stateOf(exec.agent!.session, 'turnBoundary')?.lastStepStartSeq : undefined
      if (sessionId === access.id && boundary == null) throw new Error('Current-session search requires a step/start event')
      if (args.surfaces?.length === 0) throw new Error('surfaces must not be empty')
      const filters: SessionEventMetadataFilter[] = boundary == null ? [] : [{ kind: 'seq', to: boundary - 1 }]
      if (args.surfaces !== undefined) filters.push({ kind: 'surface', values: args.surfaces })
      if (boundary === 0) return { session_id: sessionId, items: [], has_more: false, next_cursor: null }
      exec.signal.throwIfAborted()
      let page
      try { page = await ctx.sessionQuery.searchEvents({ sessionId, query, filters, limit: requested, ...(args.cursor ? { cursor: args.cursor as SessionSearchCursor } : {}) }, { signal: exec.signal }) }
      catch (error) { searchError(error) }
      authorize(page.session, access)
      exec.signal.throwIfAborted()
      const items = page.items.map(hit => {
        const snippet = trim(hit.snippet, previewChars)
        return { seq: hit.seq, type: hit.type, time: hit.time, surface: hit.surface, snippet: snippet.preview, snippet_truncated: snippet.text_truncated, read_seq: hit.seq }
      })
      const result = { session_id: sessionId, items, has_more: !!page.nextCursor, next_cursor: page.nextCursor ?? null }
      if (!bounded(result, outputBytes)) throw new Error('Indexed search page exceeds outputBytes; lower limit and start a new search without a cursor, or increase configured outputBytes; no partial result was returned')
      return result
    } }))
    const reads = readTools(ctx, { previewChars, outputBytes, size, target, titles, eventReadCacheEntries: config.eventReadCacheEntries, eventReadCacheBytes: config.eventReadCacheBytes })
    for (const tool of reads.tools) add(tool)
    return () => { reads.dispose(); for (const dispose of disposers.reverse()) dispose() }
  })
}
