import { afterEach, describe, expect, it, vi } from 'vitest'
import { duplicateSubmissionMessage, EventernoteClient } from './eventernote.js'
import type { ActorData, EventData } from '../shared/types.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Eventernote duplicate detection', () => {
  it('submits every required actor registration field through the confirmation step', async () => {
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
      if (url.endsWith('/actors/add') && (!init?.method || init.method === 'GET')) {
        return response(`<form action="/actors/add/confirm" method="post">
          <input name="name"><input name="kana"><input name="keyword">
          <input type="radio" name="sex" value="1"><input type="radio" name="sex" value="2">
          <input type="radio" name="sex" value="3">
        </form>`, url)
      }
      if (url.endsWith('/actors/add/confirm')) {
        return response(`<form action="/actors/add" method="post">
          <input type="hidden" name="name" value="佐藤空">
          <input type="hidden" name="kana" value="さとうそら">
          <input type="hidden" name="keyword" value="Sora Sato,さとうそら">
          <input type="hidden" name="sex" value="2">
        </form>`, 'https://www.eventernote.com/actors/add/confirm')
      }
      if (url.endsWith('/actors/add') && init?.method === 'POST') {
        return response(`<main><a href="/actors/sora-sato/901">佐藤空</a></main>
          <footer><a href="/actors/popular/28">水樹奈々</a></footer>`,
          'https://www.eventernote.com/actors/add/complete')
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')
    const actor = {
      name: '佐藤空', reading: 'さとうそら', searchKeywords: 'Sora Sato,さとうそら', sex: '2',
      selectedId: '', createNew: true, candidates: [],
    } satisfies ActorData

    await expect(client.createActor(actor)).resolves.toEqual({
      id: '901', url: 'https://www.eventernote.com/actors/901',
    })
    const initialBody = fetchMock.mock.calls[3][1]?.body as URLSearchParams
    expect(Object.fromEntries(initialBody)).toMatchObject({
      name: '佐藤空', kana: 'さとうそら', keyword: 'Sora Sato,さとうそら', sex: '2',
    })
  })

  it('recovers a newly created actor ID from an exact search when the complete page has no target link', async () => {
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
      if (url.endsWith('/actors/add') && (!init?.method || init.method === 'GET')) {
        return response(`<form action="/actors/add/confirm" method="post">
          <input name="name"><input name="kana"><input name="keyword"><input name="sex">
        </form>`, url)
      }
      if (url.endsWith('/actors/add/confirm')) {
        return response(`<form action="/actors/add" method="post">
          <input type="hidden" name="name" value="佐藤空">
        </form>`, 'https://www.eventernote.com/actors/add/confirm')
      }
      if (url.endsWith('/actors/add') && init?.method === 'POST') {
        return response('<p>登録が完了しました。</p>', 'https://www.eventernote.com/actors/add/complete')
      }
      if (url.includes('/api/actors/search')) {
        return response(JSON.stringify({ results: [{ id: 94002, name: '佐藤空' }] }), url)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')

    await expect(client.createActor({
      name: '佐藤空', reading: 'さとうそら', searchKeywords: 'Sora Sato', sex: '2',
      selectedId: '', createNew: true, candidates: [],
    })).resolves.toEqual({ id: '94002', url: 'https://www.eventernote.com/actors/94002' })
  })

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
        return response(`<form action="/events/add" method="post">
          <input name="event_name"><input name="place_id">
          <textarea name="link">関連リンク</textarea><textarea name="description">詳細</textarea>
        </form>`, url)
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
    const initialBody = fetchMock.mock.calls[3][1]?.body as URLSearchParams
    expect(initialBody.get('event_name')).toBe('Sample Live')
    expect(initialBody.get('link')).toBe('')
    expect(initialBody.get('description')).toBe('')
  })

  it('posts the Eventernote confirmation form before accepting the created event', async () => {
    const response = (body: string, url: string, status = 200) => {
      const result = new Response(body, { status })
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
        return response(`
          <form action="/events/add/confirm" method="post">
            <input type="hidden" name="authenticity_token" value="initial-token">
            <input type="hidden" name="actor_ids">
            <tr><th>イベント名</th><td><input name="keyword"><input name="event_name"></td></tr>
            <select name="place_id"><option value=""></option></select>
            <select name="date[year]"><option value="2026">2026</option></select>
            <select name="date[month]"><option value="8">8</option></select>
            <select name="date[day]"><option value="8">8</option></select>
            <select name="open_time[hour]"><option value=""></option></select>
            <select name="open_time[minute]"><option value=""></option></select>
            <select name="start_time[hour]"><option value=""></option></select>
            <select name="start_time[minute]"><option value=""></option></select>
            <select name="end_time[hour]"><option value=""></option></select>
            <select name="end_time[minute]"><option value=""></option></select>
            <textarea name="link"></textarea>
            <textarea name="description"></textarea>
          </form>
        `, url)
      }
      if (url.endsWith('/events/add/confirm')) {
        return response(`
          <form action="/events/add" method="post">
            <input type="hidden" name="authenticity_token" value="confirmation-token">
            <input type="hidden" name="event_name" value="Sample Live">
            <input type="hidden" name="open_time" value="--- hour: 8 minute: 30 ">
            <input type="hidden" name="start_time" value="--- hour: 9 minute: 5 ">
            <input type="hidden" name="end_time" value="--- hour: 3 minute: 0 ">
            <input type="submit" name="commit" value="登録する">
          </form>
        `, 'https://www.eventernote.com/events/add/confirm')
      }
      if (url.endsWith('/events/add') && init?.method === 'POST') {
        return response(`
          <link rel="canonical" href="https://www.eventernote.com/events/add/complete">
          <a href="/events/779/">イベントページへ</a>
        `, 'https://www.eventernote.com/events/add/complete')
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')
    const data = {
      title: 'Sample Live', date: '2026-09-08', openTime: '08:30', startTime: '09:05', endTime: '03:00',
      description: 'Source description', officialUrl: 'https://example.com/event', imageUrl: '', descriptionLanguage: 'ja', actors: [],
      place: { name: 'Example Hall', address: '', countryCode: 'JP', selectedId: '10', createNew: false, candidates: [] },
    } satisfies EventData

    await expect(client.createEvent(data, '10', ['82869', '94002', '81934'])).resolves.toEqual({
      id: '779', url: 'https://www.eventernote.com/events/779',
    })
    const initialBody = fetchMock.mock.calls[3][1]?.body as URLSearchParams
    const confirmationBody = fetchMock.mock.calls[4][1]?.body as URLSearchParams
    expect(initialBody.get('event_name')).toBe('Sample Live')
    expect(initialBody.get('keyword')).toBe('')
    expect(initialBody.getAll('actor_ids')).toEqual(['82869,94002,81934'])
    expect(initialBody.get('place_id')).toBe('10')
    expect(initialBody.get('link')).toBe('https://example.com/event')
    expect(initialBody.get('description')).toBe('Source description')
    expect(initialBody.get('date[month]')).toBe('9')
    expect(initialBody.get('date[day]')).toBe('8')
    expect(initialBody.get('open_time[hour]')).toBe('08')
    expect(initialBody.get('open_time[minute]')).toBe('30')
    expect(initialBody.get('start_time[hour]')).toBe('09')
    expect(initialBody.get('start_time[minute]')).toBe('05')
    expect(initialBody.get('end_time[hour]')).toBe('03')
    expect(initialBody.get('end_time[minute]')).toBe('00')
    expect(confirmationBody.get('authenticity_token')).toBe('confirmation-token')
    expect(confirmationBody.get('actor_ids')).toBe('82869,94002,81934')
    expect(confirmationBody.get('place_id')).toBe('10')
    expect(confirmationBody.get('open_time')).toBe('08:30')
    expect(confirmationBody.get('start_time')).toBe('09:05')
    expect(confirmationBody.get('end_time')).toBe('03:00')
    expect(confirmationBody.get('commit')).toBe('登録する')
  })

  it('submits the selected place prefecture through both event form steps', async () => {
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
        return response(`<form action="/events/add/confirm" method="post">
          <input name="event_name"><input type="hidden" name="actor_ids">
          <select name="prefecture"><option value=""></option></select>
          <select name="place_id"><option value=""></option></select>
        </form>`, url)
      }
      if (url.includes('/api/places/search?')) {
        return response(JSON.stringify({
          results: [{ id: 425, place_name: '東京国際フォーラム ホールC', prefecture: 13 }],
        }), url)
      }
      if (url.endsWith('/events/add/confirm')) {
        return response(`<form action="/events/add" method="post">
          <input type="hidden" name="authenticity_token" value="confirmation-token">
          <input type="submit" name="commit" value="登録する">
        </form>`, url)
      }
      if (url.endsWith('/events/add') && init?.method === 'POST') {
        return response('<a href="/events/780/">Sample Live</a>', 'https://www.eventernote.com/events/add/complete')
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')
    const data = {
      title: 'Sample Live', date: '2026-11-02', openTime: '', startTime: '19:00', endTime: '',
      description: '', officialUrl: '', imageUrl: '', descriptionLanguage: 'ja', actors: [],
      place: {
        name: '東京国際フォーラム ホールC', address: '東京都千代田区丸の内3丁目5番1号',
        countryCode: 'JP', selectedId: '425', createNew: false, candidates: [],
      },
    } satisfies EventData

    await expect(client.createEvent(data, '425', [])).resolves.toEqual({
      id: '780', url: 'https://www.eventernote.com/events/780',
    })
    const initialBody = fetchMock.mock.calls.find(([input]) => (
      input.toString().endsWith('/events/add/confirm')
    ))?.[1]?.body as URLSearchParams
    const confirmationBody = fetchMock.mock.calls.find(([input, init]) => (
      input.toString().endsWith('/events/add') && init?.method === 'POST'
    ))?.[1]?.body as URLSearchParams
    expect(initialBody.get('prefecture')).toBe('13')
    expect(initialBody.get('place_id')).toBe('425')
    expect(confirmationBody.get('prefecture')).toBe('13')
    expect(confirmationBody.get('place_id')).toBe('425')
  })

  it('does not accept an ambiguous complete page with multiple event links', async () => {
    const response = (body: string, url: string) => {
      const result = new Response(body, { status: 200 })
      Object.defineProperty(result, 'url', { value: url })
      return result
    }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString()
      if (url.endsWith('/login')) {
        return response('<form action="/login/email"><input name="email"><input name="password"></form>', url)
      }
      if (url.endsWith('/login/email')) return response('', 'https://www.eventernote.com/')
      if (url.endsWith('/events/add') && (!init?.method || init.method === 'GET')) {
        return response('<form action="/events/add/confirm"><input name="event_name"></form>', url)
      }
      if (url.endsWith('/events/add/confirm')) {
        return response('<form action="/events/add"><input name="event_name"></form>', url)
      }
      return response('<a href="/events/100">one</a><a href="/events/101">two</a>',
        'https://www.eventernote.com/events/add/complete')
    }))
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')
    const data = {
      title: 'Ambiguous Live', date: '2026-09-08', openTime: '', startTime: '09:05', endTime: '',
      description: '', officialUrl: '', imageUrl: '', descriptionLanguage: 'ja', actors: [],
      place: { name: 'Example Hall', address: '', countryCode: 'JP', selectedId: '10', createNew: false, candidates: [] },
    } satisfies EventData

    await expect(client.createEvent(data, '10', [])).rejects.toThrow('Eventernote events 提交未成功')
  })

  it('logs safe structured metadata when the confirmation submission fails', async () => {
    const response = (body: string, url: string, status = 200) => {
      const result = new Response(body, { status })
      Object.defineProperty(result, 'url', { value: url })
      return result
    }
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString()
      if (url.endsWith('/login')) {
        return response('<form action="/login/email"><input name="email"><input name="password"></form>', url)
      }
      if (url.endsWith('/login/email')) return response('', 'https://www.eventernote.com/')
      if (url.endsWith('/events/add') && (!init?.method || init.method === 'GET')) {
        return response('<form action="/events/add/confirm" method="post"><input name="event_name"></form>', url)
      }
      if (url.endsWith('/events/add/confirm')) {
        return response(`
          <form action="/events/add" method="post">
            <input type="hidden" name="authenticity_token" value="secret-confirmation-token">
            <input type="hidden" name="event_name" value="Private Event Name">
          </form>
        `, 'https://www.eventernote.com/events/add/confirm')
      }
      return response('<div id="error_explanation">Private Event Name was rejected</div>',
        'https://www.eventernote.com/events/add/confirm', 422)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'private-user', 'private-password')
    const data = {
      title: 'Private Event Name', date: '2026-08-14', openTime: '', startTime: '19:00', endTime: '',
      description: '', officialUrl: '', imageUrl: '', descriptionLanguage: 'ja', actors: [],
      place: { name: 'Example Hall', address: '', countryCode: 'JP', selectedId: '10', createNew: false, candidates: [] },
    } satisfies EventData

    await expect(client.createEvent(data, '10', [])).rejects.toThrow('Eventernote 拒絕提交')
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = String(logSpy.mock.calls[0][0])
    expect(JSON.parse(logged)).toEqual({
      event: 'eventernote_submission_failed',
      entity: 'events',
      stage: 'confirmation_response',
      httpStatus: 422,
      pathname: '/events/add/confirm',
      errorType: 'Error',
    })
    expect(logged).not.toContain('Private Event Name')
    expect(logged).not.toContain('secret-confirmation-token')
    expect(logged).not.toContain('private-user')
    expect(logged).not.toContain('private-password')
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

  it('keeps a place returned through an Eventernote alias without changing the search keyword', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{
        id: 12020,
        place_name: 'TACHIKAWA STAGE GARDEN',
        address: '東京都立川市緑町3-3 N1 立川ステージガーデン',
      }],
      code: 200,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new EventernoteClient('https://www.eventernote.com')
    await expect(client.searchEntities('立川ステージガーデン', 'place')).resolves.toEqual([
      expect.objectContaining({
        id: '12020',
        name: 'TACHIKAWA STAGE GARDEN',
        similarity: 0.86,
      }),
    ])

    const searchUrl = new URL(fetchMock.mock.calls[0][0].toString())
    expect(searchUrl.pathname).toBe('/api/places/search')
    expect(searchUrl.searchParams.get('keyword')).toBe('立川ステージガーデン')
  })

  it('uses Eventernote actor keywords as exact aliases', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [{ id: 456, name: '佐藤空', kana: 'さとうそら', keyword: 'Sora Sato,さとうそら' }],
      code: 200,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const client = new EventernoteClient('https://www.eventernote.com')
    await expect(client.searchEntities('Sora Sato', 'actor')).resolves.toEqual([
      expect.objectContaining({ id: '456', name: '佐藤空', similarity: 1 }),
    ])
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
