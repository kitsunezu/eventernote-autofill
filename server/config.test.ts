import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig APP_TOKEN_ENABLED', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('enables APP_TOKEN authentication by default', () => {
    vi.stubEnv('APP_TOKEN_ENABLED', '')

    expect(loadConfig().appTokenEnabled).toBe(true)
  })

  it('disables APP_TOKEN authentication when explicitly false', () => {
    vi.stubEnv('APP_TOKEN_ENABLED', 'false')

    expect(loadConfig().appTokenEnabled).toBe(false)
  })
})
