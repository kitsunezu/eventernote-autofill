import { describe, expect, it } from 'vitest'
import { safeFetchHtml, safeFetchImage } from './safe-fetch.js'

describe('safeFetchHtml', () => {
  it('rejects local and credential-bearing URLs before fetching', async () => {
    await expect(safeFetchHtml('http://127.0.0.1/admin')).rejects.toThrow(/內部網路/)
    await expect(safeFetchHtml('https://user:pass@example.com/')).rejects.toThrow(/登入資料/)
  })

  it('rejects non-http protocols and nonstandard ports', async () => {
    await expect(safeFetchHtml('file:///etc/passwd')).rejects.toThrow(/HTTP/)
    await expect(safeFetchHtml('https://example.com:8443/')).rejects.toThrow(/連接埠/)
  })

  it('applies the same network boundary to remote images', async () => {
    await expect(safeFetchImage('http://127.0.0.1/event.png')).rejects.toThrow(/內部網路/)
    await expect(safeFetchImage('file:///tmp/event.png')).rejects.toThrow(/HTTP/)
  })
})
