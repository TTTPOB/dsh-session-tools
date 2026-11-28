import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as plugin from '../dist/index.js'

const names = ['session', 'session-query-sqlite', 'skill', 'shell-env', 'subprocess-local', 'bash-local', 'tool-bash']

test('Loader starts a private profile socket, contributes a skill and injects Bash; unload removes all three', async t => {
  const root = await mkdtemp(join(tmpdir(), 'session-stream-loader-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const profile = { home: root, name: 'synthetic', dir: root, installAnchor: root }
  ctx.provide('profileContext', profile)
  ctx.provide('systemPrompt', { section() {}, getSectionOrder: () => 0 })
  ctx.provide('workingDirectory', { ensure: () => root })
  const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  const modules = new Map(await Promise.all(names.map(async name => [name, await import('@deepseek-ai/dsh-' + name)])))
  modules.set(plugin.name, plugin)
  const configPath = join(root, 'cordis.yml')
  const socket = join(root, 'run', 'session-stream-synthetic.sock')
  const config = names.map(name => '- id: ' + name + '\n  name: ' + name + (name === 'session-query-sqlite' ? '\n  config: ' + JSON.stringify({ path: join(root, 'synthetic.sqlite') }) : ''))
  config.push('- id: stream\n  name: ' + plugin.name)
  await writeFile(configPath, config.join('\n') + '\n')
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier) { return modules.get(specifier) } }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  assert.equal((await stat(join(root, 'run'))).mode & 0o777, 0o700)
  assert.equal((await stat(socket)).mode & 0o777, 0o600)
  assert.match((await ctx.skills.get('session-stream')).content, /# Read DSH session history/)
  assert.deepEqual([...tools.keys()], ['bash'])
  const session = ctx.sessions.create('live-ram', { meta: { createdAt: 1, cwd: root } })
  const text = 'A running session without a persistence provider'
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const user = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  const bash = async command => {
    const result = await tools.get('bash').execute({ command, description: 'Inspect test bash environment' }, {
      name: 'bash', agent: { session }, signal: new AbortController().signal,
    })
    assert.equal(result.exitCode, 0, result.stderr.text)
    return result.stdout.text
  }
  assert.equal(await bash('printf %s "$DSH_SESSION_STREAM"'), socket)
  const raw = await bash('curl -sS --fail-with-body --unix-socket "$DSH_SESSION_STREAM" "http://localhost/events?session=$DSH_SESSION_ID&types=user/message"')
  assert.deepEqual(JSON.parse(raw), { ...user, session_id: session.id })

  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'stream')
  await entry.update({ disabled: true })
  await ctx.loader.await()
  await assert.rejects(stat(socket), { code: 'ENOENT' })
  assert.equal(await ctx.skills.get('session-stream'), undefined)
  assert.equal(await bash('printf %s "${DSH_SESSION_STREAM-unset}"'), 'unset')
  const override = join(root, 'custom', 'override.sock')
  await entry.update({ disabled: false, config: { socketPath: override } })
  await ctx.loader.await()
  assert.equal(await bash('printf %s "$DSH_SESSION_STREAM"'), override)
  assert.ok((await stat(override)).isSocket())
})
