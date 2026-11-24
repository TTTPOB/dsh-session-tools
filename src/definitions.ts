/** Shared native output schema and model-facing argument descriptions. */
// A JSON output schema preserves native structured values for run_code.
/** Native JSON output, including the pagination field descriptions. */
export const output = {
  schema: { type: 'object' as const, additionalProperties: true, properties: {
    items: { type: 'array' as const, description: 'Only entries on this page, never a global total.' },
    has_more: { type: 'boolean' as const, description: 'Whether a continuation exists; false at EOF.' },
    next_cursor: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }] as const, description: 'Opaque session-list or indexed-search continuation; null at EOF.' },
    next_offset: { oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const, description: 'Next Unicode-code-point event-fragment offset; null at EOF.' },
    next_after_seq: { oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const, description: 'Last raw seq seen for event-list continuation; null at EOF.' },
  } } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}
/** Event-list output for both activity projections and exact metadata. */
export const eventListOutput = {
  schema: { type: 'object', additionalProperties: true, properties: {
    session_id: { type: 'string', description: 'Target session ID.' },
    captured_through_seq: { type: 'integer', description: 'Last event seq visible to this read.' },
    view: { type: 'string', enum: ['compact', 'metadata'], description: 'View used for this page.' },
    items: { type: 'array', description: 'Activity projections in compact view; exact {seq, type} entries in metadata view.', items: { oneOf: [
      { type: 'object', additionalProperties: true, description: 'Compact activity projection.', properties: {
        activity_id: { type: 'string' },
        page_source_seqs: { type: 'array', items: { type: 'integer' }, required: true, description: 'Delivered anchors in this activity.' },
      } },
      { type: 'object', additionalProperties: false, description: 'Exact event metadata.', properties: {
        seq: { type: 'integer', required: true },
        type: { type: 'string', required: true },
      } },
    ] } },
    has_more: { type: 'boolean', description: 'Whether more matching events remain.' },
    next_after_seq: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Last delivered anchor seq to pass as after_seq; null at EOF.' },
    requested_limit: { type: 'integer', description: 'Requested event limit, present only when capped.' },
    effective_limit: { type: 'integer', description: 'Event limit used when the request is capped.' },
    page_truncated: { type: 'object', additionalProperties: false, description: 'Present when the response budget reduces the page.', properties: {
      reason: { type: 'string', enum: ['output_bytes'], required: true },
      delivered: { type: 'integer', required: true, description: 'Number of anchors delivered.' },
      selected: { type: 'integer', required: true, description: 'Number of anchors selected before byte budgeting.' },
    } },
    notices: { type: 'array', items: { type: 'string' }, description: 'Limit and byte-budget adjustments, if any.' },
  } } as const,
  render: output.render,
}
/** Shared project/all scope argument. */
export const scopeParam = { type: 'string' as const, enum: ['project', 'all'] as const, description: 'project (default): exact caller session cwd; all: current provider DSH_HOME only.' }
/** Exact target session argument. */
export const targetParam = { session_id: { type: 'string' as const, required: true as const, description: 'Exact session ID.' } }
/** Per-call result page size argument. */
export const limitParam = (pageSize: number, maxPageSize: number, overflow = 'Values above the maximum are rejected.') => ({
  limit: { type: 'integer' as const, description: `Page size: 1–${maxPageSize}; default ${pageSize}. ${overflow}` },
})
/** Generic call-card presenter. */
export const call = (verb: string) => (args: {session_id?: string; seq?: number; scope?: string}) => ({
  card: 'generic' as const, kind: 'read' as const, title: `${verb}${args.session_id ? ` ${args.session_id}` : ''}${args.seq === undefined ? '' : ` #${args.seq}`}`,
})
