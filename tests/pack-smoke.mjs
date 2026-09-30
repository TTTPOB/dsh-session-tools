import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'dsh-session-tools-pack-'))
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'session-tools-smoke', private: true, type: 'module' }))
  const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  execFileSync('pnpm', ['pack', '--pack-destination', root], { cwd: source, stdio: 'pipe' })
  execFileSync('pnpm', ['--config.auto-install-peers=false', 'add',
    join(root, `dsh-session-tools-${version}.tgz`),
    '@deepseek-ai/cordis@4.0.4', '@deepseek-ai/dsh-tools@0.1.7-rc.2',
    '@deepseek-ai/dsh-session-query@0.1.7-rc.2', '@deepseek-ai/dsh-session@0.1.7-rc.2',
    '@deepseek-ai/dsh-session-projection@0.1.7-rc.2', '@deepseek-ai/schemastery@3.18.4',
    ...['agent','ptc-runtime','invariants','llm','scope','system-prompt','user-approval','sandbox','sandbox-policy'].map(x => `@deepseek-ai/dsh-${x}@0.1.7-rc.2`),
  ], { cwd: root, stdio: 'pipe' })
  const hostRequire = createRequire(join(root, 'package.json'))
  const pluginPath = hostRequire.resolve('dsh-session-tools')
  const pluginRequire = createRequire(pluginPath)
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-session-projection']) {
    assert.equal(realpathSync(pluginRequire.resolve(name)), realpathSync(hostRequire.resolve(name)), `shared peer ${name}`)
  }
  const entry = await import(pluginPath)
  assert.equal(entry.name, 'dsh-session-tools')
  assert.equal(typeof entry.apply, 'function')
  console.log('Packaging-only smoke passed with explicitly installed peers; this is NOT Host-provided profile-peer validation. Run deploy/activate.test.mjs and --check-only against the consuming profile.')
} finally { rmSync(root, { recursive: true, force: true }) }
