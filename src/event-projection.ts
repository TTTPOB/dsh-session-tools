/** Bounded original-field previews, independent of search extraction and all I/O. */
import { fields, toolIdentity, type AssociatedActivity, type AssociatedTool, type EventAssociation, type ReadingEvent } from './event-association.js'

/** Every known type has an explicit strategy; future accepted types use bounded-fact. */
export const EVENT_PROJECTION_STRATEGIES: Readonly<Record<string, string>> = {
  'agent-preset/selected': 'bounded-fact', 'agent/inbox/spliced': 'inbox',
  'approval/asked': 'approval', 'approval/decided': 'approval', 'approval/policy': 'bounded-fact',
  'assistant/attempt': 'attempt', 'assistant/message': 'message',
  'command/done': 'command', 'command/run': 'command',
  'compaction/end': 'compaction', 'compaction/prune': 'prune', 'compaction/start': 'compaction', 'compaction/summary': 'summary',
  'deliverables/presented': 'delivery', 'developer/message': 'message',
  'feedback/message-delete': 'bounded-fact', 'feedback/message-put': 'bounded-fact', 'feedback/record': 'bounded-fact',
  'goal/change': 'bounded-fact', 'hook/invoked': 'hook', 'hook/result': 'hook', 'image/offload': 'offload',
  'llm/retry': 'retry', 'llm/retry-started': 'retry', 'model/selection': 'bounded-fact',
  'permission/preset': 'bounded-fact', 'plan/mode': 'bounded-fact',
  'request/context': 'request', 'request/header': 'request', 'sandbox/mode': 'bounded-fact',
  'schedule/change': 'bounded-fact', 'session-log-deepseek/delivery-accepted': 'bounded-fact',
  'session/end-seed': 'seed', 'session/title': 'bounded-fact', 'session/title-llm-request': 'auxiliary-request',
  'step/end': 'boundary', 'step/start': 'boundary', 'subagent/catalog': 'child-locator',
  'subagent/descriptor': 'bounded-fact', 'subagent/model-selection-policy': 'bounded-fact',
  'system/message': 'message', 'team/member': 'bounded-fact', 'team/message/delivered': 'bounded-fact',
  'team/message/queued': 'bounded-fact', 'team/task': 'bounded-fact', 'todo/write': 'todos',
  'tool-workflow/agent-end': 'workflow', 'tool-workflow/agent-start': 'workflow',
  'tool-workflow/run-end': 'workflow', 'tool-workflow/run-start': 'workflow',
  'tool/call': 'tool', 'tool/ptc-dispatch': 'tool', 'tool/ptc-dispatch-start': 'tool', 'tool/result': 'tool',
  'turn/end': 'boundary', 'turn/start': 'boundary', 'user/message': 'message',
  'web/deepseek-search-llm-request': 'auxiliary-request', 'workspace/changes': 'bounded-fact',
}

/** Caller-owned budgets are provisional until calibrated against local historical tasks. */
export interface ProjectionBudget {
  maxStringChars: number
  maxItems: number
  maxDepth: number
  maxNodes: number
  outputBytes: number
}

/** The reader owns coverage evidence; association alone cannot prove a complete Step. */
export interface ProjectionEvidence {
  pageSourceSeqs?: readonly number[]
  coverageComplete?: boolean
  incompleteReasons?: readonly string[]
}

export interface ProjectionOptions {
  view: 'compact' | 'detail'
  budget: ProjectionBudget
  evidence?: ProjectionEvidence
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface Bounded { value: Json; truncated: boolean }

/** Visit bounded nodes before serializing; do not materialize or stringify huge original payloads. */
function bound(value: unknown, budget: ProjectionBudget): Bounded {
  let remaining = budget.maxNodes
  let truncated = false
  const visit = (input: unknown, depth: number): Json => {
    if (remaining-- <= 0) { truncated = true; return null }
    if (typeof input === 'string') {
      let output = '', count = 0
      for (const char of input) {
        if (count++ >= budget.maxStringChars) { truncated = true; break }
        output += char
      }
      return output
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'number') return input
    if (depth >= budget.maxDepth) { truncated = true; return null }
    if (Array.isArray(input)) {
      const output: Json[] = []
      const count = Math.min(input.length, budget.maxItems)
      for (let i = 0; i < count && remaining > 0; i++) output.push(visit(input[i], depth + 1))
      if (output.length < input.length) truncated = true
      return output
    }
    if (typeof input === 'object') {
      const output: Record<string, Json> = {}
      let count = 0
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue
        if (count++ >= budget.maxItems || remaining <= 0) { truncated = true; break }
        const boundedKey = visit(key, depth + 1) as string
        if (boundedKey === key) output[key] = visit(fields(input)[key], depth + 1)
      }
      return output
    }
    return null
  }
  return { value: visit(value, 0), truncated }
}

