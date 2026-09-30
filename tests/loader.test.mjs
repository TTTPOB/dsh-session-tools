import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as plugin from '../dist/index.js'

test('real Cordis Loader mounts built ESM through cordis.yml then disposes tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-tools-loader-'))
  const configPath = join(root, 'cordis.yml')
  const tools = new Map()
  const ctx = new Context()
  try {
    await writeFile(configPath, "- name: 'dsh-session-tools'\n")
    ctx.baseUrl = pathToFileURL(root).href + '/'
    ctx.provide('tools', { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } })
    ctx.provide('sessionProjections', { stateOf: () => ({ lastStepStartSeq: 3 }) })
    ctx.provide('sessionQuery', { listSessions: async () => [] })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = { version: 'v2', async import(specifier) {
      assert.equal(specifier, 'dsh-session-tools')
      return plugin
    } }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    assert.equal(tools.size, 7)
    assert.equal(typeof tools.get('session_search').execute, 'function')
    await ctx.fiber.dispose()
    assert.equal(tools.size, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
