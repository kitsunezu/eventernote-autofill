import { afterEach, describe, expect, it, vi } from 'vitest'
import { duplicateSubmissionMessage, EventernoteClient, parseDuplicateEventCandidate } from './eventernote.js'

const event = {
  title: 'Sample Live',
  date: '2026-08-14',
  place: { name: 'Example Hall', address: '', selectedId: '10', createNew: false, candidates: [] },
}

describe('Eventernote duplicate detection', () => {
  it('matches only an event with the same title, date, and place', () => {
    const html = `<ul>
      <li class="event"><a href="/events/100">Sample Live</a> 2026年8月13日 Example Hall</li>
      <li class="event"><a href="/events/101">Sample Live</a> 2026年8月14日 Other Hall</li>
      <li class="event"><a href="/events/102">Sample Live</a> 2026年8月14日 Example Hall</li>
    </ul>`
    expect(parseDuplicateEventCandidate(html, 'https://www.eventernote.com', event)).toEqual({
      id: '102', name: 'Sample Live', url: 'https://www.eventernote.com/events/102',
    })
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
})

describe('Eventernote entity search', () => {
  afterEach(() => vi.unstubAllGlobals())

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
