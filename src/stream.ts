import { once } from 'node:events'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, isAbsolute } from 'node:path'
import { setImmediate, setTimeout as wait } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionResultFilter, SessionSearchCursor } from '@deepseek-ai/dsh-session-query'

const NDJSON = 'application/x-ndjson; charset=utf-8'
const PAGE_SIZE = 100
const EVENT_BATCH_SIZE = 256
const SEARCH_WARMUP_MS = 120_000
const SEARCH_RETRY_MS = 250
const DEFAULT_EXCLUSIONS = new Set(['request/header', 'system/message'])

type Query = Context['sessionQuery']

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

function invalid(message: string): never {
  throw new RequestError(400, 'SESSION_STREAM_INVALID_PARAMETER', message)
}

function options(params: URLSearchParams, allowed: string[], repeat?: string) {
  for (const name of new Set(params.keys())) {
    if (!allowed.includes(name)) invalid(`Unknown parameter: ${name}`)
    if (name !== repeat && params.getAll(name).length > 1) invalid(`Repeated parameter: ${name}`)
  }
  return params
}

function integer(params: URLSearchParams, key: string, minimum: number, fallback: number): number {
  const value = params.get(key)
  if (value === null) return fallback
  const n = Number(value)
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n) || n < minimum) {
    invalid(`${key} must be a safe integer >= ${minimum}`)
  }
  return n
}

function sessionIds(params: URLSearchParams, min: number, max: number): SessionId[] {
  const values = params.getAll('session')
  if (values.length < min || values.length > max) {
    invalid(min === max ? `Expected ${min} session parameter` : `Expected ${min}–${max} session parameters`)
  }
  if (values.some(value => !value.trim())) invalid('session must not be blank')
  return [...new Set(values)].map(SessionId)
}

function cwdFilters(params: URLSearchParams): SessionResultFilter[] {
  const cwd = params.get('cwd')
  if (cwd === null) return []
  if (!isAbsolute(cwd)) invalid('cwd must be an absolute path')
  return [{ kind: 'cwd', values: [cwd] }]
}

async function requireSessions(query: Query, ids: readonly SessionId[], signal: AbortSignal): Promise<void> {
  if (ids.length === 0) return
  const records = await query.filterSessions([{ kind: 'id', values: ids }], signal)
  const found = new Set(records.map(record => record.header.id))
  const missing = ids.filter(id => !found.has(id))
  if (missing.length) {
    throw new RequestError(404, 'SESSION_QUERY_SESSION_NOT_FOUND', `Sessions not found: ${missing.join(', ')}`)
  }
}

async function* listSessions(query: Query, params: URLSearchParams, signal: AbortSignal) {
  options(params, ['cwd', 'limit'])
  let remaining = integer(params, 'limit', 1, Infinity)
  const filters = cwdFilters(params)
  let cursor
  do {
    signal.throwIfAborted()
    const page = await query.pageSessions({ filters, limit: Math.min(remaining, PAGE_SIZE), cursor }, signal)
    const titles = await query.readTitleSnapshots(page.items.map(item => item.header.id), signal)
    for (const [i, observation] of titles.entries()) {
      if (observation.status === 'rejected') throw observation.reason
      yield { ...page.items[i], title: observation.value.title?.title ?? null }
    }
    cursor = page.nextCursor
    remaining -= page.items.length
  } while (cursor !== undefined && remaining > 0)
}

async function* readEvents(query: Query, params: URLSearchParams, signal: AbortSignal) {
  options(params, ['session', 'types', 'after_seq', 'until_seq'], 'session')
  const ids = sessionIds(params, 1, 50)
  const after = integer(params, 'after_seq', -1, -1)
  const until = integer(params, 'until_seq', 0, Infinity)
  const types = params.get('types')?.split(',').map(type => type.trim())
  if (types?.includes('')) invalid('types must be a comma-separated list of event types')
  const selected = types === undefined ? undefined : new Set(types)
  await requireSessions(query, ids, signal)
  for (const id of ids) {
    signal.throwIfAborted()
    using observation = await query.observeSession(id, { signal, projectionMode: 'none' })
    const end = Math.min(until, observation.cursor) + 1
    for (let from = after + 1; from < end;) {
      signal.throwIfAborted()
      const to = Math.min(end, from + EVENT_BATCH_SIZE)
      for (const event of observation.readEvents(SessionLogOffset(from), SessionLogOffset(to))) {
        if (selected ? selected.has(event.type) : !DEFAULT_EXCLUSIONS.has(event.type)) {
          yield { ...event, session_id: id }
        }
      }
      from = to
      // Even a completely filtered batch must yield to allow disconnects to cancel the scan.
      if (from < end) await setImmediate(undefined, { signal })
    }
  }
}

