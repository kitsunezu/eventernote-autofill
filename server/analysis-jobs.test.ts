import { describe, expect, it, vi } from 'vitest'
import { AnalysisJobs } from './analysis-jobs.js'

describe('AnalysisJobs', () => {
  it('tracks a background analysis through completion', () => {
    const jobs = new AnalysisJobs()
    expect(jobs.start('analysis-1')).toBe(true)
    expect(jobs.start('analysis-1')).toBe(false)

    jobs.setStage('analysis-1', 'ai_extraction')
    expect(jobs.get('analysis-1')).toMatchObject({ status: 'running', stage: 'ai_extraction' })

    const result = { events: [] }
    jobs.complete('analysis-1', result)
    expect(jobs.get('analysis-1')).toMatchObject({ status: 'completed', stage: 'completed', result })
  })

  it('retains a failed stage and removes expired jobs', () => {
    vi.useFakeTimers()
    try {
      const jobs = new AnalysisJobs(1_000)
      jobs.start('analysis-2')
      jobs.setStage('analysis-2', 'preparing_review')
      jobs.fail('analysis-2', 'preparing_review', 'boom')
      expect(jobs.get('analysis-2')).toMatchObject({ status: 'failed', stage: 'preparing_review', error: 'boom' })

      vi.advanceTimersByTime(1_001)
      expect(jobs.get('analysis-2')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes a completed result after delivering it to the browser', () => {
    const jobs = new AnalysisJobs()
    jobs.start('analysis-3')
    jobs.complete('analysis-3', { events: [] })

    expect(jobs.take('analysis-3')).toMatchObject({ status: 'completed' })
    expect(jobs.get('analysis-3')).toBeUndefined()
  })
})
