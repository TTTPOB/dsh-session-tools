/** Detached public context-map records. Anchors address Surface positions, not log ranges. */
export type SnapshotRef = {
  session_id: string
  /** Inclusive committed source-read upper seq; -1 means an empty source. */
  read_seq: number
  /** Diagnostic sample identity only; never required to resolve a region. */
  map_id: string
}
/** A boundary immediately before or after a current Surface node. */
export type Anchor = { seq: number; edge: 'before' | 'after' }
/** A continuous Surface interval; end is exclusive after resolving its edge. */
export type SurfaceLocator = { start: Anchor; end: Anchor }
/** Each call samples current state. No cursor or prior snapshot is accepted. */
export type ContextMapInput = {
  session_id?: string
  scope?: 'project' | 'all'
  view?: 'overview' | 'messages'
  window?: { anchor: Anchor; side: 'before' | 'after' | 'around' }
  limit?: number
  metering?: 'auto' | 'none' | 'require'
}
/** Caller-configured display limits shared by the tool and library. */
export type ContextMapOptions = {
  mapPageSize: number; mapMaxPageSize: number; mapMaxSpans: number
  previewChars: number; outputBytes: number
}
/** Navigation uses actual log lifecycle boundaries; null denotes absent evidence. */
export type ContextMapNavigation = { turn: number | null; step: number | null; turn_start_seq: number | null; step_start_seq: number | null }
/** One current positional node, including nodes with no model message. */
export type ContextMapNode = {
  surface_index: number; seq: number; read_seq: number; event_type: string
  role: string; source: string; form: string
  preview: string; preview_basis: 'session-message'; preview_truncated: boolean
  locator: SurfaceLocator; navigation: ContextMapNavigation
  estimated_tokens: number | null; share_of_surface: number | null
}
/** A bounded continuous interval in Surface order. */
export type ContextMapSpan = SurfaceLocator & {
  start_index: number; end_index: number; node_count: number
  estimated_tokens: number | null; share_of_surface: number | null
}
/** Meter and message projection are seq-aligned but may interpret different text. */
export type ContextMapMetering = {
  available: boolean; basis: 'token-meter/raw-event-fold' | null; reason: string | null
  log_revision: number | null; surface_tokens: number | null; total_tokens: number | null
  baseline: { kind: string; tokens: number } | null
  capacity: number | null; share_of_capacity: number | null; capacity_reason: string | null
}
/** Recorded projection values retain their own basis and asOfSeq, independent of node prices. */
export type ContextMapSummary = {
  basis: 'recorded-context-projections'; as_of_seq: number | null
  pressure: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } | null
  breakdown: { systemTokens: number; toolsTokens: number; messageTokens: number } | null
  pressure_tokens: number | null; capacity: number | null; share_of_capacity: number | null
  reason: string | null
}
/** A detached current sample; map_id appears only inside snapshot_ref. */
export type ContextMapOutput = {
  snapshot_ref: SnapshotRef
  source: { kind: string; replace_generation: number; content_generation: number }
  view: 'overview' | 'messages'
  window: { start_index: number; end_index: number; returned: number; total: number; locator: SurfaceLocator | null }
  nodes: ContextMapNode[]
  spans: ContextMapSpan[]
  metering: ContextMapMetering
  context_summary: ContextMapSummary
}
