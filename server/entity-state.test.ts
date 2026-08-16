import { describe, expect, it } from 'vitest'
import { actorSearchTargetsForEditing, removeActorConfirmation } from '../shared/entity-state.js'

describe('removeActorConfirmation', () => {
  it('preserves and reindexes confirmed new actors after removing another actor', () => {
    expect(removeActorConfirmation([
      'event-1:place',
      'event-1:actor:0',
      'event-1:actor:1',
      'event-1:actor:2',
      'event-2:actor:1',
    ], 'event-1', 1)).toEqual([
      'event-1:place',
      'event-1:actor:0',
      'event-1:actor:1',
      'event-2:actor:1',
    ])
  })
})

describe('actorSearchTargetsForEditing', () => {
  const targets = [
    { index: 0, name: 'Actor A' },
    { index: 1, name: 'Actor B' },
    { index: 2, name: 'Actor C' },
  ]

  it('searches only the actor currently being edited', () => {
    expect(actorSearchTargetsForEditing(targets, 'event-1', 'event-1:actor:1')).toEqual([
      { index: 1, name: 'Actor B' },
    ])
  })

  it('keeps automatic initial searches when no actor is being edited', () => {
    expect(actorSearchTargetsForEditing(targets, 'event-1', '')).toEqual(targets)
  })
})
