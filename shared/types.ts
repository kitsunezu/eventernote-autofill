export type DraftStatus = 'review' | 'ready' | 'submitting' | 'completed' | 'failed'
export type Confidence = 'high' | 'medium' | 'low' | 'missing'
export type SourceKind = 'official' | 'ticketing' | 'x' | 'facebook' | 'instagram' | 'eventernote' | 'other'
export type DescriptionLanguage = 'ja' | 'zh-Hant' | 'zh-Hans' | 'en' | 'ko'
export type AnalysisStage =
  | 'fetching_source'
  | 'following_links'
  | 'preparing_images'
  | 'ai_extraction'
  | 'building_drafts'
  | 'completed'

export interface Evidence {
  value: string
  source: string
  confidence: Confidence
}

export interface EntityCandidate {
  id: string
  name: string
  url: string
  similarity: number
}

export interface ActorDraft {
  name: string
  reading: string
  selectedId: string
  createNew: boolean
  candidates: EntityCandidate[]
}

export interface PlaceDraft {
  name: string
  address: string
  countryCode: string
  selectedId: string
  createNew: boolean
  candidates: EntityCandidate[]
}

export interface EventData {
  title: string
  date: string
  openTime: string
  startTime: string
  endTime: string
  description: string
  officialUrl: string
  imageUrl: string
  descriptionLanguage: DescriptionLanguage
  uploadedImage?: {
    fileName: string
    mimeType: string
    size: number
  }
  place: PlaceDraft
  actors: ActorDraft[]
}

export interface Draft {
  id: string
  sourceUrl: string
  sourceTitle: string
  sourceKind: SourceKind
  status: DraftStatus
  data: EventData
  evidence: Partial<Record<string, Evidence>>
  warnings: string[]
  revision: number
  createdAt: string
  updatedAt: string
  submittedEventId?: string
  submittedEventUrl?: string
  imageAdded?: boolean
  error?: string
}

export interface AppConfig {
  authRequired: boolean
  aiConfigured: boolean
  eventernoteConfigured: boolean
  eventernoteWriteEnabled: boolean
  dashboardConfigured: boolean
}

export interface AnalyzeRequest {
  url: string
  analysisId: string
}

export interface AnalysisProgress {
  stage: AnalysisStage
  updatedAt: string
}

export interface AnalyzeResult {
  drafts: Draft[]
  diagnostics?: {
    crawlerResult: Pick<Draft, 'sourceTitle' | 'data' | 'evidence' | 'warnings'> & {
      finalUrl: string
      fetchWarning?: string
      linkedSources?: string[]
      aiImageCount?: number
    }
    aiResponse: unknown | null
    aiError?: string
  }
}

export interface ExecuteResult {
  draft: Draft
  steps: Array<{ label: string; status: 'completed' | 'skipped'; url?: string }>
}
