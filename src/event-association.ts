/** Pure association of already accepted, locally read session events. No log access. */
export interface ReadingEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
}

/** Narrow only the extensible JSON fields consumed by this reader. */
export function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export interface AssociatedTool {
  id: string
  name?: string
  parentId?: string
  rootId?: string
  blockEvents: ReadingEvent[]
  block?: Record<string, unknown>
  call?: ReadingEvent
  result?: ReadingEvent
  children: AssociatedTool[]
  activityId?: string
}

export interface AssociatedActivity {
  id: string
  kind: 'step' | 'turn' | 'compaction' | 'workflow' | 'retry' | 'command' | 'approval' | 'tool' | 'event' | 'ptc-fragment'
  events: ReadingEvent[]
  tools: AssociatedTool[]
  toolGaps: Set<string>
}

export interface EventAssociation {
  events: Map<number, ReadingEvent>
  activities: AssociatedActivity[]
  activityBySeq: Map<number, AssociatedActivity>
  toolBySeq: Map<number, AssociatedTool>
  tools: Map<string, AssociatedTool>
  /** Only explicit, single-target tool-result replacements; never interval summaries. */
  originalResultByReplacement: Map<number, number>
  limitedBlockSeqs: Set<number>
}

export function stepIdentity(event: ReadingEvent): string | undefined {
  const d = fields(event.data)
  return typeof d.turn === 'number' && typeof d.step === 'number'
    ? `step:${d.turn}:${d.step}` : undefined
}

export function toolIdentity(event: ReadingEvent): string | undefined {
  const d = fields(event.data)
  const id = event.type.startsWith('tool/ptc-') ? d.subCallId
    : event.type === 'tool/result' ? fields(fields(d.message).source).callId : d.callId
  return typeof id === 'string' ? id : undefined
}

/** A replacement reference is not an execution or a contiguous raw seq interval. */
export function originalResultReference(event: ReadingEvent): number | undefined {
  const op = event.surfaceOp
  const refs = event.sourceEventSeqs
  if (event.type === 'tool/result' && op && op !== 'append'
    && op.startSeq === op.endSeq && refs?.includes(op.startSeq)) return op.startSeq
  return undefined
}

function lifecycle(event: ReadingEvent): [AssociatedActivity['kind'], string] | undefined {
  const d = fields(event.data)
  if (event.type.startsWith('compaction/') && typeof d.compactionId === 'string')
    return ['compaction', `compaction:${d.compactionId}`]
  if (event.type.startsWith('tool-workflow/') && typeof d.runId === 'string')
    return ['workflow', `workflow:${d.runId}`]
  if (event.type.startsWith('llm/retry') && typeof d.retryId === 'string')
    return ['retry', `retry:${d.retryId}`]
  if (event.type.startsWith('command/') && typeof d.commandId === 'string')
    return ['command', `command:${d.commandId}`]
  if (event.type.startsWith('approval/') && typeof d.id === 'string')
    return ['approval', `approval:${d.id}`]
  if (event.type.startsWith('turn/') && typeof d.turn === 'number')
    return ['turn', `turn:${d.turn}`]
  return undefined
}

/**
 * Associate only supplied evidence, using explicit IDs and direct PTC parents.
 * @param input Accepted events from one fixed observation, including any bounded supplemental reads.
 * @param budget Existing display limits for inspecting message blocks and diagnostic sources.
 * @returns Shared identities for both densities; missing records remain missing, not running.
 */
