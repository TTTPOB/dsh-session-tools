import { Config, type ConfigInput } from 'dsh-session-tools'

const config: Config = Config({})
const pageSize: number = config.pageSize
const partial: Config = Config({ pageSize: 10, previewChars: 80 })
const limits: Record<keyof Config, number> = partial
const input: ConfigInput = { readTimeoutMs: 5000, previewChars: null }
const timeout: number = Config(input).readTimeoutMs

// @ts-expect-error Config fields retain their numeric input types.
Config({ pageSize: '10' })
