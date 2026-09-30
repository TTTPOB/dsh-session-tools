import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = resolve(import.meta.dirname, 'activate.mjs')
const profiles = ['web', 'headless', 'paper-chew']
const shared = ['dsh-progressive-tools', 'dsh-workspace-overlay', 'dsh-workspace-envrc', '@firecrawl/dsh-firecrawl', 'dsh-mcp-panel']
const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
const pkg = (dir, name, peerDependencies = {}) => {
  put(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, type: 'module', main: 'dist/index.js', peerDependencies }))
  put(join(dir, 'node_modules', name, 'dist/index.js'), 'export const apply = () => {}\n')
}
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'session-tools-deploy-'))
  const home = join(root, 'home')
  const tarball = join(root, 'plugin.tgz')
  const host = join(root, 'host/package.json')
  put(tarball, '')
  put(host, '{"name":"host"}')
  put(join(home, 'cordis.patch.yml'), '- insert:\n    - id: example\n      name: example\n')
  for (const name of profiles) {
    const dir = join(home, 'profiles', name)
    const dependencies = { 'dsh-session-search-pro': 'old', 'dsh-session-tools': `file:${join(root, 'plugin.tgz')}` }
    for (const sharedName of shared) { dependencies[sharedName] = '1.0.0'; pkg(dir, sharedName) }
    pkg(dir, 'dsh-session-tools')
    put(join(dir, 'package.json'), JSON.stringify({ dependencies, dsh: { profile: { bundles: ['base', 'dsh-session-search-pro'] } } }))
  }
  return { root, home, tarball, host }
}
const run = (f, selected) => spawnSync(process.execPath, [script, f.home, f.tarball, f.host, ...(selected ? [selected] : [])], { encoding: 'utf8' })

test('activation succeeds after preflight and keeps old dependency', () => {
  const f = fixture()
  try {
    const result = run(f)
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8'), /name: dsh-session-tools/)
    const web = JSON.parse(readFileSync(join(f.home, 'profiles/web/package.json'), 'utf8'))
    assert(!web.dsh.profile.bundles.includes('dsh-session-search-pro'))
    assert(web.dependencies['dsh-session-search-pro'])
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('default Web-only selection ignores unmigrated headless', () => {
  const f = fixture()
  try {
    const path = join(f.home, 'profiles/headless/package.json')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    delete data.dependencies[shared[0]]
    put(path, JSON.stringify(data))
    const result = run(f)
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8'), /name: dsh-session-tools/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('relative file spec resolves against profile', () => {
  const f = fixture()
  try {
    for (const name of profiles) {
      const path = join(f.home, 'profiles', name, 'package.json')
      const data = JSON.parse(readFileSync(path, 'utf8'))
      data.dependencies['dsh-session-tools'] = 'file:../../../plugin.tgz'
      put(path, JSON.stringify(data))
    }
    const result = run(f)
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8'), /name: dsh-session-tools/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('duplicate Cordis peer fails before modifying config', () => {
  const f = fixture()
  try {
    const profile = join(f.home, 'profiles/web')
    pkg(profile, 'dsh-session-tools', { '@deepseek-ai/cordis': '*' })
    pkg(join(f.root, 'host'), '@deepseek-ai/cordis')
    pkg(profile, '@deepseek-ai/cordis')
    const before = readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8')
    const result = run(f)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /different copy than Host/)
    assert.equal(readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8'), before)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('missing shared dependency fails before modifying config', () => {
  const f = fixture()
  try {
    const path = join(f.home, 'profiles/headless/package.json')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    delete data.dependencies[shared[0]]
    put(path, JSON.stringify(data))
    const before = readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8')
    const result = run(f, 'web,headless')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /missing explicit dependency/)
    assert.equal(readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8'), before)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
