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

  it('recovers an existing actor when Eventernote rejects the add form as a duplicate', async () => {
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
        return response(`<p>同じ名前の声優/アーティストが登録されています</p>
          <form action="/actors/add/confirm" method="post">
            <input name="name" value="SEE"><input name="kana" value="しー">
          </form>`, 'https://www.eventernote.com/actors/add/confirm')
      }
      if (url.includes('/api/actors/search')) {
        return response(JSON.stringify({ results: [{ id: 77871, name: 'SEE', kana: 'しー' }] }), url)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')

    await expect(client.createActor({
      name: 'SEE', reading: 'しー', searchKeywords: 'シー', sex: '3',
      selectedId: '', createNew: true, candidates: [],
    })).resolves.toEqual({ id: '77871', url: 'https://www.eventernote.com/actors/77871' })
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().endsWith('/actors/add/confirm'))).toHaveLength(1)
    expect(new URL(fetchMock.mock.calls.at(-1)?.[0].toString() ?? '').searchParams.get('limit')).toBe('100')
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
    const searchUrl = new URL(fetchMock.mock.calls[0][0].toString())
    expect(searchUrl.pathname).toBe('/api/actors/search')
    expect(searchUrl.searchParams.get('limit')).toBe('100')
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

describe('Eventernote existing event reconciliation', () => {
  const eventData = {
    title: 'Sample Live', date: '2026-09-08', openTime: '18:30', startTime: '19:00', endTime: '21:00',
    description: 'Source description', officialUrl: 'https://example.com/event', imageUrl: 'https://example.com/event.jpg',
    descriptionLanguage: 'ja',
    place: { name: 'Example Hall', address: '', countryCode: 'JP', selectedId: '10', createNew: false, candidates: [] },
    actors: [{
      name: 'Existing Artist', reading: '', searchKeywords: '', sex: '' as const,
      selectedId: '11', createNew: false, candidates: [],
    }],
  } satisfies EventData

  const response = (body: string, url: string, status = 200) => {
    const result = new Response(body, { status })
    Object.defineProperty(result, 'url', { value: url })
    return result
  }

  const loginResponse = (url: string) => response(
    '<form action="/login/email"><input name="email"><input name="password"></form>', url,
  )

  const detailHtml = (withImage: boolean) => `
    <a href="/events/501/edit">このイベントを編集</a>
    <a href="/places/example/10">Example Hall</a>
    <a href="/actors/existing/11">Existing Artist</a>
    ${withImage ? '<div class="event-image"><img src="/event_images/501.jpg"></div>' : ''}
  `

  const editForm = (options: { actorIds?: string; description?: string; link?: string; openTime?: string } = {}) => {
    const [openHour = '', openMinute = ''] = (options.openTime ?? '18:30').split(':')
    return `<form action="/events/501/edit/confirm" method="post">
      <input name="event_name" value="Sample Live">
      <input name="place_id" value="10">
      <input name="actor_ids" value="${options.actorIds ?? '11'}">
      <input name="date[year]" value="2026"><input name="date[month]" value="9"><input name="date[day]" value="8">
      <input name="open_time[hour]" value="${openHour}"><input name="open_time[minute]" value="${openMinute}">
      <input name="start_time[hour]" value="19"><input name="start_time[minute]" value="00">
      <input name="end_time[hour]" value="21"><input name="end_time[minute]" value="00">
      <textarea name="link">${options.link ?? 'https://example.com/event'}</textarea>
      <textarea name="description">${options.description ?? 'Existing description'}</textarea>
    </form>`
  }

  it('returns a unique matching event without writing when its data is complete', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.includes('/events/search?')) return response('<a href="/events/501">Sample Live</a>', url)
      if (url.endsWith('/login')) return loginResponse(url)
      if (url.endsWith('/login/email')) return response('', 'https://www.eventernote.com/')
      if (url.endsWith('/events/501')) return response(detailHtml(true), url)
      if (url.endsWith('/events/501/edit')) return response(editForm(), url)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')

    await expect(client.findMatchingEvent(eventData)).resolves.toEqual(expect.objectContaining({
      id: '501', complete: true, hasImage: true, missingFields: [],
    }))
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET' || init.method === 'POST')).toBe(true)
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().includes('/events/501/edit/confirm'))).toHaveLength(0)
  })

  it('finds the oldest Day 1 event across punctuation and venue-name differences', async () => {
    const data = {
      ...eventData,
      title: '暴力的にカワイイ 2026 DAY.1',
      date: '2026-09-26',
      openTime: '12:00',
      startTime: '12:00',
      endTime: '20:30',
      place: { ...eventData.place, name: 'お台場青海地区P区画', selectedId: '' },
    }
    const eventForm = (id: string, title: string) => `<form action="/events/${id}/edit/confirm" method="post">
      <input name="event_name" value="${title}"><input name="place_id" value="2205"><input name="actor_ids" value="11">
      <input name="date[year]" value="2026"><input name="date[month]" value="9"><input name="date[day]" value="26">
      <input name="open_time[hour]" value="12"><input name="open_time[minute]" value="00">
      <input name="start_time[hour]" value="12"><input name="start_time[minute]" value="00">
      <input name="end_time[hour]" value="20"><input name="end_time[minute]" value="45">
    </form>`
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.includes('/events/search?')) return response(`
        <a href="/events/489442">暴力的にカワイイ 2026 DAY.1</a>
        <a href="/events/483616">暴力的にカワイイ 2026 Day1</a>
      `, url)
      if (url.endsWith('/login')) return loginResponse(url)
      if (url.endsWith('/login/email')) return response('', 'https://www.eventernote.com/')
      const id = url.match(/\/events\/(483616|489442)/)?.[1]
      if (id && url.endsWith(`/events/${id}`)) return response(`
        <a href="/events/${id}/edit">このイベントを編集</a>
        <a href="/places/original/2205">お台場・青海特設会場</a>
        <a href="/actors/existing/11">Existing Artist</a>
      `, url)
      if (id && url.endsWith(`/events/${id}/edit`)) {
        return response(eventForm(id, id === '483616'
          ? '暴力的にカワイイ 2026 Day1'
          : '暴力的にカワイイ 2026 DAY.1'), url)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')

    await expect(client.findMatchingEvent(data)).resolves.toEqual(expect.objectContaining({
      id: '483616', url: 'https://www.eventernote.com/events/483616',
    }))
    expect(fetchMock.mock.calls.filter(([input]) => input.toString().includes('/events/search?'))).toHaveLength(2)
  })

  it('fills only missing fields and keeps existing event values', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString()
      if (url.endsWith('/login')) return loginResponse(url)
      if (url.endsWith('/login/email')) return response('', 'https://www.eventernote.com/')
      if (url.endsWith('/events/501')) return response(detailHtml(false), url)
      if (url.endsWith('/events/501/edit') && !init?.method) {
        return response(editForm({ actorIds: '11', description: 'Keep this description', link: '', openTime: '' }), url)
      }
      if (url.endsWith('/events/501/edit/confirm')) {
        return response(`<form action="/events/501/edit" method="post">
          <input name="actor_ids"><input name="place_id"><input name="open_time">
        </form>`, url)
      }
      if (url.endsWith('/events/501/edit') && init?.method === 'POST') {
        return response('', 'https://www.eventernote.com/events/501')
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')

    await expect(client.completeExistingEvent('501', eventData, '10', ['11', '22'])).resolves.toEqual({
      id: '501', url: 'https://www.eventernote.com/events/501',
    })
    const updateBody = fetchMock.mock.calls.find(([input]) => input.toString().endsWith('/events/501/edit/confirm'))?.[1]?.body as URLSearchParams
    expect(updateBody.get('description')).toBe('Keep this description')
    expect(updateBody.get('link')).toBe('https://example.com/event')
    expect(updateBody.get('open_time[hour]')).toBe('18')
    expect(updateBody.get('open_time[minute]')).toBe('30')
    expect(updateBody.get('actor_ids')).toBe('11,22')
  })

  it('uses multipart for an existing event edit without sending an empty image field', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString()
      if (url.endsWith('/login')) return loginResponse(url)
      if (url.endsWith('/login/email')) return response('', 'https://www.eventernote.com/')
      if (url.endsWith('/events/501')) return response(detailHtml(false), url)
      if (url.endsWith('/events/501/edit') && !init?.method) {
        return response(`<form action="/events/501/edit/complete" method="post" enctype="multipart/form-data">
          <input name="event_name" value="Sample Live"><input name="place_id" value="10">
          <input name="actor_ids" value="11"><input type="file" name="thumbnail_image">
        </form>`, url)
      }
      if (url.endsWith('/events/501/edit/complete')) return response('', 'https://www.eventernote.com/events/501/')
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new EventernoteClient('https://www.eventernote.com', 'user', 'password')

    await expect(client.completeExistingEvent('501', eventData, '10', ['11', '22'])).resolves.toEqual({
      id: '501', url: 'https://www.eventernote.com/events/501',
    })
    const updateCall = fetchMock.mock.calls.find(([input]) => input.toString().endsWith('/events/501/edit/complete'))
    const updateBody = updateCall?.[1]?.body
    expect(updateBody).toBeInstanceOf(FormData)
    expect((updateBody as FormData).get('actor_ids')).toBe('11,22')
    expect((updateBody as FormData).has('thumbnail_image')).toBe(false)
    expect(new Headers(updateCall?.[1]?.headers).has('Content-Type')).toBe(false)
  })
})
