import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { call, scopeParam } from './definitions.js'
import { getContextMap } from './context-map.js'
import type { ContextMapOptions } from './context-map-types.js'

/** Native current-map tool; registration belongs to the caller's plugin effect. */
export function contextMapTool(ctx: Context, options: ContextMapOptions) {
  return defineTool({ name: 'session_context_map',
    description: 'Map current model context in Surface order. Every call samples current state; no old-map pagination. overview includes bounded continuous spans and a current node window; messages returns only the window. Replaced anchors require a new map. Read full text via session_event_read using node read_seq. Token estimates and previews may use different text; shares use the Surface token sum, not compression savings.',
    parameters: {
      session_id: { type: 'string', description: 'Defaults to caller session; an explicit target maps its current Surface.' },
      scope: scopeParam,
      view: { type: 'string', enum: ['overview', 'messages'], description: 'overview (default) or messages.' },
      limit: { type: 'integer', description: 'Window node count; defaults to mapPageSize.' },
      metering: { type: 'string', enum: ['auto', 'none', 'require'], description: 'auto (default) reports missing meter; none skips meter; require fails without meter.' },
      window: { type: 'object', additionalProperties: false, properties: {
        anchor: { type: 'object', additionalProperties: false, required: true, properties: { seq: { type: 'integer', required: true }, edge: { type: 'string', enum: ['before', 'after'], required: true } } },
        side: { type: 'string', enum: ['before', 'after', 'around'], required: true },
      }, description: 'Current node boundary and display side; omit for the tail window.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: call('Map context'),
    execute: (args, exec) => getContextMap(ctx, exec, args, options),
  })
}
