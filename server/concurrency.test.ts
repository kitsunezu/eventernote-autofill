import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './concurrency.js'

describe('mapWithConcurrency', () => {
  it('limits active work and preserves input order', async () => {
    let active = 0
    let maxActive = 0
    const releases = new Map<number, () => void>()
    const started: number[] = []

    const pending = mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      started.push(item)
      await new Promise<void>((resolve) => releases.set(item, resolve))
      active -= 1
      return `result-${item}`
    })

    await expect.poll(() => started).toEqual([0, 1])
    releases.get(1)?.()
    await expect.poll(() => started).toEqual([0, 1, 2])
    releases.get(0)?.()
    await expect.poll(() => started).toEqual([0, 1, 2, 3])
    releases.get(2)?.()
    releases.get(3)?.()

    await expect(pending).resolves.toEqual(['result-0', 'result-1', 'result-2', 'result-3'])
    expect(maxActive).toBe(2)
  })

  it('rejects invalid concurrency values', async () => {
    await expect(mapWithConcurrency([1], 0, async (item) => item)).rejects.toThrow(
      'concurrency must be a positive integer',
    )
  })
})
