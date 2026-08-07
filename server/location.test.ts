import { describe, expect, it } from 'vitest'
import type { EventData } from '../shared/types.js'
import { classifySource, inferCountry, isOnlineOnlyEvent, languageForCountry } from './location.js'

function eventAt(place: string, title = 'Sample Live'): EventData {
  return {
    title, date: '2026-09-23', openTime: '12:00', startTime: '13:00', endTime: '',
    description: '', officialUrl: '', imageUrl: '', descriptionLanguage: 'ja',
    place: { name: place, address: '', countryCode: '', selectedId: '', createNew: false, candidates: [] },
    actors: [],
  }
}

describe('source and location classification', () => {
  it('recognizes supported social, ticketing, and Eventernote sources', () => {
    expect(classifySource('https://x.com/example/status/1')).toBe('x')
    expect(classifySource('https://www.facebook.com/events/1')).toBe('facebook')
    expect(classifySource('https://www.instagram.com/p/example/')).toBe('instagram')
    expect(classifySource('https://www.kktix.com/events/example')).toBe('ticketing')
    expect(classifySource('https://www.eventernote.com/events/1')).toBe('eventernote')
    expect(classifySource('https://artist.example/live')).toBe('official')
  })

  it('infers common event regions and maps them to a description language', () => {
    expect(inferCountry('AsiaWorld-Expo, Hong Kong')).toBe('HK')
    expect(languageForCountry('HK')).toBe('zh-Hant')
    expect(inferCountry('東京都渋谷区')).toBe('JP')
    expect(languageForCountry('JP')).toBe('ja')
    expect(inferCountry('서울 올림픽공원')).toBe('KR')
    expect(languageForCountry('KR')).toBe('ko')
    expect(languageForCountry('US')).toBe('en')
  })

  it('identifies online-only entries without excluding a physical venue session', () => {
    expect(isOnlineOnlyEvent(eventAt('オンライン', 'Sample Live（オンライン配信）'))).toBe(true)
    expect(isOnlineOnlyEvent(eventAt('線上'))).toBe(true)
    const physical = eventAt('Yogibo META VALLEY')
    physical.place.address = '大阪府大阪市浪速区'
    physical.place.countryCode = 'JP'
    expect(isOnlineOnlyEvent(physical)).toBe(false)
  })
})