function errorFacts(event: ReadingEvent): Record<string, Json> {
  const d = fields(event.data), message = fields(d.message), reason = fields(d.reason)
  const error = d.error ?? reason.error ?? d.failure
  const failed = d.isError === true || message.isError === true || error !== undefined || d.kind === 'error' || d.outcome === 'failed'
    || (event.type === 'hook/result' && typeof d.exitCode === 'number' && d.exitCode !== 0)
  if (!failed) return {}
  const facts: Record<string, Json> = { error_observed: true, error_seq: event.seq }
  const code = fields(error).code
  if (typeof code === 'string') facts.error_code = code
  return facts
}

function locator(event: ReadingEvent): Record<string, Json> {
  const d = fields(event.data), result: Record<string, Json> = {}
  for (const key of ['turn', 'step', 'callId', 'subCallId', 'rootCallId', 'parentCallId',
    'compactionId', 'retryId', 'runId', 'commandId', 'id', 'headerSeq', 'sourceCommandId', 'childId', 'childCreatedAt', 'messageId']) {
    const value = d[key]
    if (typeof value === 'string' || typeof value === 'number') result[key] = value
  }
  const message = event.type === 'user/message' ? d : fields(d.message)
  const source = fields(message.source)
  if (typeof message.id === 'string') result.message_id = message.id
  if (typeof message.role === 'string') result.role = message.role
  if (typeof source.kind === 'string') result.source_kind = source.kind
  const id = toolIdentity(event)
  if (id !== undefined) result.call_id = id
  if (event.type.startsWith('tool-workflow/agent-') && typeof d.seq === 'number') result.agent_seq = d.seq
  return result
}

function messageBlocks(content: unknown, eventType: string, view: ProjectionOptions['view'], budget: ProjectionBudget, omitToolCalls: boolean, onTruncated: () => void) {
  const blocks = Array.isArray(content) ? content : []
  const visible: unknown[] = [], toolChanges: Json[] = [], toolCalls: Json[] = []
  let inspected = 0
  for (; inspected < blocks.length && inspected < budget.maxNodes && inspected < budget.maxItems; inspected++) {
    const block = fields(blocks[inspected])
    if (block.type === 'tool-addition' || block.type === 'tool-removal')
      toolChanges.push({ type: block.type, toolName: block.toolName as string })
    if (block.type === 'tool-call') toolCalls.push({ call_id: block.id as string, name: block.name as string })
    if (block.type === 'reasoning' || (omitToolCalls && block.type === 'tool-call')) continue
    if (view === 'detail' || eventType === 'developer/message' || visible.length === 0) visible.push(blocks[inspected])
    else onTruncated()
  }
  if (inspected < blocks.length) onTruncated()
  return { visible, toolChanges, toolCalls }
}

function previewFields(event: ReadingEvent, view: ProjectionOptions['view'], messagePreview?: unknown): unknown {
  const d = fields(event.data), message = fields(d.message)
  const strategy = EVENT_PROJECTION_STRATEGIES[event.type] ?? 'bounded-fact'
  if (strategy === 'message') {
    const content = event.type === 'user/message' ? d.content : message.content
    const source = event.type === 'user/message' ? d.source : message.source
    return { role: event.type === 'user/message' ? d.role : message.role, source, content: messagePreview, empty: Array.isArray(content) && content.length === 0,
      interrupted: d.interrupted, usage: view === 'detail' ? d.usage : undefined }
  }
  if (strategy === 'attempt') return { committed_message: false, turn: d.turn, step: d.step, stream_observed: Array.isArray(d.stream) && d.stream.length > 0 }
  if (strategy === 'tool') return { arguments: d.arguments, content: event.type === 'tool/result' ? message.content : d.content, error: d.error, meta: view === 'detail' ? d.meta : undefined }
  if (strategy === 'summary') return { summary: d.summary, shadowedSeqs: d.shadowedSeqs, shadowedRange: d.shadowedRange,
    shadowedTokenCount: d.shadowedTokenCount, token_estimate: true, provider: d.provider, model: d.model, usage: d.usage }
  if (strategy === 'prune') return { shadowedSeqs: d.shadowedSeqs, shadowedRange: d.shadowedRange, shadowedTokenCount: d.shadowedTokenCount, token_estimate: true }
  if (strategy === 'request' && event.type === 'request/header') {
    const header = fields(d.header)
    return { reason: d.reason, startsSeries: d.startsSeries, config: header.config, tools: header.tools, adapterDefaults: view === 'detail' ? header.adapterDefaults : undefined }
  }
  return d
}

