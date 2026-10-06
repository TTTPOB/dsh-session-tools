import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionRecord, SessionLineageNode } from '@deepseek-ai/dsh-session-query'

/** Lossless JSON value returned through the native tool output channel. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Validate a tool numeric input without clamping or silently changing it. */
export function integer(value: number | undefined, name: string, fallback: number, max: number): number {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new RangeError(`${name} must be an integer between 0 and ${max}`)
  return n
}
/** Check UTF-8 bytes of the complete serialized native result. */
export function bounded(value: object, bytes: number): boolean { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes }
/** Trim preview text by Unicode code points. */
export function trim(text: string, chars: number) { const points = Array.from(text); return { preview: points.slice(0, chars).join(''), text_truncated: points.length > chars } }
/** Project compact session metadata without revealing parent identifiers. */
export function record(record: SessionRecord, title?: string, all = false, titleCached = false) { return { session_id: record.header.id, title: title ?? '(untitled)', ...(titleCached ? { title_cached: true } : {}), ...(all ? { cwd: record.header.cwd ?? null } : {}) } }
/** Resolve exact project authorization from the calling agent session. */
export function caller(exec: ToolRunContext, scope: string | undefined): { cwd?: string; id: string; project: boolean } {
  if (!exec.agent) throw new Error('An agent-bound session is required')
  if (scope !== undefined && scope !== 'project' && scope !== 'all') throw new Error('scope must be project or all')
  const cwd = exec.agent.session.header.cwd
  if (scope !== 'all' && cwd === undefined) throw new Error('project scope requires caller session header.cwd; use scope all explicitly')
  return { cwd, id: exec.agent.session.id, project: scope !== 'all' }
}
/** Reject a target outside the calling project. */
export function authorize(header: SessionHeader, access: ReturnType<typeof caller>): void {
  if (access.project && header.cwd !== access.cwd) throw new Error('Session is outside the caller project')
}
/** Hide out-of-project descendant subtrees and their identities. */
export function safeTrace(node: SessionLineageNode, access: ReturnType<typeof caller>): JsonValue | null {
  if (access.project && node.session.header.cwd !== access.cwd) return null
  return { session: record(node.session, undefined, !access.project), descendants: node.descendants.map(child => safeTrace(child, access)).filter(child => child !== null) }
}
/** Detect whether project scope omitted any descendants. */
export function hiddenDescendant(nodes: readonly SessionLineageNode[], cwd: string): boolean {
  for (const node of nodes) {
    if (node.session.header.cwd !== cwd || hiddenDescendant(node.descendants, cwd)) return true
  }
  return false
}
/** Reject an oversized complete result without dropping relationships. */
export function fitsOrThrow<T extends object>(value: T, budget: number): T {
  if (!bounded(value, budget)) throw new Error('Result exceeds outputBytes; narrow the request or increase configured outputBytes; no partial result was returned')
  return value
}
/** Preserve the provider error identity and annotate no-scan guidance. */
export function searchError(error: unknown): never {
  if (error instanceof Error) {
    // Preserve the provider's error identity and code while adding actionable guidance.
    error.message += ' (Indexed search failed; no logs were scanned. Report this to the user; do not scan logs as a workaround. FTS matches tokens, not arbitrary substrings.)'
  }
  throw error
}
