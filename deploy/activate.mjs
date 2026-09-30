#!/usr/bin/env node
// Activate a preinstalled shared plugin without starting the Host.
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join, dirname, isAbsolute } from 'node:path'

const args = process.argv.slice(2)
const checkOnly = args[0] === '--check-only'
const [home, tarball, hostManifest, profileNames = 'web'] = checkOnly ? args.slice(1) : args
if (!home || !tarball || !isAbsolute(tarball) || !existsSync(tarball) || !hostManifest || !isAbsolute(hostManifest) || !existsSync(hostManifest)) {
  console.error('Usage: node activate.mjs [--check-only] /absolute/DSH_HOME /absolute/dsh-session-tools.tgz /absolute/installed-host/package.json [web,headless]')
  process.exit(2)
}
const profiles = profileNames.split(',')
if (!profiles.includes('web') || new Set(profiles).size !== profiles.length || profiles.some(name => !['web', 'headless', 'paper-chew'].includes(name))) {
  console.error('Profile selection must include web and use unique names from web,headless,paper-chew')
  process.exit(2)
}
const plugin = 'dsh-session-tools'
const shared = ['dsh-progressive-tools', 'dsh-workspace-overlay', 'dsh-workspace-envrc', '@firecrawl/dsh-firecrawl', 'dsh-mcp-panel']
const root = resolve(home)
const patch = join(root, 'cordis.patch.yml')
const webManifest = join(root, 'profiles/web/package.json')
const manifests = profiles.map(name => join(root, `profiles/${name}/package.json`))
const fail = message => { throw new Error(message) }
const read = path => readFileSync(path, 'utf8')
const parse = path => JSON.parse(read(path))

