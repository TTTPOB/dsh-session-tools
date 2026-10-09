import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'

// Producer-shaped, contiguous history shared by executor and Loader composition tests.
export function appendReadingHistory(session, children = 100) {
  session.append('turn/start', { turn: 1 })
  const start = session.append('step/start', { turn: 1, step: 1 })
  const root = ToolCallId('reading-root')
  const call = session.append('tool/call', { turn: 1, step: 1, callId: root, name: 'run_code', arguments: '{"code":"catch child error"}' })
  let failed
  for (let i = 0; i < children; i++) {
    const identity = { subCallId: `reading-child-${i}`, parentCallId: root, rootCallId: root, name: 'read', arguments: { file_path: `file-${i}` } }
    const begin = session.append('tool/ptc-dispatch-start', identity)
    const end = session.append('tool/ptc-dispatch', { ...identity, isError: i === 42,
      content: [{ type: 'text', text: i === 42 ? '文件不存在😀' : 'ok' }],
      ...(i === 42 ? { error: { name: 'FileError', code: 'FS_NOT_FOUND', reason: '文件不存在😀'.repeat(100) } } : {}),
    })
    if (i === 42) failed = { start: begin.seq, result: end.seq }
  }
  const diagnostic = session.append('todo/write', { todos: [{ content: 'independent diagnostic', status: 'pending' }] })
  for (let i = 1; i < 10; i++) session.append('todo/write', { todos: [] })
  const resultData = { turn: 1, step: 1, message: createToolResultMessage({ callId: root, content: [{ type: 'text', text: 'parent succeeded after catching child failure' }], isError: false }) }
  const result = session.append('tool/result', resultData, { surfaceOp: 'append' })
  const end = session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const replacement = session.append('tool/result', { ...resultData, message: { ...resultData.message, content: [{ type: 'text', text: 'PRUNED' }] } },
    { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq, diagnostic.seq] })
  return { start: start.seq, call: call.seq, result: result.seq, end: end.seq, replacement: replacement.seq, failed }
}

export function readingContract(page) {
  const activity = page.activities[0]
  const root = activity.tools[0]
  const failed = root.children.find(child => child.is_error)
  return {
    captured_through_seq: page.captured_through_seq,
    activity_id: activity.activity_id,
    page_source_seqs: activity.page_source_seqs,
    source_seqs: activity.source_seqs,
    complete: activity.complete,
    root: { call_id: root.call_id, start_seq: root.start_seq, result_seq: root.result_seq, is_error: root.is_error, child_count: root.children.length },
    failed: { call_id: failed.call_id, start_seq: failed.start_seq, result_seq: failed.result_seq, is_error: failed.is_error, error_code: failed.error_code },
    has_more: page.has_more,
    next_after_seq: page.next_after_seq,
  }
}
