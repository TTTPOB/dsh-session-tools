/** Shared native output schema and model-facing argument descriptions. */
// A JSON output schema preserves native structured values for run_code.
/** Native JSON output, including the pagination field descriptions. */
export const output = {
  schema: { type: 'object' as const, additionalProperties: true, properties: {
    items: { type: 'array' as const, description: 'Only entries on this page, never a global total.' },
    has_more: { type: 'boolean' as const, description: 'Whether a continuation exists; false at EOF.' },
    next_cursor: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }] as const, description: 'Opaque indexed-search continuation; null at EOF.' },
    next_offset: { oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const, description: 'Next session-list offset or Unicode-code-point event-fragment offset; null at EOF.' },
    next_after_seq: { oneOf: [{ type: 'integer' as const }, { type: 'null' as const }] as const, description: 'Last raw seq seen for event-list continuation; null at EOF.' },
  } } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}
/** Shared project/all scope argument. */
export const scopeParam = { type: 'string' as const, enum: ['project', 'all'] as const, description: 'project (default): exact caller session cwd; all: current provider DSH_HOME only.' }
/** Exact target session argument. */
export const targetParam = { session_id: { type: 'string' as const, required: true as const, description: 'Exact session ID.' } }
/** Per-call result page size argument. */
export const limitParam = { limit: { type: 'integer' as const, description: 'Page size; defaults to configured pageSize.' } }
/** Generic call-card presenter. */
export const call = (verb: string) => (args: {session_id?: string; seq?: number; scope?: string}) => ({
  card: 'generic' as const, kind: 'read' as const, title: `${verb}${args.session_id ? ` ${args.session_id}` : ''}${args.seq === undefined ? '' : ` #${args.seq}`}`,
})