interface ProjectedRecord {
  [key: string]: Json | undefined
  seq: number
  type: string
  read_seq: number
  preview?: Json
}
interface ProjectedTool {
  [key: string]: Json | ProjectedTool[] | undefined
  call_id: string
  source_seqs: number[]
  read_seqs: number[]
  children?: ProjectedTool[]
  arguments?: Json
  result?: Json
  error?: Json
}

export interface EventProjection {
  activity_id?: string
  kind?: string
  requested_seq?: number
  read_scope: 'target' | 'activity'
  source_seqs: number[]
  page_source_seqs: number[]
  activity_locator?: { activity_id?: string; root_call_id?: string; parent_call_id?: string }
  records: ProjectedRecord[]
  tools: ProjectedTool[]
  complete: boolean
  incomplete_reasons: string[]
  truncated: boolean
}

function project(model: EventAssociation, events: readonly ReadingEvent[], tools: readonly AssociatedTool[],
  expandChildren: boolean, options: ProjectionOptions, activity?: AssociatedActivity, requestedSeq?: number, finish?: (output: EventProjection) => void): EventProjection {
  const omitted: (() => void)[] = []
  const output: EventProjection = { activity_id: activity?.id, kind: activity?.kind, requested_seq: requestedSeq,
    read_scope: activity ? 'activity' : 'target', source_seqs: [],
    page_source_seqs: [], records: [], tools: [], complete: false, incomplete_reasons: [], truncated: false }
  const sourceSeqs = new Set<number>()
  const reasons = new Set([...(options.evidence?.incompleteReasons ?? []), ...(activity?.toolGaps ?? [])])
  const addPreview = (value: unknown, set: (value: Json) => void, remove: () => void) => {
    if (value === undefined) return
    const bounded = bound(value, options.budget)
    output.truncated ||= bounded.truncated
    set(bounded.value)
    omitted.push(remove)
  }
  for (const event of events) {
    sourceSeqs.add(event.seq)
    const record: ProjectedRecord = { seq: event.seq, type: event.type, read_seq: event.seq,
      strategy: EVENT_PROJECTION_STRATEGIES[event.type] ?? 'bounded-fact', ...locator(event), ...errorFacts(event) }
    const d = fields(event.data)
    const observedTool = model.toolBySeq.get(event.seq)
    if (observedTool && !observedTool.call) reasons.add('call_not_observed')
    if (observedTool && !observedTool.result) reasons.add('result_not_observed')
    if (options.view === 'compact' && (d.meta !== undefined || d.usage !== undefined)) output.truncated = true
    for (const key of ['outcome', 'stopReason', 'kind', 'isError']) {
      const value = d[key]
      if (typeof value === 'string' || typeof value === 'boolean') record[key] = value
    }
    const reasonKind = fields(d.reason).kind
    if (typeof reasonKind === 'string') record.reason_kind = reasonKind
    if (event.type === 'system/message') {
      const content = fields(d.message).content
      record.empty = Array.isArray(content) && content.length === 0
    }
    let messagePreview: unknown
    if (EVENT_PROJECTION_STRATEGIES[event.type] === 'message') {
      const content = event.type === 'user/message' ? d.content : fields(d.message).content
      const blocks = messageBlocks(content, event.type, options.view, options.budget, expandChildren, () => { output.truncated = true })
      messagePreview = blocks.visible
      if (blocks.toolChanges.length) record.tool_changes = blocks.toolChanges
      if (blocks.toolCalls.length) record.tool_calls = blocks.toolCalls
      if (model.limitedBlockSeqs.has(event.seq)) output.truncated = true
    }
    if (event.type.startsWith('tool-workflow/agent-')) record.member_seq_is_not_session_seq = true
    if (event.type === 'subagent/catalog') record.discovery_only = true
    if (event.type === 'llm/retry-started') record.retry_started_is_not_success = true
    if (event.sourceEventSeqs) record.source_event_seqs = [...event.sourceEventSeqs]
    if (event.surfaceOp) record.surface_op = event.surfaceOp === 'append' ? 'append' : { ...event.surfaceOp }
    // Paired execution content belongs to the tool node, not a duplicate record preview.
    if (!(EVENT_PROJECTION_STRATEGIES[event.type] === 'tool' && tools.length))
      addPreview(previewFields(event, options.view, messagePreview), value => { record.preview = value }, () => { delete record.preview })
    output.records.push(record)
  }
  let renderedNodes = 0
  const renderTool = (tool: AssociatedTool, depth: number): ProjectedTool => {
    renderedNodes++
    const evidence = [...tool.blockEvents, ...(tool.call ? [tool.call] : []), ...(tool.result ? [tool.result] : [])]
    const seqs = [...new Set(evidence.map(event => event.seq))].sort((a, b) => a - b)
    seqs.forEach(seq => sourceSeqs.add(seq))
    const node: ProjectedTool = { call_id: tool.id, name: tool.name, parent_call_id: tool.parentId, root_call_id: tool.rootId,
      source_seqs: seqs, read_seqs: seqs, start_seq: tool.call?.seq, result_seq: tool.result?.seq,
      execution_observed: Boolean(tool.call || tool.result), result_observed: Boolean(tool.result) }
    if (!tool.call) reasons.add(tool.blockEvents.length ? 'execution_not_observed' : 'call_not_observed')
    if (!tool.result) reasons.add('result_not_observed')
    const callData = fields(tool.call?.data)
    const argumentsEvidence = tool.call ? callData.arguments
      : tool.result?.type === 'tool/ptc-dispatch' ? fields(tool.result.data).arguments : tool.block?.arguments
    if (options.view === 'detail') addPreview(argumentsEvidence, value => { node.arguments = value }, () => { delete node.arguments })
    else if (argumentsEvidence !== undefined) output.truncated = true
    if (tool.result) {
      const d = fields(tool.result.data), message = fields(d.message)
      node.is_error = tool.result.type === 'tool/result' ? message.isError === true : d.isError === true
      Object.assign(node, errorFacts(tool.result))
      const content = tool.result.type === 'tool/result' ? message.content : d.content
      let resultPreview = content
      if (options.view === 'compact' && Array.isArray(content)) {
        const count = Math.min(content.length, 1, options.budget.maxItems, options.budget.maxNodes)
        resultPreview = content.slice(0, count)
        if (count < content.length) output.truncated = true
      }
      addPreview(resultPreview, value => { node.result = value }, () => { delete node.result })
      if (options.view === 'detail') {
        addPreview(d.error, value => { node.error = value }, () => { delete node.error })
        addPreview(d.meta, value => { node.meta = value }, () => { delete node.meta })
      } else if (d.error !== undefined || d.meta !== undefined) output.truncated = true
    }
    if (expandChildren && tool.children.length) {
      if (depth >= options.budget.maxDepth) output.truncated = true
      else node.children = renderTools(tool.children, depth + 1)
    }
    return node
  }
  const renderTools = (nodes: readonly AssociatedTool[], depth: number): ProjectedTool[] => {
    const rendered: ProjectedTool[] = []
    let i = 0
    for (; i < nodes.length && i < options.budget.maxItems && renderedNodes < options.budget.maxNodes; i++)
      rendered.push(renderTool(nodes[i], depth))
    if (i < nodes.length) output.truncated = true
    return rendered
  }
  output.tools = renderTools(tools, 0)
  output.source_seqs = [...sourceSeqs].sort((a, b) => a - b)
  output.page_source_seqs = (options.evidence?.pageSourceSeqs ?? []).filter(seq => sourceSeqs.has(seq))
  if (activity && !options.evidence?.coverageComplete) reasons.add('activity_coverage_unproven')
  if (expandChildren && activity) {
    const pairs: Partial<Record<AssociatedActivity['kind'], readonly string[]>> = {
      step: ['step/start', 'step/end'], turn: ['turn/start', 'turn/end'],
      compaction: ['compaction/start', 'compaction/end'], retry: ['llm/retry', 'llm/retry-started'],
      workflow: ['tool-workflow/run-start', 'tool-workflow/run-end'],
      command: ['command/run', 'command/done'], approval: ['approval/asked', 'approval/decided'],
    }
    const pair = pairs[activity.kind]
    if (pair && pair.some(type => !events.some(event => event.type === type))) reasons.add('lifecycle_pair_not_observed')
    if (activity.kind === 'workflow') {
      const members = new Map<number, Set<string>>()
      for (const event of events) {
        if (!event.type.startsWith('tool-workflow/agent-')) continue
        const seq = fields(event.data).seq
        if (typeof seq !== 'number') continue
        const types = members.get(seq) ?? new Set<string>()
        types.add(event.type)
        members.set(seq, types)
      }
      if ([...members.values()].some(types => types.size < 2)) reasons.add('workflow_member_pair_not_observed')
    }
    if (activity.kind === 'ptc-fragment') reasons.add('root_not_observed')
  }
  if (!expandChildren) {
    const targetTool = tools[0]
    // A known locator does not require reading the parent's body or its other children.
    if (targetTool) output.activity_locator = { activity_id: targetTool.activityId,
      root_call_id: targetTool.rootId, parent_call_id: targetTool.parentId }
  }
  output.incomplete_reasons = [...reasons]
  output.complete = reasons.size === 0
  finish?.(output)
  const bytes = () => Buffer.byteLength(JSON.stringify(output), 'utf8')
  // Identity, seqs, topology and already observed failure facts are never budget casualties.
  while (bytes() > options.budget.outputBytes && omitted.length) {
    omitted.pop()!()
    output.truncated = true
  }
  if (bytes() > options.budget.outputBytes) throw new Error('Projection metadata exceeds outputBytes; reduce the requested page or scope')
  return output
}

