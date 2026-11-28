import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const release = JSON.parse(readFileSync(join(source, '.github/release-dependencies.json'), 'utf8'))
const forkNames = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query']
const localTarballs = { '@deepseek-ai/dsh-session': process.env.DSH_SESSION_TARBALL, '@deepseek-ai/dsh-session-query': process.env.DSH_QUERY_TARBALL }
const overrides = Object.fromEntries(forkNames.map(name => {
  const asset = localTarballs[name]
  if (asset !== undefined) {
    assert.ok(asset.startsWith('/') && asset.endsWith('.tgz') && existsSync(asset), `absolute local tarball for ${name}`)
    return [name, 'file:' + asset]
  }
  return [name, release.dependencies[name].source]
}))

const run = promisify(execFile)
const root = mkdtempSync(join(tmpdir(), 'dsh-session-tools-pack-'))
try {
  const storeDir = process.env.DSH_TEST_STORE_DIR ?? execFileSync('pnpm', ['store', 'path'], { cwd: source, encoding: 'utf8' }).trim()
  writeFileSync(join(root, 'pnpm-workspace.yaml'), JSON.stringify({ autoInstallPeers: false, blockExoticSubdeps: false, overrides, storeDir, allowBuilds: { koffi: false } }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'session-stream-smoke', private: true, type: 'module',
    devDependencies: { typescript: manifest.devDependencies.typescript, '@types/node': manifest.devDependencies['@types/node'] },
  }))
  const pnpm = (cwd, ...args) => execFileSync('pnpm', [
    '--config.verify-deps-before-run=false', ...args,
  ], { cwd, stdio: 'inherit' })
  pnpm(source, 'pack', '--pack-destination', root)
  pnpm(root, 'add',
    join(root, `dsh-session-tools-${manifest.version}.tgz`),
    ...Object.entries(manifest.peerDependencies).filter(([name]) => !forkNames.includes(name)).map(([name, version]) => `${name}@${version}`),
    ...forkNames.map(name => name + '@' + overrides[name]),
    ...['agent', 'brand', 'error', 'home-paths', 'http-proxy', 'llm', 'ptc-runtime', 'sandbox', 'sandbox-policy',
      'scope', 'session-persistence', 'session-title', 'shell', 'subprocess', 'system-prompt', 'tool-todo',
      'tools', 'user-approval'].map(x => '@deepseek-ai/dsh-' + x + '@' + release.baseline),
  )
  const hostRequire = createRequire(join(root, 'package.json'))
  const pluginPath = fileURLToPath(execFileSync(process.execPath, ['--input-type=module', '-e',
    "console.log(import.meta.resolve('dsh-session-tools'))",
  ], { cwd: root, encoding: 'utf8' }).trim())
  const pluginRequire = createRequire(pluginPath)
  for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-skill']) {
    assert.equal(realpathSync(pluginRequire.resolve(peer)), realpathSync(hostRequire.resolve(peer)), `shared peer ${peer}`)
  }
  for (const name of forkNames) {
    const installed = JSON.parse(readFileSync(hostRequire.resolve(`${name}/package.json`), 'utf8'))
    assert.equal(installed.name, name)
    if (localTarballs[name] === undefined) assert.equal(installed.version, release.dependencies[name].version)
    await import(hostRequire.resolve(name))
  }
  const entry = await import(pluginPath)
  const { Context } = await import(hostRequire.resolve('@deepseek-ai/cordis'))
  const { default: Skills } = await import(hostRequire.resolve('@deepseek-ai/dsh-skill'))
  const shellEnv = await import(hostRequire.resolve('@deepseek-ai/dsh-shell-env'))
  const ctx = new Context()
  try {
    ctx.provide('profileContext', { home: root, name: 'smoke' })
    const header = { id: 'smoke' }
    ctx.provide('sessionQuery', {
      async pageSessions() { return { items: [{ header, live: true, persisted: false }] } },
      async readTitleSnapshots() { return [{ status: 'fulfilled', value: { session: header, title: { title: 'Packaged fixture' } } }] },
    })
    await ctx.plugin(Skills)
    await ctx.plugin(shellEnv, { dshHome: root })
    const socketPath = join(root, 's.sock')
    await ctx.plugin(entry, { socketPath })
    const skill = await ctx.skills.get('session-stream')
    assert.match(skill.content, /Read DSH session history/)
    const { stdout } = await run('curl', ['-sS', '--fail-with-body', '--unix-socket', socketPath, 'http://localhost/sessions'])
    assert.deepEqual(JSON.parse(stdout), { header, live: true, persisted: false, title: 'Packaged fixture' })
    await ctx.fiber.dispose()
    assert.equal(existsSync(socketPath), false)
  } finally { await ctx.fiber.dispose() }
  copyFileSync(join(source, 'tests', 'fixtures', 'config-consumer.mts'), join(root, 'config-consumer.mts'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true },
    include: ['config-consumer.mts'],
  }))
  execFileSync(process.execPath, [hostRequire.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
  console.log('Packaged entry, bundled skill, Unix socket, shared peers and strict NodeNext consumer passed.')
} finally { rmSync(root, { recursive: true, force: true }) }
