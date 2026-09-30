import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const script = resolve(import.meta.dirname, 'activate.mjs')
const profiles = ['web', 'headless', 'paper-chew']
const shared = ['dsh-progressive-tools', 'dsh-workspace-overlay', 'dsh-workspace-envrc', '@firecrawl/dsh-firecrawl', 'dsh-mcp-panel']
const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
const hostRoot = execFileSync('pnpm', ['root', '-g'], { encoding: 'utf8' }).trim()
const host = process.env.DSH_TEST_HOST_MANIFEST ?? readdirSync(hostRoot)
  .map(name => join(hostRoot, name, 'node_modules/@deepseek-ai/dsh/package.json'))
  .find(existsSync)
if (!host) throw new Error('DSH_TEST_HOST_MANIFEST or installed global DSH is required for deployment tests')
const pkg = (dir, name) => {
  put(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, type: 'module', main: 'dist/index.js' }))
  put(join(dir, 'node_modules', name, 'dist/index.js'), 'export const apply = () => {}\n')
}
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'session-tools-deploy-'))
  const home = join(root, 'home')
  const tarball = join(root, 'plugin.tgz')
  const plugin = join(root, 'plugin')
  put(tarball, '')
  put(join(plugin, 'package.json'), JSON.stringify({
    name: 'dsh-session-tools', type: 'module', main: 'dist/index.js',
    peerDependencies: { '@deepseek-ai/cordis': '*', '@deepseek-ai/dsh-tools': '*', '@deepseek-ai/schemastery': '*' },
  }))
  put(join(plugin, 'dist/index.js'), "import { defineTool } from '@deepseek-ai/dsh-tools'; import Schema from '@deepseek-ai/schemastery'; export const name = 'dsh-session-tools'; export const apply = () => {}; export const Config = Schema.object({ pageSize: Schema.number().min(1).default(30), maxPageSize: Schema.number().default(100) }); export const sharedTool = defineTool;\n")
  put(join(home, 'cordis.patch.yml'), '- insert:\n    - id: example\n      name: example\n')
  for (const name of profiles) {
    const dir = join(home, 'profiles', name)
    const dependencies = { 'dsh-session-search-pro': 'old', 'dsh-session-tools': `file:${tarball}` }
    for (const sharedName of shared) { dependencies[sharedName] = '1.0.0'; pkg(dir, sharedName) }
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    symlinkSync(plugin, join(dir, 'node_modules', 'dsh-session-tools'), 'dir')
    put(join(dir, 'package.json'), JSON.stringify({ dependencies, dsh: { profile: { bundles: ['dsh-session-search-pro'] } } }))
  }
  return { root, home, tarball, host, plugin }
}
const run = (f, selected, checkOnly = false) => spawnSync(process.execPath,
  [script, ...(checkOnly ? ['--check-only'] : []), f.home, f.tarball, f.host, ...(selected ? [selected] : [])], { encoding: 'utf8' })

test('read-only preflight imports through Host peers absent from profile direct dependencies', () => {
  const f = fixture()
  try {
    const web = join(f.home, 'profiles/web/package.json')
    assert.equal(JSON.parse(readFileSync(web, 'utf8')).dependencies['@deepseek-ai/dsh-tools'], undefined)
    const bare = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(f.plugin, 'dist/index.js'))})`], { encoding: 'utf8' })
    assert.notEqual(bare.status, 0, 'bare Node must not accidentally provide the peer')
    const original = readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8')
    const manifestBefore = readFileSync(web, 'utf8')
    const result = run(f, undefined, true)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Read-only DSH profile preflight passed/)
    assert.equal(readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8'), original)
    assert.equal(readFileSync(web, 'utf8'), manifestBefore)
    assert.equal(existsSync(join(f.home, 'backups')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('activation succeeds only after profile preflight', () => {
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
    const result = run(f, undefined, true)
    assert.equal(result.status, 0, result.stderr)
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
    const result = run(f, undefined, true)
    assert.equal(result.status, 0, result.stderr)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('Host peer takes precedence over a physical plugin-local Cordis copy', () => {
  const f = fixture()
  try {
    pkg(f.plugin, '@deepseek-ai/cordis')
    const before = readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8')
    const result = run(f, undefined, true)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8'), before)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('unavailable Host peer fails without installing a private copy', () => {
  const f = fixture()
  try {
    const manifest = join(f.plugin, 'package.json')
    const data = JSON.parse(readFileSync(manifest, 'utf8'))
    data.peerDependencies['@example/host-missing-service'] = '*'
    put(manifest, JSON.stringify(data))
    const before = readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8')
    const result = run(f, undefined, true)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Host does not provide shared peer/)
    assert.equal(readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8'), before)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('invalid Config fails before changing configuration', () => {
  const f = fixture()
  try {
    const entry = join(f.plugin, 'dist/index.js')
    put(entry, readFileSync(entry, 'utf8').replace('Schema.number().min(1).default(30)', 'Schema.number().min(1).default(0)'))
    const before = readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8')
    const result = run(f)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /pageSize expected number/)
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