/** Project one shared activity without changing its identities at either density. */
export function projectActivity(model: EventAssociation, activity: AssociatedActivity, options: ProjectionOptions): EventProjection {
  const anchor = activity.events[0]
  if (activity.events.length === 1 && model.originalResultByReplacement.has(anchor.seq))
    return projectOne(model, anchor.seq, options, activity)
  return project(model, activity.events, activity.tools, true, options, activity)
}

function projectOne(model: EventAssociation, seq: number, options: ProjectionOptions, activity?: AssociatedActivity): EventProjection {
  const event = model.events.get(seq)
  if (!event) throw new Error(`Requested seq ${seq} was not supplied`)
  let tool = model.toolBySeq.get(seq)
  const originalSeq = model.originalResultByReplacement.get(seq)
  let resolvedOriginalSeq: number | undefined
  const references: ReadingEvent[] = []
  if (originalSeq !== undefined) {
    let reference = originalSeq
    // Only same-call single-node references lead back to an actual append result.
    for (let depth = 0; depth < Math.min(options.budget.maxDepth, options.budget.maxNodes); depth++) {
      const original = model.events.get(reference)
      if (original?.type !== 'tool/result' || toolIdentity(original) !== toolIdentity(event)) break
      references.push(original)
      if (original.surfaceOp === 'append') {
        tool = model.toolBySeq.get(reference)
        resolvedOriginalSeq = reference
        break
      }
      const next = model.originalResultByReplacement.get(reference)
      if (next === undefined) break
      reference = next
    }
  }
  return project(model, [event, ...references], tool ? [tool] : [], false, options, activity, activity ? undefined : seq, output => {
    if (originalSeq !== undefined) {
      output.records[0].original_result_seq = resolvedOriginalSeq ?? originalSeq
      if (!tool) {
        output.complete = false
        output.incomplete_reasons.push('original_result_not_observed')
      }
    }
    const associated = model.activityBySeq.get(seq)
    if (!output.activity_locator && associated && associated.kind !== 'event') output.activity_locator = { activity_id: associated.id }
  })
}

/** Project only the requested record or tool pair; never expand parents, siblings or children. */
export function projectTarget(model: EventAssociation, seq: number, options: ProjectionOptions): EventProjection {
  return projectOne(model, seq, options)
}
