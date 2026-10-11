import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const forkNames = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-session-query-sqlite']
const forkPackages = forkNames.map(name => {
  const spec = manifest.devDependencies[name]
  assert.match(spec, /^https:\/\/github\.com\/TTTPOB\/deepseek-harness\/releases\/download\/[^/]+\/[^/]+\.tgz$/, `immutable artifact for ${name}`)
  return spec
})
const root = mkdtempSync(join(tmpdir(), 'dsh-session-tools-pack-'))
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'session-tools-smoke', private: true, type: 'module' }))
  const { version } = manifest
  execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'pack', '--pack-destination', root], { cwd: source, stdio: 'pipe' })
  const archive = execFileSync('tar', ['-tzf', join(root, `dsh-session-tools-${version}.tgz`)], { encoding: 'utf8' })
  assert.doesNotMatch(archive, /context-map/, 'package must not contain retired map implementation or declarations')
  execFileSync('pnpm', ['--config.verify-deps-before-run=false', '--config.auto-install-peers=false', 'add',
    join(root, `dsh-session-tools-${version}.tgz`),
    '@deepseek-ai/cordis@4.0.4', '@deepseek-ai/dsh-tools@0.1.7-rc.2',
    ...forkPackages, '@deepseek-ai/dsh-workspace@0.1.7-rc.2',
    '@deepseek-ai/dsh-session-projection@0.1.7-rc.2', '@deepseek-ai/schemastery@3.18.4',
    ...['agent','ptc-runtime','invariants','llm','scope','system-prompt','user-approval','sandbox','sandbox-policy','session-title','tool-todo','session-persistence'].map(x => `@deepseek-ai/dsh-${x}@0.1.7-rc.2`),
  ], { cwd: root, stdio: 'pipe' })
  const hostRequire = createRequire(join(root, 'package.json'))
  const { pluginUrl, mapError } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `let mapError
     try { import.meta.resolve('dsh-session-tools/context-map') } catch (error) { mapError = error.code }
     console.log(JSON.stringify({ pluginUrl: import.meta.resolve('dsh-session-tools'), mapError }))`,
  ], { cwd: root, encoding: 'utf8' }))
  assert.equal(mapError, 'ERR_PACKAGE_PATH_NOT_EXPORTED')
  const pluginPath = fileURLToPath(pluginUrl)
  const pluginRequire = createRequire(pluginPath)
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-workspace']) {
    assert.equal(realpathSync(pluginRequire.resolve(name)), realpathSync(hostRequire.resolve(name)), `shared peer ${name}`)
  }
  for (const name of forkNames) {
    const installed = JSON.parse(readFileSync(hostRequire.resolve(`${name}/package.json`), 'utf8'))
    assert.equal(installed.name, name)
    assert.ok(manifest.devDependencies[name].endsWith(`-${installed.version}.tgz`), `artifact version for ${name}`)
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
  const installedManifest = JSON.parse(readFileSync(join(dirname(pluginPath), '..', 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(installedManifest.exports), ['.'])
  assert.equal(installedManifest.peerDependencies['@deepseek-ai/dsh-token-meter'], undefined)
  assert.deepEqual(Object.keys(entry).sort(), ['Config', 'apply', 'inject', 'name'])
  console.log('Packaging-only smoke passed with explicitly installed peers; this is NOT Host-provided profile-peer validation. Run deploy/activate.test.mjs and --check-only against the consuming profile.')
} finally { rmSync(root, { recursive: true, force: true }) }
