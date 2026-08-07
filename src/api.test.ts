import { describe, expect, it, vi } from 'vitest'
import type { AnalysisProgress } from '../shared/types'
import { waitForAnalysis } from './api'

describe('waitForAnalysis', () => {
  it('polls until the background result is complete', async () => {
    const progress: AnalysisProgress[] = [
      { status: 'running', stage: 'ai_extraction', updatedAt: '2026-08-07T00:00:00.000Z' },
      { status: 'completed', stage: 'completed', updatedAt: '2026-08-07T00:00:01.000Z', result: { events: [] } },
    ]
    const getProgress = vi.fn(async () => progress.shift()!)
    const onProgress = vi.fn()

    await expect(waitForAnalysis(getProgress, onProgress, 0)).resolves.toEqual({ events: [] })
    expect(getProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('surfaces a background failure', async () => {
    const getProgress = vi.fn(async (): Promise<AnalysisProgress> => ({
      status: 'failed', stage: 'preparing_review', updatedAt: '2026-08-07T00:00:00.000Z', error: '分析失敗',
    }))

    await expect(waitForAnalysis(getProgress, vi.fn(), 0)).rejects.toThrow('分析失敗')
  })

})
