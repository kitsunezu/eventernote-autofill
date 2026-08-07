import { afterEach, describe, expect, it, vi } from 'vitest'
import { duplicateSubmissionMessage, EventernoteClient } from './eventernote.js'
import type { EventData } from '../shared/types.js'

afterEach(() => vi.unstubAllGlobals())

describe('Eventernote duplicate detection', () => {
  it('returns a useful error with existing event links', () => {
    const html = `<div class="alert-danger">同じイベントは既に登録済みです</div>
      <a href="/events/102">既存イベント</a>`
    const message = duplicateSubmissionMessage(html, 'https://www.eventernote.com', '')
    expect(message).toContain('活動可能已經存在')
    expect(message).toContain('https://www.eventernote.com/events/102')
    expect(message).toContain('修正名稱、日期或場所')
  })

  it('does not reclassify unrelated validation errors as duplicates', () => {
    expect(duplicateSubmissionMessage('<div class="error">開催日は必須です</div>', 'https://www.eventernote.com', '開催日は必須です')).toBeUndefined()
  })

  it('submits the event without a separate duplicate search', async () => {
    const response = (body: string, url: string) => {
      const result = new Response(body, { status: 200 })
      Object.defineProperty(result, 'url', { value: url })
      return result
    }
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString()
      if (url.endsWith('/login')) {
        return response('<form action="/login/email" method="post"><input name="email"><input name="password"></form>', url)
      }
      if (url.endsWith('/login/email')) return response('', 'https://www.eventernote.com/')
      if (url.endsWith('/events/add') && (!init?.method || init.method === 'GET')) {
        return response('<form action="/events/add" method="post"><input name="event_name"><input name="place_id"></form>', url)
      }
      if (url.endsWith('/events/add')) return response('', 'https://www.eventernote.com/events/777')
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')
    const data = {
      title: 'Sample Live', date: '2026-08-14', openTime: '', startTime: '19:00', endTime: '',
      description: '', officialUrl: '', imageUrl: '', descriptionLanguage: 'ja', actors: [],
      place: { name: 'Example Hall', address: '', countryCode: 'JP', selectedId: '10', createNew: false, candidates: [] },
    } satisfies EventData

    await expect(client.createEvent(data, '10', [])).resolves.toEqual({
      id: '777', url: 'https://www.eventernote.com/events/777',
    })
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes('/events/search'))).toBe(false)
  })

  it('reports when email verification blocks access to the add form', async () => {
    const response = (body: string, url: string, status = 200) => {
      const result = new Response(body, { status })
      Object.defineProperty(result, 'url', { value: url })
      return result
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.endsWith('/login')) {
        return response('<form action="/login/email"><input name="email"><input name="password"></form>', url)
      }
      if (url.endsWith('/login/email')) return response('', 'https://www.eventernote.com/')
      return response('<p>イベントを作成するにはメール認証が必要です</p><form action="/events/search"></form>', url, 403)
    }))
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')
    const data = {
      title: 'Sample Live', date: '2026-08-14', openTime: '', startTime: '19:00', endTime: '',
      description: '', officialUrl: '', imageUrl: '', descriptionLanguage: 'ja', actors: [],
      place: { name: 'Example Hall', address: '', countryCode: 'JP', selectedId: '10', createNew: false, candidates: [] },
    } satisfies EventData

    await expect(client.createEvent(data, '10', [])).rejects.toThrow(
      'Eventernote 帳號尚未完成電子郵件驗證',
    )
  })

  it('accepts a POST form whose empty action submits back to the add page', async () => {
    const response = (body: string, url: string) => {
      const result = new Response(body, { status: 200 })
      Object.defineProperty(result, 'url', { value: url })
      return result
    }
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString()
      if (url.endsWith('/login')) {
        return response('<form action="/login/email"><input name="email"><input name="password"></form>', url)
      }
      if (url.endsWith('/login/email')) return response('', 'https://www.eventernote.com/')
      if (url.endsWith('/events/add') && (!init?.method || init.method === 'GET')) {
        return response('<form method="post"><input name="event_name"><input name="place_id"></form>', url)
      }
      return response('', 'https://www.eventernote.com/events/778')
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')
    const data = {
      title: 'Sample Live', date: '2026-08-14', openTime: '', startTime: '19:00', endTime: '',
      description: '', officialUrl: '', imageUrl: '', descriptionLanguage: 'ja', actors: [],
      place: { name: 'Example Hall', address: '', countryCode: 'JP', selectedId: '10', createNew: false, candidates: [] },
    } satisfies EventData

    await expect(client.createEvent(data, '10', [])).resolves.toEqual({
      id: '778', url: 'https://www.eventernote.com/events/778',
    })
  })
})

describe('Eventernote entity search', () => {
  it('uses the dedicated actor search and returns matching performer candidates', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ id: 79570, name: 'むんもっしゅ' }], code: 200,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new EventernoteClient('https://www.eventernote.com')
    await expect(client.searchEntities('むんもっしゅ', 'actor')).resolves.toEqual([{
      id: '79570', name: 'むんもっしゅ',
      url: 'https://www.eventernote.com/actors/%E3%82%80%E3%82%93%E3%82%82%E3%81%A3%E3%81%97%E3%82%85/79570',
      similarity: 1,
    }])
    expect(fetchMock.mock.calls[0][0].toString()).toContain('/api/actors/search?')
  })

  it('uses the dedicated place search for venues', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ id: 123, place_name: 'Example Hall' }], code: 200,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new EventernoteClient('https://www.eventernote.com')
    await client.searchEntities('Example Hall', 'place')

    expect(fetchMock.mock.calls[0][0].toString()).toContain('/api/places/search?')
  })

  it('retries a transient connection failure for read-only searches', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ id: 123, place_name: 'Example Hall' }], code: 200,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new EventernoteClient('https://www.eventernote.com')
    await expect(client.searchEntities('Example Hall', 'place')).resolves.toEqual([
      expect.objectContaining({ id: '123', name: 'Example Hall' }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to event results when the dedicated actor search has no exact match', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      return url.includes('/api/actors/search')
        ? new Response(JSON.stringify({ results: [{ id: 10, name: 'RUSHING AGE' }], code: 200 }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        : new Response('<a href="/actors/shin%28Vsinger%29/83550">shin(Vsinger)</a>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new EventernoteClient('https://www.eventernote.com')
    const candidates = await client.searchEntities('shin', 'actor')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0].toString()).toContain('/events/search?')
    expect(candidates).toContainEqual(expect.objectContaining({ id: '83550', name: 'shin(Vsinger)', similarity: 0.95 }))
  })

  it('builds contextual performer candidates from an existing event cast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <a href="/actors/shin%28Vsinger%29/83550">shin(Vsinger)</a>
      <a href="/actors/unrelated/10">Other Artist</a>
    `, { status: 200 })))

    const client = new EventernoteClient('https://www.eventernote.com')
    const [candidates] = await client.searchActorsFromEvent('Vack-ON', ['shin'])

    expect(candidates).toEqual([expect.objectContaining({
      id: '83550', name: 'shin(Vsinger)', similarity: 0.95,
    })])
  })
})
