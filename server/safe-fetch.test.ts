import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeFetchHtml, safeFetchImage, safeFetchJson } from './safe-fetch.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => [{
    address: hostname === '127.0.0.1' ? '127.0.0.1' : '203.0.113.10',
    family: 4,
  }]),
}))

afterEach(() => vi.unstubAllGlobals())

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

  it('applies the same network boundary to JSON sources', async () => {
    await expect(safeFetchJson('http://127.0.0.1/graphql', {})).rejects.toThrow(/內部網路/)
    await expect(safeFetchJson('https://example.com:8443/graphql', {})).rejects.toThrow(/連接埠/)
  })

  it('posts bounded JSON with source-scoped origin and referrer headers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { value: 'ok' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeFetchJson(
      'https://api.example.com/graphql',
      { operationName: 'getPublicContent' },
      'https://site.example.com/news/public-id',
    )).resolves.toMatchObject({ json: { data: { value: 'ok' } } })

    const [target, init] = fetchMock.mock.calls[0]
    expect(String(target)).toBe('https://api.example.com/graphql')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: expect.objectContaining({
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://site.example.com',
        'Referer': 'https://site.example.com/news/public-id',
        'X-Referer': 'https://site.example.com',
      }),
      body: JSON.stringify({ operationName: 'getPublicContent' }),
    })
  })

  it('rejects non-JSON and oversized JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })))
    await expect(safeFetchJson('https://api.example.com/graphql', {})).rejects.toThrow(/沒有回傳 JSON/)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2000001' },
    })))
    await expect(safeFetchJson('https://api.example.com/graphql', {})).rejects.toThrow(/超過 2 MB/)
  })

  it('revalidates JSON redirect targets against the private-network boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302,
      headers: { 'Location': 'http://127.0.0.1/private' },
    })))
    await expect(safeFetchJson('https://api.example.com/graphql', {})).rejects.toThrow(/內部網路/)
  })
})
