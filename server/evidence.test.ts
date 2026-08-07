import { describe, expect, it } from 'vitest'
import { placeAddressEvidence } from '../shared/evidence.js'
import type { Evidence, PlaceData } from '../shared/types.js'

const missingAddress: Evidence = {
  value: '',
  source: '來源未提供場所地址',
  confidence: 'missing',
}

function place(overrides: Partial<PlaceData> = {}): PlaceData {
  return {
    name: 'Example Hall',
    address: '',
    countryCode: 'JP',
    selectedId: '',
    createNew: false,
    candidates: [],
    ...overrides,
  }
}

describe('placeAddressEvidence', () => {
  it('does not mark a missing address for an existing Eventernote place', () => {
    expect(placeAddressEvidence(missingAddress, place({ selectedId: '123' }))).toBeUndefined()
  })

  it('keeps a missing address marked when no existing place is selected', () => {
    expect(placeAddressEvidence(missingAddress, place())).toBe(missingAddress)
  })

  it('keeps non-missing address evidence', () => {
    const sourceEvidence: Evidence = { value: 'Tokyo', source: '活動頁', confidence: 'high' }
    expect(placeAddressEvidence(sourceEvidence, place({ address: 'Tokyo', selectedId: '123' }))).toBe(sourceEvidence)
  })
})