try {
  if (root === '/' || !lstatSync(root).isDirectory()) fail('DSH_HOME must be an existing directory')
  const tarballPath = realpathSync(tarball)
  // pnpm exposes a top-level link; its real package directory owns the Host dependencies.
  const hostAnchor = realpathSync(hostManifest)
  const hostReq = createRequire(hostAnchor)
  // Use the public boot package's profile resolver, not Node's unmodified package lookup.
  const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = await import(pathToFileURL(hostReq.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { Context } = await import(pathToFileURL(hostReq.resolve('@deepseek-ai/cordis')).href)
  const data = manifests.map(path => ({ path, json: parse(path) }))
  const web = data.find(item => item.path === webManifest).json
  const oldPatch = read(patch)
  if (!oldPatch.endsWith('\n')) fail('Home patch must end with a newline')
  if (/^\s*- id: session-tools\s*$/m.test(oldPatch) || /^\s*name: dsh-session-tools\s*$/m.test(oldPatch)) fail('Plugin already declared in home patch; no changes made')
  if (!web.dsh?.profile?.bundles?.includes('dsh-session-search-pro')) fail('Old Web bundle missing; inspect config before retrying')
  if (!web.dependencies?.['dsh-session-search-pro']) fail('Old Web dependency missing; inspect config before retrying')
  for (const { path, json } of data) {
    const profile = dirname(path)
    const deps = json.dependencies || {}
    const requested = deps[plugin]
    if (!requested?.startsWith('file:')) fail(`${profile}: plugin must be an explicit file: tarball dependency`)
    if (realpathSync(resolve(profile, requested.slice(5))) !== tarballPath) fail(`${profile}: plugin dependency specifies a different tarball`)
    const req = createRequire(path)
    for (const name of [plugin, ...shared]) {
      if (!deps[name]) fail(`${profile}: missing explicit dependency ${name}; reconcile shared dependencies first`)
      try { req.resolve(name) } catch { fail(`${profile}: cannot resolve built entry of ${name}`) }
    }
    let entry, pluginManifest
    try {
      entry = realpathSync(req.resolve(plugin))
      pluginManifest = parse(join(profile, 'node_modules', plugin, 'package.json'))
    } catch { fail(`${profile}: cannot locate built plugin entry and manifest`) }
    if (entry.endsWith('.ts')) fail(`${profile}: plugin entry is TypeScript, not built JavaScript`)
    const loadedProfile = loadProfileDirectory('dsh-session-tools preflight', profile, hostAnchor)
    const resolution = await createRuntimeResolution({ installAnchor: hostAnchor, profile: loadedProfile, home: root })
    const ctx = new Context()
    try {
      await ctx.plugin(PluginPackages, { resolution })
      const entryUrl = pathToFileURL(entry).href
      const selected = ctx.pluginPackages.packageOf(plugin, pathToFileURL(path).href)
      if (selected === undefined || realpathSync(selected.dir) !== realpathSync(join(profile, 'node_modules', plugin))) {
        fail(`${profile}: profile resolver selected a different plugin package`)
      }
      for (const peer of Object.keys(pluginManifest.peerDependencies || {})) {
        const expected = resolution.entries.find(item => item.name === peer && item.scope === 'installation')
        if (expected === undefined) fail(`${profile}: Host does not provide shared peer ${peer}`)
        const actual = ctx.pluginPackages.packageOf(peer, entryUrl)
        if (actual === undefined) fail(`${profile}: profile resolver cannot locate peer ${peer}`)
        if (peer !== '@deepseek-ai/schemastery' && realpathSync(actual.dir) !== realpathSync(expected.packageDir)) {
          fail(`${profile}: ${peer} resolves to a different copy than Host`)
        }
        if (peer === '@deepseek-ai/schemastery' && actual.version !== expected.version) {
          fail(`${profile}: Schemastery version differs from Host`)
        }
      }
      let module
      try { module = await import(entryUrl) } catch (error) {
        fail(`${profile}: built plugin entry failed DSH profile import (${error.code || error.name || 'unknown error'})`)
      }
      if (module.name !== plugin || typeof module.apply !== 'function') fail(`${profile}: built plugin entry has invalid named exports`)
      // Validate the plugin's own schema through the Host's Schemastery, as the Loader does.
      const hostSchema = (await import(pathToFileURL(hostReq.resolve('@deepseek-ai/schemastery')).href)).default
      const [defaults] = hostSchema.resolve({}, module.Config, {})
      if (defaults.pageSize !== 30 || defaults.maxPageSize !== 100) fail(`${profile}: Config defaults failed Host validation`)
      let rejected = false
      try { hostSchema.resolve({ pageSize: 0 }, module.Config, {}) } catch { rejected = true }
      if (!rejected) fail(`${profile}: invalid Config passed Host validation`)
    } finally {
      await ctx.fiber.dispose()
    }
  }
  if (oldPatch.includes("name: '@deepseek-ai/dsh-tool-session-query'") || oldPatch.includes('name: "@deepseek-ai/dsh-tool-session-query"')) fail('Official session tool is present in home patch; remove or disable it first')
  for (const name of profiles) {
    const profilePatch = join(root, `profiles/${name}/cordis.patch.yml`)
    if (existsSync(profilePatch) && read(profilePatch).includes('@deepseek-ai/dsh-tool-session-query')) fail(`${name}: official session tool found in profile patch`)
  }
  if (checkOnly) {
    console.log(`Read-only DSH profile preflight passed for ${profiles.join(',')}; no configuration changed.`)
    process.exit(0)
  }
  web.dsh.profile.bundles = web.dsh.profile.bundles.filter(x => x !== 'dsh-session-search-pro')
  const newPatch = oldPatch + "\n- insert:\n    - id: session-tools\n      name: dsh-session-tools\n"
  const backup = join(root, 'backups', `session-tools-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  for (const source of [patch, ...manifests, ...profiles.map(p => join(root, `profiles/${p}/cordis.patch.yml`)), ...profiles.map(p => join(root, `profiles/${p}/pnpm-lock.yaml`))]) {
    if (!existsSync(source)) continue
    const destination = join(backup, source.slice(root.length + 1))
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(source, destination)
  }
  const tmpPatch = `${patch}.session-tools-tmp`
  const tmpManifest = `${webManifest}.session-tools-tmp`
  writeFileSync(tmpPatch, newPatch, { mode: 0o600 })
  writeFileSync(tmpManifest, JSON.stringify(web, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmpPatch, patch)
  renameSync(tmpManifest, webManifest)
  console.log(`Activated without restarting Host. Backup: ${backup}`)
  console.log('Old dependency remains installed: remove it later with pnpm after verifying the new combination.')
} catch (error) {
  console.error(`Activation stopped: ${error.message}`)
  process.exitCode = 1
}
