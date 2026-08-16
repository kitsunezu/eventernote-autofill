import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api'

const data = {
  title: 'Test Event', date: '2026-08-08', openTime: '17:00', startTime: '18:00', endTime: '20:00',
  description: '', officialUrl: 'https://example.com/event', imageUrl: '', descriptionLanguage: 'en' as const,
  place: { name: 'Test Place', address: '', countryCode: 'JP', selectedId: '10', createNew: false, candidates: [] },
  actors: [{
    name: 'Test Actor', reading: '', searchKeywords: '', sex: '', selectedId: '12', createNew: false, candidates: [],
  }],
}

describe('Eventernote candidate API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requests actor suggestions with an encoded manual name', async () => {
    vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => ''), setItem: vi.fn(), removeItem: vi.fn() })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { id: '12', name: 'Test Actor', url: 'https://www.eventernote.com/actors/test/12', similarity: 1 },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.searchEntities('actor', 'Test Actor')).resolves.toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/entities/search?kind=actor&query=Test+Actor')
  })

  it('sends browser-held state directly to the submission endpoint', async () => {
    vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => ''), setItem: vi.fn(), removeItem: vi.fn() })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data,
      progress: { eventId: '99', eventUrl: 'https://www.eventernote.com/events/99', completed: true },
      steps: [],
      completed: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.submit(data, { eventId: '99' }, undefined, '88')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/submission')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      data, progress: { eventId: '99' }, existingEventId: '88',
    })
  })
})
