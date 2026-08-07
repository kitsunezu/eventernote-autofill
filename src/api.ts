import type {
  AnalysisProgress, AnalyzeResult, AppConfig, EntityCandidate, EventData, ReviewEvent, SubmissionImage,
  SubmissionProgress, SubmissionCheckResult, SubmissionResult,
} from '../shared/types'

const KEY = 'eventernote-autofill:access-key'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function getAccessKey(): string {
  return sessionStorage.getItem(KEY) ?? ''
}

export function setAccessKey(value: string): void {
  if (value) sessionStorage.setItem(KEY, value)
  else sessionStorage.removeItem(KEY)
}

export async function waitForAnalysis(
  getProgress: () => Promise<AnalysisProgress>,
  onProgress: (progress: AnalysisProgress) => void,
  pollIntervalMs = 500,
): Promise<AnalyzeResult> {
  let consecutiveFailures = 0
  while (true) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, pollIntervalMs))
    let progress: AnalysisProgress
    try {
      progress = await getProgress()
      consecutiveFailures = 0
    } catch (error) {
      consecutiveFailures += 1
      if (consecutiveFailures >= 3) throw error
      continue
    }
    onProgress(progress)
    if (progress.status === 'completed') return progress.result
    if (progress.status === 'failed') throw new Error(progress.error)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const accessKey = getAccessKey()
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(accessKey ? { 'Authorization': `Bearer ${accessKey}` } : {}),
      ...init?.headers,
    },
  })
  if (response.status === 204) return undefined as T
  const payload = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new ApiError(payload.error ?? `HTTP ${response.status}`, response.status)
  return payload
}

async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  const accessKey = getAccessKey()
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(accessKey ? { 'Authorization': `Bearer ${accessKey}` } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new ApiError(payload.error ?? `HTTP ${response.status}`, response.status)
  }
  return response.blob()
}

export const api = {
  config: () => request<AppConfig>('/api/config'),
  verify: () => request<void>('/api/auth/verify', { method: 'POST' }),
  startAnalysis: (url: string, analysisId: string) => request<{ analysisId: string }>('/api/analyze', {
    method: 'POST', body: JSON.stringify({ url, analysisId }),
  }),
  analysisProgress: (analysisId: string) => request<AnalysisProgress>(`/api/analyses/${analysisId}/progress`),
  searchEntities: (kind: 'place' | 'actor', query: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ kind, query })
    return request<EntityCandidate[]>(`/api/entities/search?${params}`, { signal })
  },
  checkSubmission: (sourceUrl: string, data: EventData, evidence: ReviewEvent['evidence']) => request<SubmissionCheckResult>('/api/submission/check', {
    method: 'POST', body: JSON.stringify({ sourceUrl, data, evidence }),
  }),
  imagePreview: (url: string, signal?: AbortSignal) => requestBlob('/api/image-preview', {
    method: 'POST', body: JSON.stringify({ url }), signal,
  }),
  submit: (data: EventData, progress: SubmissionProgress, image?: SubmissionImage) => request<SubmissionResult>('/api/submission', {
    method: 'POST', body: JSON.stringify({ data, progress, image }),
  }),
}
