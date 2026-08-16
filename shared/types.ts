export type Confidence = 'high' | 'medium' | 'low' | 'missing'
export type SourceKind = 'official' | 'ticketing' | 'x' | 'facebook' | 'instagram' | 'eventernote' | 'other'
export type DescriptionLanguage = 'ja' | 'zh-Hant' | 'zh-Hans' | 'en' | 'ko'
export type ActorSex = '' | '1' | '2' | '3'
export type AnalysisStage =
  | 'fetching_source'
  | 'following_links'
  | 'preparing_images'
  | 'ai_extraction'
  | 'preparing_review'
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

export interface ActorData {
  name: string
  /** Filled by the server for new performers; never collected from the user. */
  reading: string
  /** Comma-separated aliases filled by the server for new performers. */
  searchKeywords: string
  /** Eventernote sex code: 1 female, 2 male, 3 mixed. Filled by the server. */
  sex: ActorSex
  selectedId: string
  createNew: boolean
  candidates: EntityCandidate[]
}

export interface PlaceData {
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
  place: PlaceData
  actors: ActorData[]
}

export interface SubmissionProgress {
  eventId?: string
  eventUrl?: string
  eventAction?: 'created' | 'existing' | 'updated'
  imageAdded?: boolean
  completed?: boolean
}

export interface ExistingEventReference {
  id: string
  url: string
  complete: boolean
  missingFields: string[]
}

export interface ReviewEvent {
  id: string
  sourceUrl: string
  sourceTitle: string
  sourceKind: SourceKind
  data: EventData
  evidence: Partial<Record<string, Evidence>>
  warnings: string[]
  existingEvent?: ExistingEventReference
  submission?: SubmissionProgress
  error?: string
}

export interface AppConfig {
  authRequired: boolean
  aiConfigured: boolean
  eventernoteConfigured: boolean
  eventernoteWriteEnabled: boolean
}

export interface AnalyzeRequest {
  url: string
  analysisId: string
}

export interface AnalyzeResult {
  events: ReviewEvent[]
  diagnostics?: {
    crawlerResult: Pick<ReviewEvent, 'sourceTitle' | 'data' | 'evidence' | 'warnings'> & {
      finalUrl: string
      fetchWarning?: string
      linkedSources?: string[]
      aiImageCount?: number
    }
    aiResponse: unknown | null
    aiError?: string
  }
}

export type AnalysisProgress =
  | { status: 'running'; stage: AnalysisStage; updatedAt: string }
  | { status: 'completed'; stage: 'completed'; updatedAt: string; result: AnalyzeResult }
  | { status: 'failed'; stage: AnalysisStage; updatedAt: string; error: string }

export interface SubmissionImage {
  fileName: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  base64: string
}

export interface SubmissionCheckResult {
  data: EventData
  evidence: ReviewEvent['evidence']
  warnings: string[]
  ready: boolean
  existingEvent?: ExistingEventReference
}

export interface SubmissionResult {
  data: EventData
  progress: SubmissionProgress
  steps: Array<{ label: string; status: 'completed' | 'skipped'; url?: string }>
  completed: boolean
  error?: string
}
