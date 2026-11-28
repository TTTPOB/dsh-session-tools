import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-shell-env'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import Schema from '@deepseek-ai/schemastery'
import { startSessionStream } from './stream.js'

/** Loader-visible plugin identity. */
export const name = 'dsh-session-tools'
export const inject = ['sessionQuery', 'profileContext', 'shellEnv', 'skills']

/** Optional socket path; the default is computed from the active profile. */
export interface Config {
  socketPath?: string
}

export const Config: Schema<Config> = Schema.object({ socketPath: Schema.string().min(1) })

const skillRoot = fileURLToPath(new URL('../skills/session-stream/', import.meta.url))
const skillPath = join(skillRoot, 'SKILL.md')
const skill = {
  name: 'session-stream',
  description: 'Find and inspect DSH session history, debug tool errors and subagents, and summarize raw session events with curl and jq.',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: name,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: skillRoot },
} as const

/** Own the socket, Bash environment contribution and bundled skill with the plugin fiber. */
export async function* apply(ctx: Context, config: Config) {
  if (process.platform === 'win32') throw new Error('dsh-session-tools: Unix session stream is not available on Windows')
  const socketPath = config.socketPath ?? join(ctx.profileContext.home, 'run', `session-stream-${ctx.profileContext.name}.sock`)
  const stream = startSessionStream(socketPath, ctx.sessionQuery, config.socketPath === undefined)
  yield stream.dispose
  await stream.ready
  yield ctx.shellEnv.register({
    name,
    variables: { DSH_SESSION_STREAM: { description: 'Unix socket for the DSH session history stream; use the session-stream skill.' } },
    resolve: execution => execution.agent === undefined || execution.name !== 'bash' ? {} : { DSH_SESSION_STREAM: socketPath },
  })
  yield ctx.skills.registerProvider(() => ({
    name,
    async list() {
      const candidate: SkillCandidate = { ...skill, rank: BUNDLED_SKILL_RANK, locator: skillPath }
      return { candidates: [candidate], complete: true }
    },
    async get(_candidate, { signal }) {
      return { ...skill, content: await readFile(skillPath, { encoding: 'utf8', signal }) }
    },
  }))
}
