/** Fixed-cut, bounded evidence acquisition through the public observation API. */
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { associateEvents, fields, originalResultReference, toolIdentity, type ReadingEvent, type AssociatedActivity } from './event-association.js'
import type { EventProjection, ProjectionEvidence, ProjectionBudget } from './event-projection.js'
import type { JsonValue } from './shared.js'

/** Provisional working limits; local-history calibration is a separate task. */
export interface ReaderBudget {
  readBatchSize: number
  supplementalEvents: number
  processingBytes: number
  seqSpan: number
}

/** Measure retained JSON work without first serializing an unbounded payload. */
function processingSize(value: unknown, ceiling: number): number {
  let bytes = 0
  const visit = (input: unknown, depth: number): void => {
    if (bytes > ceiling) return
    if (typeof input === 'string') { bytes += Buffer.byteLength(input, 'utf8') + 2; return }
    bytes += 8
    if (input === null || typeof input !== 'object') return
    if (depth >= 128) { bytes = ceiling + 1; return }
    if (Array.isArray(input)) {
      for (let i = 0; i < input.length && bytes <= ceiling; i++) visit(input[i], depth + 1)
    } else {
      for (const key in input) {
        if (!Object.hasOwn(input, key)) continue
        visit(key, depth + 1)
        visit(fields(input)[key], depth + 1)
        if (bytes > ceiling) break
      }
    }
  }
  visit(value, 0)
  return bytes
}

const yieldScan = () => new Promise<void>(resolve => setImmediate(resolve))
const boundaries: Partial<Record<AssociatedActivity['kind'], readonly [string, string]>> = {
  step: ['step/start', 'step/end'], turn: ['turn/start', 'turn/end'],
  compaction: ['compaction/start', 'compaction/end'], retry: ['llm/retry', 'llm/retry-started'],
  workflow: ['tool-workflow/run-start', 'tool-workflow/run-end'],
  command: ['command/run', 'command/done'], approval: ['approval/asked', 'approval/decided'],
}

/** One reader borrows one caller-owned lease and never accesses observation.events. */
export class BoundedReader {
  readonly events = new Map<number, ReadingEvent>()
  private supplementalCount = 0
  private bytes = 0
  private readonly refused = new Set<number>()
  private readonly reasons = new Set<string>()

  constructor(private readonly observation: SessionObservation, private readonly budget: ReaderBudget,
    private readonly signal: AbortSignal, private readonly associationBudget: ProjectionBudget) {}

  get cut(): number { return this.observation.cursor }

  private range(from: number, to: number): readonly ReadingEvent[] {
    this.signal.throwIfAborted()
    return this.observation.readEvents(SessionLogOffset(Math.max(0, from)), SessionLogOffset(Math.min(this.cut + 1, to)))
  }

  private admit(event: ReadingEvent, primary: boolean): boolean {
    this.signal.throwIfAborted()
    if (this.events.has(event.seq)) return true
    if (this.refused.has(event.seq)) return false
    if (!primary && this.supplementalCount >= this.budget.supplementalEvents) {
      this.refused.add(event.seq)
      this.reasons.add('supplemental_events_exhausted')
      return false
    }
    const remaining = this.budget.processingBytes - this.bytes
    const bytes = processingSize(event, remaining)
    const reason = bytes > remaining ? 'processing_bytes_exhausted' : undefined
    if (reason) {
      if (primary) throw new Error(`Event ${event.seq} exceeds the reading budget (${reason}); narrow the page or use explicit Raw`)
      this.refused.add(event.seq)
      this.reasons.add(reason)
      return false
    }
    this.bytes += bytes
    if (!primary) this.supplementalCount++
    this.events.set(event.seq, event)
    return true
  }

