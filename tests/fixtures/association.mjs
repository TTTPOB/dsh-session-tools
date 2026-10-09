// Small producer-shaped history covering related records and independent facts.
const surfaceTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const event = (seq, type, data, extra = {}) => ({ seq, type, data, ...(surfaceTypes.has(type) ? { surfaceOp: 'append' } : {}), ...extra })
let messageId = 0
const message = (role, content, source = role === 'assistant' ? { kind: 'model', provider: 'test', model: 'fixture' } : { kind: role === 'developer' ? 'tool-registry' : role }) => ({ role, id: `m-${messageId++}`, source, content })
const result = (seq, callId, content, extra = {}) => event(seq, 'tool/result', {
  turn: 1, step: 1, message: { ...message('tool', [{ type: 'text', text: content }], { kind: 'tool', callId }), toolCallId: callId, isError: false },
}, { sourceEventSeqs: [callId === 'second' ? 30 : 21], ...extra })

export const readDefinition = { name: 'read', description: 'Read a UTF-8 file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }

export const history = [
  event(9, 'request/header', { reason: 'change', header: {
    config: { provider: 'test', model: 'header-private-route' },
    tools: [readDefinition, { name: 'unrelated_tool', description: 'Unrelated definition', parameters: { type: 'object' } }],
    adapterDefaults: { privateOption: 'header-private-default' },
  } }),
  event(10, 'step/start', { turn: 1, step: 1 }),
  event(12, 'system/message', { turn: 1, step: 1, message: message('system', [], { kind: 'system-prompt' }) }),
  event(14, 'developer/message', { turn: 1, step: 1, headerSeq: 9, message: message('developer', [
    { type: 'tool-addition', toolName: 'read' }, { type: 'tool-removal', toolName: 'old_read' },
  ]) }),
  event(20, 'assistant/message', { turn: 1, step: 1, message: message('assistant', [
    { type: 'text', text: '检查配置' },
    { type: 'tool-call', id: 'root', name: 'run_code', arguments: 'model arguments' },
    { type: 'tool-call', id: 'second', name: 'read', arguments: 'second arguments' },
    { type: 'tool-call', id: 'undispatched', name: 'read', arguments: 'not executed' },
  ]), stream: [] }),
  event(21, 'tool/call', { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: 'execution arguments' }),
  event(22, 'tool/ptc-dispatch-start', { subCallId: 'a', rootCallId: 'root', parentCallId: 'root', name: 'run_code', arguments: { code: 'nested' } }),
  event(23, 'todo/write', { todos: [{ content: 'independent fact', status: 'pending' }] }),
  event(24, 'tool/ptc-dispatch-start', { subCallId: 'b', rootCallId: 'root', parentCallId: 'root', name: 'read', arguments: { file_path: 'other' } }),
  event(25, 'tool/ptc-dispatch-start', { subCallId: 'nested', rootCallId: 'root', parentCallId: 'a', name: 'read', arguments: { file_path: 'missing' } }),
  event(26, 'tool/ptc-dispatch', { subCallId: 'b', rootCallId: 'root', parentCallId: 'root', name: 'read', arguments: { file_path: 'other' }, isError: false, content: [{ type: 'text', text: 'other result' }] }),
  event(27, 'tool/ptc-dispatch', { subCallId: 'nested', rootCallId: 'root', parentCallId: 'a', name: 'read', arguments: { file_path: 'missing' }, isError: true,
    content: [{ type: 'text', text: '不存在' }, { type: 'text', text: 'second diagnostic block' }], error: { name: 'FileError', code: 'FS_NOT_FOUND', reason: 'long diagnostic '.repeat(100) } }),
  event(28, 'tool/ptc-dispatch', { subCallId: 'a', rootCallId: 'root', parentCallId: 'root', name: 'run_code', arguments: { code: 'nested' }, isError: false, content: [{ type: 'text', text: 'caught child error' }] }),
  event(30, 'tool/call', { turn: 1, step: 1, callId: 'second', name: 'read', arguments: 'actual second arguments' }),
  result(31, 'second', 'second original'),
  result(40, 'root', 'Original execution output 😀 '.repeat(100)),
  event(41, 'step/end', { turn: 1, step: 1 }),
  event(70, 'tool/ptc-dispatch-start', { subCallId: 'orphan', rootCallId: 'missing-root', parentCallId: 'missing-root', name: 'read', arguments: { file_path: 'orphan' } }),
  event(71, 'tool/ptc-dispatch-start', { subCallId: 'separate', rootCallId: 'missing-root', parentCallId: 'missing-parent', name: 'read', arguments: {} }),
  event(89, 'compaction/prune', { shadowedRange: { start: 40, end: 40 }, shadowedSeqs: [40], shadowedTokenCount: 100 }),
  result(90, 'root', 'PRUNED output', { surfaceOp: { op: 'replace', startSeq: 40, endSeq: 40 }, sourceEventSeqs: [40, 89] }),
  event(91, 'compaction/prune', { shadowedRange: { start: 90, end: 90 }, shadowedSeqs: [90], shadowedTokenCount: 20 }),
  result(92, 'root', 'PRUNED again', { surfaceOp: { op: 'replace', startSeq: 90, endSeq: 90 }, sourceEventSeqs: [90, 91] }),
  event(100, 'compaction/start', { compactionId: 'compact', turn: null }),
  event(101, 'compaction/summary', { compactionId: 'compact', summary: [{ type: 'text', text: 'SUMMARY, not execution output' }], shadowedSeqs: [20, 31, 92], shadowedRange: { start: 20, end: 92 }, shadowedTokenCount: 150, provider: 'test', model: 'fixture' }),
  event(102, 'user/message', { ...message('user', [{ type: 'text', text: 'summary checkpoint' }], { kind: 'compact-checkpoint', compactionId: 'compact' }) }, { surfaceOp: { op: 'replace', startSeq: 20, endSeq: 92 }, sourceEventSeqs: [100, 101, 20, 31, 92] }),
  event(103, 'compaction/end', { compactionId: 'compact', turn: null }),
  event(104, 'compaction/start', { compactionId: 'failed', turn: null }),
  event(105, 'compaction/end', { compactionId: 'failed', turn: null, error: 'summary failed' }),
  event(110, 'llm/retry', { retryId: 'retry-a', turn: 2, step: 1, provider: 'test', mode: 'normal', policyKey: 'rate-limit', retry: 1, maxRetries: 3, delayMs: 50, failure: { code: 'RATE_LIMIT', message: 'provider details', status: 429 } }),
  event(111, 'assistant/attempt', { turn: 2, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'provider details' } } } }] }),
  event(112, 'llm/retry-started', { retryId: 'retry-a', turn: 2, step: 1, retry: 1 }),
  event(120, 'tool-workflow/run-start', { runId: 'wf', name: 'analysis' }),
  event(121, 'tool-workflow/agent-start', { runId: 'wf', seq: 0, childId: 'child', label: 'part' }),
  event(123, 'tool-workflow/agent-end', { runId: 'wf', seq: 0, outcome: 'failed' }),
  event(124, 'tool-workflow/run-end', { runId: 'wf', stopReason: 'completed' }),
  event(130, 'subagent/catalog', { childId: 'child', childCreatedAt: 1000, label: 'part' }),
  event(140, 'extension/accepted', { important: 'unknown accepted data', locator: { seq: 123 } }),
  event(150, 'hook/invoked', { handlerId: 'hook', point: 'pre-step' }),
  event(151, 'hook/result', { handlerId: 'hook', point: 'pre-step', exitCode: 1, stderrSummary: 'failure' }),
]

// Instrument array access without changing any producer fields.
export function guardedBlocks(blocks, limit) {
  let visits = 0
  const content = new Proxy(blocks, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) {
      if (Number(key) >= limit) throw new Error('visited beyond the block budget')
      visits++
    }
    return Reflect.get(target, key, receiver)
  } })
  return { content, get visits() { return visits } }
}

export const compact = { view: 'compact', budget: { maxStringChars: 32, maxItems: 8, maxDepth: 5, maxNodes: 100, outputBytes: 30000 } }
export const detail = { view: 'detail', budget: { maxStringChars: 256, maxItems: 16, maxDepth: 8, maxNodes: 300, outputBytes: 50000 } }
