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
    name: 'dsh-session-tools', version: '0.1.3', type: 'module', main: 'dist/index.js',
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
  [script, ...(checkOnly ? ['--check-only'] : []), f.home, f.source ?? f.tarball, f.version ?? '0.1.3', f.host, ...(selected ? [selected] : [])], { encoding: 'utf8' })

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

test('activated check-only preserves patch and manifest', () => {
  const f = fixture()
  try {
    assert.equal(run(f).status, 0)
    const patch = join(f.home, 'cordis.patch.yml')
    const manifest = join(f.home, 'profiles/web/package.json')
    const beforePatch = readFileSync(patch, 'utf8')
    const beforeManifest = readFileSync(manifest, 'utf8')
    const result = run(f, undefined, true)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(patch, 'utf8'), beforePatch)
    assert.equal(readFileSync(manifest, 'utf8'), beforeManifest)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('activated check-only accepts removed old dependency', () => {
  const f = fixture()
  try {
    assert.equal(run(f).status, 0)
    const manifest = join(f.home, 'profiles/web/package.json')
    const web = JSON.parse(readFileSync(manifest, 'utf8'))
    delete web.dependencies['dsh-session-search-pro']
    put(manifest, JSON.stringify(web))
    const before = readFileSync(manifest, 'utf8')
    const result = run(f, undefined, true)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(manifest, 'utf8'), before)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('new global row conflicts with old Web bundle', () => {
  const f = fixture()
  try {
    const patch = join(f.home, 'cordis.patch.yml')
    put(patch, readFileSync(patch, 'utf8') + '\n- insert:\n    - id: session-tools\n      name: dsh-session-tools\n')
    const before = readFileSync(patch, 'utf8')
    for (const checkOnly of [false]) {
      const result = run(f, undefined, checkOnly)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /both declared/)
      assert.equal(readFileSync(patch, 'utf8'), before)
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('repeated activation rejects without changing configuration', () => {
  const f = fixture()
  try {
    assert.equal(run(f).status, 0)
    const patch = join(f.home, 'cordis.patch.yml')
    const manifest = join(f.home, 'profiles/web/package.json')
    const beforePatch = readFileSync(patch, 'utf8')
    const beforeManifest = readFileSync(manifest, 'utf8')
    const result = run(f)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /already declared/)
    assert.equal(readFileSync(patch, 'utf8'), beforePatch)
    assert.equal(readFileSync(manifest, 'utf8'), beforeManifest)
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

test('Release-source preflight checks exact source and installed version without legacy migration gates', () => {
  const f = fixture()
  try {
    f.source = 'https://github.com/TTTPOB/dsh-session-tools/releases/download/v0.1.3/dsh-session-tools-0.1.3.tgz'
    const path = join(f.home, 'profiles/web/package.json')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    data.dependencies = { 'dsh-session-tools': f.source }
    data.dsh.profile.bundles = []
    put(path, JSON.stringify(data))
    put(join(f.home, 'cordis.patch.yml'), '- insert:\n    - id: official\n      name: "@deepseek-ai/dsh-tool-session-query"\n')
    const before = readFileSync(path, 'utf8')
    assert.equal(run(f, undefined, true).status, 0)
    f.version = '0.1.4'
    const mismatch = run(f, undefined, true)
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /installed plugin identity differs/)
    f.version = '0.1.3'
    f.source = f.source.replace('v0.1.3/', 'other-tag/')
    const wrongSource = run(f, undefined, true)
    assert.equal(wrongSource.status, 1)
    assert.match(wrongSource.stderr, /different Release source/)
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.equal(existsSync(join(f.home, 'backups')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('built plugin under Host-provided profile peers executes session_list after Release preflight', async () => {
  const f = fixture()
  try {
    const source = resolve(import.meta.dirname, '..')
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    execFileSync('pnpm', ['pack', '--pack-destination', f.root], { cwd: source, stdio: 'pipe' })
    f.version = manifest.version
    f.source = `https://github.com/TTTPOB/dsh-session-tools/releases/download/v${manifest.version}/dsh-session-tools-${manifest.version}.tgz`
    const profile = join(f.home, 'profiles/web/package.json')
    rmSync(join(f.home, 'profiles/web/node_modules/dsh-session-tools'))
    put(profile, JSON.stringify({ private: true, type: 'module', dsh: { profile: { bundles: [] } } }))
    const installSource = process.env.DSH_TEST_PLUGIN_SOURCE ?? join(f.root, `dsh-session-tools-${manifest.version}.tgz`)
    execFileSync('pnpm', ['--config.auto-install-peers=false', '--ignore-workspace', 'add', installSource], { cwd: join(f.home, 'profiles/web'), stdio: 'pipe' })
    const installed = JSON.parse(readFileSync(profile, 'utf8'))
    assert.deepEqual(Object.keys(installed.dependencies), ['dsh-session-tools'])
    // Offline regression uses the current tarball; an explicit Release input verifies URL installation too.
    if (process.env.DSH_TEST_PLUGIN_SOURCE) assert.equal(installed.dependencies['dsh-session-tools'], f.source)
    else installed.dependencies['dsh-session-tools'] = f.source
    put(profile, JSON.stringify(installed))
    const result = run(f, undefined, true)
    assert.equal(result.status, 0, result.stderr)
    // The child owns the resolver hooks and all plugin registrations.
    const driver = join(f.root, 'behavior.mjs')
    put(driver, `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const anchor = realpathSync(${JSON.stringify(f.host)});
const req = createRequire(anchor);
const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')));
const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')));
const resolution = await createRuntimeResolution({ installAnchor: anchor, profile: loadProfileDirectory('built test', ${JSON.stringify(join(f.home, 'profiles/web'))}, anchor), home: ${JSON.stringify(f.home)} });
const ctx = new Context();
try {
 await ctx.plugin(PluginPackages, { resolution });
 const tools = new Map();
 ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } });
 ctx.provide('workspaceRegistry', { archivedSessionIds: [] });
 ctx.provide('sessionProjections', { stateOf: () => ({ lastStepStartSeq: 3 }) });
 let calls = 0;
 ctx.provide('sessionQuery', { pageSessions: async () => { calls++; return { items: [] } }, pageEvents: async () => ({ items: [] }), observeSession: async () => { throw new Error('session_list must not observe logs') } });
 const plugin = await import(pathToFileURL(${JSON.stringify(join(f.home, 'profiles/web/node_modules/dsh-session-tools/dist/index.js'))}));
 await ctx.plugin(plugin, {});
 const result = await tools.get('session_list').execute({}, { signal: new AbortController().signal, agent: { session: { id: 'caller', header: { cwd: '/fixture' } } } });
 assert.deepEqual(result, { items: [], has_more: false, next_cursor: null });
 assert.equal(calls, 1);
 await ctx.fiber.dispose();
 assert.equal(tools.size, 0);
} finally { await ctx.fiber.dispose() }
`);
    const behavior = spawnSync(process.execPath, [driver], { encoding: 'utf8' })
    assert.equal(behavior.status, 0, behavior.stderr)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