  /** Select original-event anchors and prove continuation against this same cut. */
  async page(after: number, limit: number, types?: readonly string[], metadata = false) {
    const selected: ReadingEvent[] = []
    const filter = types === undefined ? undefined : new Set(types)
    let hasMore = false
    for (let from = after + 1; from <= this.cut && !hasMore;) {
      const to = Math.min(this.cut + 1, from + this.budget.readBatchSize)
      for (const event of this.range(from, to)) {
        this.signal.throwIfAborted()
        if (filter && !filter.has(event.type)) continue
        if (selected.length === limit) { hasMore = true; break }
        if (!metadata) this.admit(event, true)
        selected.push(event)
      }
      from = to
      if (from <= this.cut && !hasMore) await yieldScan()
    }
    this.signal.throwIfAborted()
    return { selected, hasMore, nextAfterSeq: hasMore ? selected.at(-1)!.seq : null }
  }

  /** Read the exact requested seq, including replacements, without changing its identity. */
  target(seq: number): ReadingEvent {
    const event = this.range(seq, seq + 1)[0]
    if (!event || event.seq !== seq) throw new RangeError(`Requested seq ${seq} is outside the captured observation`)
    this.admit(event, true)
    return event
  }

  private supplement(seq: number, anchors: readonly number[]): boolean {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.cut) return false
    if (this.events.has(seq)) return true
    if (!anchors.some(anchor => Math.abs(seq - anchor) <= this.budget.seqSpan)) {
      this.reasons.add('seq_span_exhausted'); return false
    }
    const event = this.range(seq, seq + 1)[0]
    return event?.seq === seq && this.admit(event, false)
  }

  private references(events: readonly ReadingEvent[], anchors: readonly number[]): void {
    for (const event of events) {
      // Reference traversal is bounded independently of how many refs the producer stored.
      const refs = event.sourceEventSeqs ?? []
      const count = Math.min(refs.length, this.budget.supplementalEvents)
      for (let i = 0; i < count; i++) this.supplement(refs[i]!, anchors)
      const header = fields(event.data).headerSeq
      if (typeof header === 'number') this.supplement(header, anchors)
      const original = originalResultReference(event)
      if (original !== undefined) this.supplement(original, anchors)
    }
  }

  /** Pair only the target tool; scanning other event references does not expand their bodies. */
  async completeTarget(event: ReadingEvent): Promise<void> {
    const anchors = [event.seq]
    const original = originalResultReference(event)
    if (original !== undefined) this.supplement(original, anchors)
    const initial = associateEvents([...this.events.values()], this.associationBudget)
    const targetTool = initial.toolBySeq.get(original ?? event.seq)
    const id = targetTool?.id
    if (id === undefined) { this.references([event], anchors); return }
    const paired = () => {
      const model = associateEvents([...this.events.values()], this.associationBudget)
      const tool = model.toolBySeq.get(original ?? event.seq)
      return Boolean(tool?.call && tool.result)
    }
    if (paired()) return
    await this.nearby(anchors, candidate => {
      if (toolIdentity(candidate) === id && fields(candidate.surfaceOp).op !== 'replace') this.admit(candidate, false)
    }, paired)
  }

  private async nearby(anchors: readonly number[], consume: (event: ReadingEvent) => void, done: () => boolean): Promise<void> {
    if (!anchors.length) return
    const ranges = anchors.map(seq => ({ left: seq, right: seq + 1,
      min: Math.max(0, seq - this.budget.seqSpan), max: Math.min(this.cut + 1, seq + this.budget.seqSpan + 1) }))
    const scanned = new Set<number>()
    while (!done()) {
      let advanced = false
      for (const range of ranges) {
        for (const direction of ['left', 'right'] as const) {
          const from = direction === 'left' ? Math.max(range.min, range.left - this.budget.readBatchSize) : range.right
          const to = direction === 'left' ? range.left : Math.min(range.max, range.right + this.budget.readBatchSize)
          if (from >= to) continue
          advanced = true
          for (const event of this.range(from, to)) {
            if (scanned.has(event.seq)) continue
            scanned.add(event.seq)
            consume(event)
            this.signal.throwIfAborted()
          }
          range[direction] = direction === 'left' ? from : to
          await yieldScan()
          this.signal.throwIfAborted()
          if (done()) return
          if (this.reasons.has('processing_bytes_exhausted') || this.reasons.has('supplemental_events_exhausted')) return
        }
      }
      if (!advanced) { this.reasons.add('seq_span_exhausted'); return }
    }
  }

  private missingReferences(events: readonly ReadingEvent[]): boolean {
    return events.some(event => {
      const refs = event.sourceEventSeqs ?? []
      if (refs.length > this.budget.supplementalEvents) return true
      if (refs.some(seq => !this.events.has(seq))) return true
      const header = fields(event.data).headerSeq
      return typeof header === 'number' && !this.events.has(header)
    })
  }

  /** Complete means both real lifecycle endpoints and every intermediate raw event were admitted. */
  evidence(activity: AssociatedActivity, pageSourceSeqs: readonly number[]): ProjectionEvidence {
    const pair = boundaries[activity.kind]
    let start: number | undefined, end: number | undefined
    if (pair) {
      start = activity.events.find(event => event.type === pair[0])?.seq
      end = activity.events.find(event => event.type === pair[1])?.seq
    } else if (activity.kind === 'tool') {
      start = activity.tools[0]?.call?.seq
      end = activity.tools[0]?.result?.seq
    } else if (activity.kind === 'event') start = end = activity.events[0]?.seq
    let covered = start !== undefined && end !== undefined && start <= end
    if (covered) {
      for (let seq = start!; seq <= end!; seq++) {
        if (!this.events.has(seq)) { covered = false; break }
      }
    }
    const missing = this.missingReferences(activity.events)
    return { pageSourceSeqs, coverageComplete: covered && !missing,
      incompleteReasons: [
        ...covered ? [] : [activity.kind === 'step' ? 'step_coverage_unproven' : 'activity_coverage_unproven'],
        ...missing ? ['reference_not_observed'] : [],
        ...covered && !missing ? [] : [...this.reasons],
      ] }
  }

  /** Expand only activities touched by the original page, using shared association to determine membership. */
  async completeActivities(anchors: readonly number[]): Promise<void> {
    const complete = () => {
      const model = associateEvents([...this.events.values()], this.associationBudget)
      return anchors.every(seq => {
        const activity = model.activityBySeq.get(seq)
        return activity && this.evidence(activity, anchors).coverageComplete
      })
    }
    for (const seq of anchors) {
      const event = this.events.get(seq)!
      if (originalResultReference(event) !== undefined) await this.completeTarget(event)
    }
    this.references([...this.events.values()], anchors)
    if (complete()) return
    await this.nearby(anchors, event => { this.admit(event, false) }, complete)
    // Resolve explicit references found in the expanded local interval, within the same budgets.
    this.references([...this.events.values()], anchors)
  }

  targetEvidence(event: ReadingEvent): ProjectionEvidence {
    // Tool-pair completeness belongs to projectTarget; parent/root bodies are not required.
    const missing = toolIdentity(event) === undefined && this.missingReferences([event])
    return { pageSourceSeqs: [event.seq], incompleteReasons: missing ? ['reference_not_observed', ...this.reasons] : [] }
  }
}

/** Atomically fit the final wrapped page, preserving identity, error facts, anchors and cursor. */
export function commitReadingPage(page: object, projections: readonly EventProjection[], outputBytes: number): Record<string, JsonValue> {
  let json = ''
  const fits = () => { json = JSON.stringify(page); return Buffer.byteLength(json, 'utf8') <= outputBytes }
  if (fits()) return JSON.parse(json) as Record<string, JsonValue>
  const removable: Array<() => void> = []
  const visit = (node: Record<string, unknown>, projection: EventProjection): void => {
    for (const key of ['preview', 'arguments', 'result', 'error', 'meta']) {
      if (node[key] !== undefined) removable.push(() => { delete node[key]; projection.truncated = true })
    }
    if (Array.isArray(node.children)) for (const child of node.children) visit(fields(child), projection)
  }
  for (const projection of projections) {
    for (const record of projection.records) visit(record, projection)
    for (const tool of projection.tools) visit(tool, projection)
  }
  while (!fits() && removable.length) removable.pop()!()
  if (!fits()) throw new Error('Reading page metadata exceeds outputBytes; lower limit and retry from the same after_seq, or narrow read_scope; no partial result was returned')
  return JSON.parse(json) as Record<string, JsonValue>
}