async function waitForIndex<T>(search: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(SEARCH_WARMUP_MS)
  const attemptSignal = AbortSignal.any([signal, deadline])
  let warming = false
  try {
    while (true) {
      attemptSignal.throwIfAborted()
      try {
        return await search(attemptSignal)
      } catch (error) {
        if (errorCode(error) !== 'SESSION_QUERY_INDEX_WARMING') throw error
        warming = true
        await wait(SEARCH_RETRY_MS, undefined, { signal: attemptSignal })
      }
    }
  } catch (error) {
    if (!signal.aborted && deadline.aborted) {
      if (warming) throw new RequestError(503, 'SESSION_QUERY_INDEX_WARMING', 'The search index is still warming after 120 seconds')
      throw new RequestError(504, 'SESSION_STREAM_SEARCH_TIMEOUT', 'The search provider did not return a page within 120 seconds')
    }
    throw error
  }
}

async function* search(query: Query, params: URLSearchParams, signal: AbortSignal) {
  options(params, ['q', 'group', 'session', 'cwd', 'limit'], 'session')
  const text = params.get('q')
  if (!text?.trim()) invalid('q must not be blank')
  const group = params.get('group')
  if (group !== 'session' && group !== 'event') invalid('group must be session or event')
  const ids = sessionIds(params, 0, 50)
  const filters = cwdFilters(params)
  let remaining = integer(params, 'limit', 1, Infinity)
  if (ids.length > 0) filters.push({ kind: 'id', values: ids })
  await requireSessions(query, ids, signal)
  const input = { query: text, sessionFilters: filters }
  let cursor: SessionSearchCursor | undefined
  do {
    // Keep the provider's page size constant across its cursor chain and apply the HTTP limit to yielded hits.
    const page = await waitForIndex(async attemptSignal => {
      const request = { ...input, cursor }
      const exec = { signal: attemptSignal }
      return group === 'session' ? query.searchSessions(request, exec) : query.searchEvents(request, exec)
    }, signal)
    for (const hit of page.items) {
      yield hit
      if (--remaining === 0) return
    }
    cursor = page.nextCursor
  } while (cursor !== undefined)
}

async function* route(request: IncomingMessage, query: Query, signal: AbortSignal) {
  if (request.method !== 'GET') throw new RequestError(405, 'SESSION_STREAM_METHOD_NOT_ALLOWED', 'Use GET')
  const { pathname, searchParams } = new URL(request.url!, 'http://localhost')
  switch (pathname) {
    case '/sessions': yield* listSessions(query, searchParams, signal); return
    case '/search': yield* search(query, searchParams, signal); return
    case '/events': yield* readEvents(query, searchParams, signal); return
    case '/trace': {
      options(searchParams, ['session'])
      const [id] = sessionIds(searchParams, 1, 1)
      yield await query.traceSession(id, signal)
      return
    }
    default: throw new RequestError(404, 'SESSION_STREAM_ROUTE_NOT_FOUND', `Unknown path: ${pathname}`)
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function errorResponse(error: unknown) {
  const code = errorCode(error) ?? 'SESSION_STREAM_INTERNAL_ERROR'
  const status = error instanceof RequestError ? error.status
    : code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 404
      : code.startsWith('SESSION_QUERY_INVALID_') || code === 'SESSION_QUERY_EXCLUSION_ONLY' ? 400
        : 500
  return { status, error: { code, message: error instanceof Error ? error.message : String(error) } }
}

async function serve(request: IncomingMessage, response: ServerResponse, query: Query) {
  const controller = new AbortController()
  response.once('close', () => controller.abort())
  const { signal } = controller
  response.setHeader('Content-Type', NDJSON)
  try {
    for await (const item of route(request, query, signal)) {
      signal.throwIfAborted()
      if (!response.write(JSON.stringify(item) + '\n')) await once(response, 'drain', { signal })
    }
    response.end()
  } catch (error) {
    if (signal.aborted || response.destroyed) return
    const failure = errorResponse(error)
    const line = JSON.stringify({ error: failure.error }) + '\n'
    if (response.headersSent) {
      // Let curl read the diagnostic but do not terminate the chunked transfer successfully.
      response.write(line, () => response.destroy())
    } else {
      if (failure.status === 405) response.setHeader('Allow', 'GET')
      response.writeHead(failure.status).end(line)
    }
  }
}

/** Bind one private NDJSON socket; the owner must dispose it before rebinding the path. */
export function startSessionStream(socketPath: string, query: Query, privateDirectory: boolean) {
  const maxBytes = process.platform === 'darwin' ? 103 : 107
  if (!isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > maxBytes) {
    throw new Error(`Session stream socketPath must be an absolute path of at most ${maxBytes} UTF-8 bytes without NUL`)
  }
  const directory = dirname(socketPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (privateDirectory) chmodSync(directory, 0o700)
  const existing = lstatSync(socketPath, { throwIfNoEntry: false })
  if (existing !== undefined) {
    if (!existing.isSocket()) throw new Error(`Session stream socketPath is not a Unix socket: ${socketPath}`)
    unlinkSync(socketPath)
  }
  const server = createServer((request, response) => { void serve(request, response, query) })
  const dispose = () => {
    server.close()
    server.closeAllConnections()
    // Node unlinks the bound Unix socket on close.
  }
  server.listen(socketPath)
  if (server.listening) {
    try {
      // Unix bind is synchronous; set the mode before the event loop can serve any requests.
      chmodSync(socketPath, 0o600)
    } catch (error) {
      dispose()
      throw error
    }
  }
  return { ready: once(server, 'listening'), dispose }
}
