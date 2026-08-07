import type { Evidence, PlaceData } from './types.js'

export function placeAddressEvidence(evidence: Evidence | undefined, place: PlaceData): Evidence | undefined {
  if (place.selectedId && !place.address.trim() && evidence?.confidence === 'missing') return undefined
  return evidence
}
