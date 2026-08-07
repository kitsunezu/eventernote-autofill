import type { AnalysisProgress, AnalysisStage, AnalyzeResult } from '../shared/types.js'

export class AnalysisJobs {
  private readonly jobs = new Map<string, AnalysisProgress>()

  constructor(private readonly ttlMs = 10 * 60_000) {}

  start(id: string): boolean {
    this.prune()
    if (this.jobs.has(id)) return false
    this.jobs.set(id, { status: 'running', stage: 'fetching_source', updatedAt: new Date().toISOString() })
    return true
  }

  setStage(id: string, stage: AnalysisStage): void {
    const current = this.jobs.get(id)
    if (!current || current.status !== 'running') return
    this.jobs.set(id, { ...current, stage, updatedAt: new Date().toISOString() })
  }

  complete(id: string, result: AnalyzeResult): void {
    this.jobs.set(id, { status: 'completed', stage: 'completed', result, updatedAt: new Date().toISOString() })
  }

  fail(id: string, stage: AnalysisStage, error: string): void {
    this.jobs.set(id, { status: 'failed', stage, error, updatedAt: new Date().toISOString() })
  }

  get(id: string): AnalysisProgress | undefined {
    this.prune()
    return this.jobs.get(id)
  }

  take(id: string): AnalysisProgress | undefined {
    const progress = this.get(id)
    if (progress && progress.status !== 'running') this.jobs.delete(id)
    return progress
  }

  private prune(): void {
    const expiry = Date.now() - this.ttlMs
    for (const [id, progress] of this.jobs) {
      if (Date.parse(progress.updatedAt) < expiry) this.jobs.delete(id)
    }
  }
}
