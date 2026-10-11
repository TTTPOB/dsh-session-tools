import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionCaptureReader } from '@deepseek-ai/dsh-session-query'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'

/** Query guarantees original Session identity during capture; keep this assertion private. */
export function sampleMeter(ctx: Context, reader: SessionCaptureReader, metering: 'auto' | 'none' | 'require'): TokenMeasurement | undefined {
  const meter = ctx.get('tokenMeter')
  if (metering === 'require' && meter === undefined) throw new Error('Context map requires tokenMeter, but the service is unavailable')
  return metering === 'none' ? undefined : meter?.measure(reader as Session)
}
