import { describe, expect, it } from 'vitest'
import {
  eventernoteCandidateSearchWarnings,
  EVENTERNOTE_CANDIDATE_SEARCH_WARNING,
  hasUnresolvedEventernoteEntitySelection,
} from '../shared/submission.js'
import type { EventData } from '../shared/types.js'

function eventData(): EventData {
  return {
    title: 'Example event',
    date: '2026-08-08',
    openTime: '13:00',
    startTime: '14:00',
    endTime: '16:00',
    description: '',
    descriptionLanguage: 'ja',
    officialUrl: 'https://example.com/event',
    imageUrl: '',
    place: {
      name: 'Example Hall', address: '', countryCode: 'JP', selectedId: '', createNew: false, candidates: [],
    },
    actors: [{ name: 'Example Actor', reading: '', selectedId: '', createNew: false, candidates: [] }],
  }
}

describe('hasUnresolvedEventernoteEntitySelection', () => {
  it('detects a place that still needs a choice', () => {
    const data = eventData()
    data.actors[0].selectedId = '123'

    expect(hasUnresolvedEventernoteEntitySelection(data)).toBe(true)
  })

  it('detects an actor that still needs a choice', () => {
    const data = eventData()
    data.place.selectedId = '456'

    expect(hasUnresolvedEventernoteEntitySelection(data)).toBe(true)
  })

  it('allows existing entities selected manually', () => {
    const data = eventData()
    data.place.selectedId = '456'
    data.actors[0].selectedId = '123'

    expect(hasUnresolvedEventernoteEntitySelection(data)).toBe(false)
  })

  it('allows explicit new-entity choices', () => {
    const data = eventData()
    data.place.createNew = true
    data.actors[0].createNew = true

    expect(hasUnresolvedEventernoteEntitySelection(data)).toBe(false)
  })
})

describe('eventernoteCandidateSearchWarnings', () => {
  it('keeps the search failure actionable while an entity choice is unresolved', () => {
    expect(eventernoteCandidateSearchWarnings(eventData(), true)).toEqual([
      EVENTERNOTE_CANDIDATE_SEARCH_WARNING,
    ])
  })

  it('clears the search failure after every entity is manually selected', () => {
    const data = eventData()
    data.place.selectedId = '456'
    data.actors[0].selectedId = '123'

    expect(eventernoteCandidateSearchWarnings(data, true)).toEqual([])
  })
})
