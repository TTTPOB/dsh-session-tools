import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const forkNames = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query']
const releaseDependencies = JSON.parse(readFileSync(join(source, '.github/release-dependencies.json'), 'utf8')).dependencies
const overrides = Object.fromEntries(Object.entries(releaseDependencies).map(([name, item]) => {
  assert.ok(item.source, `Missing verified Release source for ${name}`)
  return [name, item.source]
}))
const forkPackages = forkNames.map((name, index) => {
  const tarball = process.env[index === 0 ? 'DSH_SESSION_TARBALL' : 'DSH_QUERY_TARBALL']
  if (tarball) {
    assert.ok(tarball.startsWith('/') && tarball.endsWith('.tgz'), `absolute local tarball for ${name}`)
    overrides[name] = `file:${tarball}`
    return `${name}@file:${tarball}`
  }
  return `${name}@${overrides[name]}`
})
const env = { ...process.env, npm_config_verify_deps_before_run: 'false' }
const root = mkdtempSync(join(tmpdir(), 'dsh-session-tools-pack-'))
try {
  writeFileSync(join(root, 'pnpm-workspace.yaml'), JSON.stringify({ autoInstallPeers: false, overrides, allowBuilds: { koffi: false } }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'session-tools-smoke', private: true, type: 'module',
    devDependencies: { typescript: manifest.devDependencies.typescript, '@types/node': manifest.devDependencies['@types/node'] },
  }))
  const { version } = manifest
  execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'pack', '--pack-destination', root], { cwd: source, env, stdio: 'pipe' })
  execFileSync('pnpm', ['--config.verify-deps-before-run=false', '--config.auto-install-peers=false', 'add',
    join(root, `dsh-session-tools-${version}.tgz`),
    '@deepseek-ai/cordis@4.0.5', '@deepseek-ai/dsh-tools@0.2.1-rc.1',
    ...forkPackages, '@deepseek-ai/dsh-workspace@0.2.1-rc.1',
    '@deepseek-ai/dsh-session-projection@0.2.1-rc.1', '@deepseek-ai/schemastery@3.18.5',
    ...['agent','ptc-runtime','llm','scope','system-prompt','user-approval','sandbox','sandbox-policy','session-title','tool-todo','session-persistence'].map(x => `@deepseek-ai/dsh-${x}@0.2.1-rc.1`),
  ], { cwd: root, env, stdio: 'pipe' })
  const hostRequire = createRequire(join(root, 'package.json'))
  const pluginUrl = execFileSync(process.execPath, ['--input-type=module', '-e',
    "console.log(import.meta.resolve('dsh-session-tools'))",
  ], { cwd: root, env, encoding: 'utf8' }).trim()
  const pluginPath = fileURLToPath(pluginUrl)
  const pluginRequire = createRequire(pluginPath)
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-workspace']) {
    assert.equal(realpathSync(pluginRequire.resolve(name)), realpathSync(hostRequire.resolve(name)), `shared peer ${name}`)
  }
  for (const name of forkNames) {
    const installed = JSON.parse(readFileSync(hostRequire.resolve(`${name}/package.json`), 'utf8'))
    assert.equal(installed.name, name)
    assert.equal(installed.version, manifest.devDependencies[name], `artifact version for ${name}`)
    if (manifest.peerDependencies[name]) assert.equal(installed.version, manifest.peerDependencies[name], `exact peer ${name}`)
    await import(hostRequire.resolve(name))
  }
  const session = await import(hostRequire.resolve('@deepseek-ai/dsh-session'))
  assert.equal(typeof session.SurfaceFoldAccumulator, 'function', 'matching Session core export required by Query')
  const queryRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-session-query'))
  assert.equal(realpathSync(queryRequire.resolve('@deepseek-ai/dsh-session')), realpathSync(hostRequire.resolve('@deepseek-ai/dsh-session')), 'Query uses matching Session core')
  const entry = await import(pluginPath)
  assert.equal(entry.name, 'dsh-session-tools')
  assert.equal(typeof entry.apply, 'function')
  copyFileSync(join(source, 'tests', 'fixtures', 'config-consumer.mts'), join(root, 'config-consumer.mts'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true },
    include: ['config-consumer.mts'],
  }))
  execFileSync(process.execPath, [hostRequire.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: root, env, stdio: 'inherit' })
  console.log('Strict NodeNext TypeScript consumer passed against the installed package root.')
  const tools = new Map()
  let dispose
  entry.apply({
    sessionQuery: {
      async pageSessions(request) { assert.deepEqual(request.filters, [{ kind: 'cwd', values: ['/project'] }]); return { items: [] } },
      pageEvents() {}, observeSession() {}, captureSession() {},
    },
    tools: { register(tool) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    effect(fn) { dispose = fn() },
  }, entry.Config({}))
  const listed = await tools.get('session_list').execute({}, { signal: new AbortController().signal,
    agent: { session: { id: 'caller', header: { cwd: '/project' } } } })
  assert.deepEqual(listed, { items: [], has_more: false, next_cursor: null })
  dispose()
  assert.equal(tools.size, 0)
  console.log('Packaging-only smoke passed with explicitly installed peers; this is NOT Host-provided profile-peer validation. Run deploy/activate.test.mjs and --check-only against the consuming profile.')
} finally { rmSync(root, { recursive: true, force: true }) }
