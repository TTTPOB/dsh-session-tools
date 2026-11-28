import { Config } from 'dsh-session-tools'

const defaults: Config = Config({})
const configured: Config = Config({ socketPath: '/home/test/session.sock' })
const socketPath: string | undefined = configured.socketPath

// @ts-expect-error socketPath must be a string.
Config({ socketPath: 123 })
