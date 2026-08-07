import { describe, expect, it } from 'vitest'
import { addHoursToTime } from '../shared/time.js'

describe('addHoursToTime', () => {
  it('adds two hours to an event start time', () => {
    expect(addHoursToTime('18:30', 2)).toBe('20:30')
  })

  it('wraps across midnight', () => {
    expect(addHoursToTime('23:30', 2)).toBe('01:30')
    expect(addHoursToTime('00:30', -1)).toBe('23:30')
  })

  it('does not invent a result for missing or invalid start times', () => {
    expect(addHoursToTime('', 2)).toBe('')
    expect(addHoursToTime('25:00', 2)).toBe('')
  })
})
