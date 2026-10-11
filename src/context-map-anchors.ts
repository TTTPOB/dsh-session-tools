import type { Anchor, SurfaceLocator } from './context-map-types.js'

/** Resolve a current Surface boundary; replaced anchors require a new map.
 * @param seqs - Current nodes in Surface order, never sorted by seq.
 * @param anchor - Current node and the edge being addressed.
 * @returns Half-open boundary index.
 */
export function resolveSurfaceAnchor(seqs: readonly number[], anchor: Anchor): number {
  if (!Number.isSafeInteger(anchor.seq) || anchor.seq < 0 || !['before', 'after'].includes(anchor.edge)) throw new Error('Invalid Surface anchor')
  const index = seqs.indexOf(anchor.seq)
  if (index === -1) throw new Error(`Surface anchor ${anchor.seq} is no longer current; request a new context map`)
  return index + (anchor.edge === 'after' ? 1 : 0)
}
/** Resolve a region using current nodes alone; no map cache or sample identity is needed.
 * @param seqs - Current nodes in Surface order.
 * @param locator - Ordered start and end boundaries.
 * @returns A nonempty half-open positional range.
 */
export function resolveSurfaceRange(seqs: readonly number[], locator: SurfaceLocator): { start_index: number; end_index: number } {
  const start_index = resolveSurfaceAnchor(seqs, locator.start)
  const end_index = resolveSurfaceAnchor(seqs, locator.end)
  if (start_index >= end_index) throw new Error('Surface range must be nonempty and ordered in current Surface position')
  return { start_index, end_index }
}
