import type { AnalysisProgress, AnalyzeResult, AppConfig, Draft, EventData, ExecuteResult } from '../shared/types'

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

export const api = {
  config: () => request<AppConfig>('/api/config'),
  verify: () => request<void>('/api/auth/verify', { method: 'POST' }),
  listDrafts: () => request<Draft[]>('/api/drafts'),
  analyze: (url: string, analysisId: string) => request<AnalyzeResult>('/api/drafts/analyze', {
    method: 'POST', body: JSON.stringify({ url, analysisId }),
  }),
  analysisProgress: (analysisId: string) => request<AnalysisProgress>(`/api/analyses/${analysisId}/progress`),
  save: (id: string, data: EventData) => request<Draft>(`/api/drafts/${id}`, {
    method: 'PUT', body: JSON.stringify(data),
  }),
  remove: (id: string) => request<void>(`/api/drafts/${id}`, { method: 'DELETE' }),
  uploadImage: (id: string, file: File) => request<Draft>(`/api/drafts/${id}/image`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  }),
  removeImage: (id: string) => request<Draft>(`/api/drafts/${id}/image`, { method: 'DELETE' }),
  imageBlob: async (id: string) => {
    const accessKey = getAccessKey()
    const response = await fetch(`/api/drafts/${id}/image`, {
      headers: accessKey ? { 'Authorization': `Bearer ${accessKey}` } : {},
    })
    if (!response.ok) throw new Error('無法載入已上傳圖片')
    return response.blob()
  },
  prepare: (id: string) => request<Draft>(`/api/drafts/${id}/prepare`, { method: 'POST' }),
  confirm: (id: string) => request<{ confirmationToken: string }>(`/api/drafts/${id}/confirm`, { method: 'POST' }),
  execute: (id: string, confirmationToken: string) => request<ExecuteResult>(`/api/drafts/${id}/execute`, {
    method: 'POST', body: JSON.stringify({ confirmationToken }),
  }),
}
