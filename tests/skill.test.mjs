import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import Skills from '@deepseek-ai/dsh-skill'
import * as plugin from '../dist/index.js'

const run = promisify(execFile)
const words = 'connection refused'
const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

function history(session, text, isError, nested = false) {
  const callId = 'invoke-' + session.id
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const user = session.append('user/message', message(text), { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, name: 'bash', callId, arguments: '{"command":"make"}' })
  if (nested) {
    const child = { rootCallId: callId, parentCallId: callId, subCallId: callId + ':ptc:1', name: 'read', arguments: { path: 'fixture.txt' } }
    session.append('tool/ptc-dispatch-start', child)
    session.append('tool/ptc-dispatch', { ...child, isError: true, content: [{ type: 'text', text: 'File missing' }] })
  }
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: isError ? 'Build failed' : 'Built' }], isError }),
    ...(isError ? { error: { name: 'ToolError', code: 'BUILD_ERROR', reason: 'make failed' } } : {}),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: 'completed' })
  return user
}

test('all eight bundled examples run against real synthetic SQLite-backed sessions', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-skill-'))
  const socket = join(root, 's.sock')
  const ctx = new Context()
  try {
    ctx.provide('profileContext', { home: root, name: 'fixture' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteSessionQuery, { path: join(root, 'index.db') })
    await ctx.plugin(ShellEnv, { dshHome: root })
    await ctx.plugin(Skills)
    await ctx.plugin(plugin, { socketPath: socket })
    const main = ctx.sessions.create('fixture-main', { meta: { cwd: '/workspace', createdAt: 1 } })
    const second = ctx.sessions.create('fixture-second', { meta: { cwd: '/second', createdAt: 2 } })
    ctx.sessions.create('fixture-child', { meta: { cwd: '/workspace', createdAt: 3, parentSession: main.id, origin: 'subagent' } })
    const user = history(main, words, true, true)
    history(second, 'successful build', false)
    const skill = await ctx.skills.get('session-stream')
    const scripts = [...skill.content.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(match => match[1])
    const env = { ...process.env, DSH_SESSION_STREAM: socket, SESSION: main.id, SECOND_SESSION: second.id, QUERY: '"' + words + '"', TURN: '1', SEQ: String(user.seq) }
    const outputs = []
    for (const script of scripts) {
      const { stdout } = await run('bash', ['-c', script], { env, timeout: 5000 })
      // The examples return either one pretty-printed JSON value or compact NDJSON lines.
      outputs.push(stdout.trim().startsWith('[\n') || stdout.trim().startsWith('{\n')
        ? [JSON.parse(stdout)] : stdout.trim().split('\n').map(line => JSON.parse(line)))
    }
    assert.equal(outputs.length, 8)
    const [search, users, failures, calls, raw, around, [rates], [tree]] = outputs
    assert.deepEqual(search.map(hit => hit.session_id), [main.id])
    assert.deepEqual(users.map(event => event.content), [user.data.content])
    assert.deepEqual(failures.map(err => [err.name, err.arguments, err.content[0].text]), [
      ['read', { path: 'fixture.txt' }, 'File missing'], ['bash', '{"command":"make"}', 'Build failed'],
    ])
    assert.equal(failures[1].error.reason, 'make failed')
    assert.deepEqual(calls.map(call => [call.name, call.arguments]), [['bash', { command: 'make' }], ['read', { path: 'fixture.txt' }]])
    assert.deepEqual(raw, [{ ...user, session_id: main.id }])
    assert.ok(around.some(event => event.seq === user.seq && event.data.content[0].text === words))
    assert.deepEqual(rates, [
      { name: 'bash', calls: 2, settled: 2, errors: 1, error_rate: 0.5 },
      { name: 'read', calls: 1, settled: 1, errors: 1, error_rate: 1 },
    ])
    assert.equal(tree.target, main.id)
    assert.deepEqual(tree.children, [{ id: 'fixture-child', children: [] }])

    const searchEvents = async (...filters) => {
      const { stdout } = await run('curl', ['-sS', '--fail-with-body', '--unix-socket', socket, '--get',
        'http://localhost/search', '--data-urlencode', 'q=build', '--data-urlencode', 'group=event',
        ...filters.flatMap(filter => ['--data-urlencode', filter]),
      ])
      return new Set(stdout.trim().split('\n').map(line => JSON.parse(line).sessionId))
    }
    assert.deepEqual(await searchEvents(), new Set([main.id, second.id]))
    assert.deepEqual(await searchEvents('session=' + main.id), new Set([main.id]))
    assert.deepEqual(await searchEvents('session=' + main.id, 'session=' + second.id, 'cwd=/second'), new Set([second.id]))
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