export function associateEvents(input: readonly ReadingEvent[], budget: { maxItems: number; maxNodes: number }): EventAssociation {
  const events = new Map(input.map(event => [event.seq, event]))
  const ordered = [...events.values()].sort((a, b) => a.seq - b.seq)
  const activities = new Map<string, AssociatedActivity>()
  const activityBySeq = new Map<number, AssociatedActivity>()
  const toolBySeq = new Map<number, AssociatedTool>()
  const tools = new Map<string, AssociatedTool>()
  const originalResultByReplacement = new Map<number, number>()
  const limitedBlockSeqs = new Set<number>()
  const getActivity = (id: string, kind: AssociatedActivity['kind']) => {
    let activity = activities.get(id)
    if (!activity) { activity = { id, kind, events: [], tools: [], toolGaps: new Set() }; activities.set(id, activity) }
    return activity
  }
  const getTool = (id: string) => {
    let tool = tools.get(id)
    if (!tool) { tool = { id, blockEvents: [], children: [] }; tools.set(id, tool) }
    return tool
  }
  for (const event of ordered) {
    const d = fields(event.data)
    const message = fields(d.message)
    const replacement = event.surfaceOp !== undefined && event.surfaceOp !== 'append'
    const ref = originalResultReference(event)
    if (ref !== undefined) originalResultByReplacement.set(event.seq, ref)
    if (!replacement && event.type === 'assistant/message' && Array.isArray(message.content)) {
      let inspected = 0
      for (; inspected < message.content.length && inspected < budget.maxNodes && inspected < budget.maxItems; inspected++) {
        const block = fields(message.content[inspected])
        if (block.type !== 'tool-call' || typeof block.id !== 'string') continue
        const tool = getTool(block.id)
        tool.blockEvents.push(event)
        tool.block ??= block
        if (typeof block.name === 'string') tool.name = block.name
        tool.activityId ??= stepIdentity(event)
      }
      if (inspected < message.content.length) limitedBlockSeqs.add(event.seq)
    }
    const id = toolIdentity(event)
    if (!replacement && id !== undefined && ['tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type)) {
      const tool = getTool(id)
      if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') tool.call ??= event
      else tool.result ??= event
      if (typeof d.name === 'string') tool.name = d.name
      if (typeof d.parentCallId === 'string') tool.parentId = d.parentCallId
      if (typeof d.rootCallId === 'string') tool.rootId = d.rootCallId
      tool.activityId ??= stepIdentity(event)
      toolBySeq.set(event.seq, tool)
    }
  }
  // Resolve only a complete direct-parent path to an observed ordinary root.
  const resolveActivity = (tool: AssociatedTool, seen = new Set<string>()): string | undefined => {
    if (!tool.rootId) return tool.activityId
    if (seen.has(tool.id)) return undefined
    seen.add(tool.id)
    const parent = tool.parentId ? tools.get(tool.parentId) : undefined
    const root = tools.get(tool.rootId)
    if (!parent || !root || root.rootId || !(root.call?.type === 'tool/call' || root.result?.type === 'tool/result')) return undefined
    if (parent.id !== root.id && parent.rootId !== root.id) return undefined
    return resolveActivity(parent, seen)
  }
  for (const tool of tools.values()) {
    tool.activityId = resolveActivity(tool)
    const parent = tool.parentId ? tools.get(tool.parentId) : undefined
    if (parent && tool.rootId && (parent.id === tool.rootId || parent.rootId === tool.rootId)) {
      // An orphan direct tree remains a fragment; never attach it to an unrelated Step.
      parent.children.push(tool)
    }
  }
  for (const event of ordered) {
    const tool = toolBySeq.get(event.seq)
    let activity: AssociatedActivity
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
      // A summary replacement may cite the compaction start/summary, but never a tool outcome.
      let cited: ReadingEvent | undefined
      const refs = event.sourceEventSeqs ?? []
      for (let i = 0; i < Math.min(refs.length, budget.maxNodes); i++) {
        const source = events.get(refs[i])
        if (source?.type === 'compaction/summary' || source?.type === 'compaction/start') { cited = source; break }
      }
      const identity = cited && event.type === 'user/message' ? lifecycle(cited) : undefined
      activity = identity ? getActivity(identity[1], identity[0]) : getActivity(`event:${event.seq}`, 'event')
    } else if (tool?.rootId) {
      let fragment = tool
      const seen = new Set<string>()
      while (fragment.parentId && !seen.has(fragment.id)) {
        seen.add(fragment.id)
        const parent = tools.get(fragment.parentId)
        if (!parent || parent.rootId !== tool.rootId) break
        fragment = parent
      }
      activity = tool.activityId ? getActivity(tool.activityId, 'step')
        : getActivity(`ptc:${fragment.id}`, 'ptc-fragment')
    } else if (tool) {
      activity = tool.activityId ? getActivity(tool.activityId, 'step') : getActivity(`tool:${tool.id}`, 'tool')
    } else {
      const identity = lifecycle(event)
      const step = stepIdentity(event)
      const stepMember = ['step/start', 'step/end', 'assistant/message', 'assistant/attempt',
        'developer/message', 'system/message', 'tool/call', 'tool/result'].includes(event.type)
      activity = identity ? getActivity(identity[1], identity[0])
        : step && stepMember ? getActivity(step, 'step') : getActivity(`event:${event.seq}`, 'event')
    }
    if (limitedBlockSeqs.has(event.seq)) activity.toolGaps.add('tool_blocks_not_fully_associated')
    activity.events.push(event)
    activityBySeq.set(event.seq, activity)
  }
  for (const tool of tools.values()) {
    const evidence = tool.call ?? tool.result ?? tool.blockEvents[0]
    if (!evidence) continue
    const activity = activityBySeq.get(evidence.seq)!
    if (!tool.call) activity.toolGaps.add(tool.blockEvents.length ? 'execution_not_observed' : 'call_not_observed')
    if (!tool.result) activity.toolGaps.add('result_not_observed')
    if (!tool.parentId || !tools.has(tool.parentId) || activityBySeq.get((tools.get(tool.parentId)!.call ?? tools.get(tool.parentId)!.result)?.seq ?? -1) !== activity)
      activity.tools.push(tool)
  }
  const start = (tool: AssociatedTool) => tool.call?.seq ?? tool.blockEvents[0]?.seq ?? tool.result?.seq ?? Infinity
  for (const tool of tools.values()) tool.children.sort((a, b) => start(a) - start(b))
  return { events, activities: [...activities.values()].sort((a, b) => a.events[0].seq - b.events[0].seq),
    activityBySeq, toolBySeq, tools, originalResultByReplacement, limitedBlockSeqs }
}
