import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { z } from 'zod'
import type {
  AnalysisStage, AnalyzeResult, EventData, ReviewEvent, SubmissionImage, SubmissionProgress, SubmissionResult,
} from '../shared/types.js'
import { addHoursToTime } from '../shared/time.js'
import {
  eventernoteCandidateSearchWarnings, EVENTERNOTE_CANDIDATE_SEARCH_WARNING,
} from '../shared/submission.js'
import { AnalysisJobs } from './analysis-jobs.js'
import { extractEventsWithAi, resolveEventernoteEntities } from './ai.js'
import { loadConfig } from './config.js'
import { EventernoteClient } from './eventernote.js'
import { uploadEventImageAsJpeg } from './event-image.js'
import { loadImagePreview, validImageSignature } from './image-preview.js'
import { classifySource, inferCountry, isOnlineOnlyEvent, languageForCountry } from './location.js'
import { extractRelevantPageText, parseEventPage } from './parser.js'
import { safeFetchHtml, safeFetchImage } from './safe-fetch.js'
import { extractSourceReferences, selectBestParsedSource } from './source-discovery.js'

const config = loadConfig()
const eventernote = new EventernoteClient(
  config.eventernoteOrigin,
  config.eventernoteUsername,
  config.eventernotePassword,
)
const analyses = new AnalysisJobs()
const ACTOR_METADATA_RETRY_WARNING_PREFIX = 'AI 尚未完整補全新出演者'

function setAnalysisStage(analysisId: string, stage: AnalysisStage): void {
  analyses.setStage(analysisId, stage)
}

const ActorSchema = z.object({
  name: z.string().trim().max(200),
  reading: z.string().trim().max(200),
  searchKeywords: z.string().trim().max(500).default(''),
  sex: z.enum(['', '1', '2', '3']).default(''),
  selectedId: z.string().regex(/^\d*$/),
  createNew: z.boolean(),
  candidates: z.array(z.object({
    id: z.string(), name: z.string(), url: z.string(), similarity: z.number(),
  })).max(10),
})
const EventDataSchema = z.object({
  title: z.string().trim().max(500),
  date: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/),
  openTime: z.string().regex(/^$|^\d{2}:\d{2}$/),
  startTime: z.string().regex(/^$|^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^$|^\d{2}:\d{2}$/),
  description: z.string().max(10_000),
  officialUrl: z.string().max(2_000),
  imageUrl: z.string().max(2_000),
  descriptionLanguage: z.enum(['ja', 'zh-Hant', 'zh-Hans', 'en', 'ko']),
  uploadedImage: z.object({
    fileName: z.string().max(255), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']), size: z.number().int().positive().max(5_000_000),
  }).optional(),
  place: z.object({
    name: z.string().trim().max(300),
    address: z.string().trim().max(500),
    countryCode: z.string().regex(/^$|^[A-Z]{2}$/),
    selectedId: z.string().regex(/^\d*$/),
    createNew: z.boolean(),
    candidates: z.array(z.object({
      id: z.string(), name: z.string(), url: z.string(), similarity: z.number(),
    })).max(10),
  }),
  actors: z.array(ActorSchema).max(100),
})
const EvidenceSchema = z.object({
  value: z.string().max(10_000),
  source: z.string().max(2_000),
  confidence: z.enum(['high', 'medium', 'low', 'missing']),
})
const SubmissionProgressSchema = z.object({
  eventId: z.string().regex(/^\d+$/).optional(),
  eventUrl: z.string().url().max(2_000).optional(),
  imageAdded: z.boolean().optional(),
  completed: z.boolean().optional(),
})
const SubmissionImageSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  base64: z.string().max(6_700_000),
})

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('Request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function authorized(request: IncomingMessage): boolean {
  if (!config.appToken) return true
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
  const expectedBuffer = Buffer.from(config.appToken)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function requiredWarnings(data: EventData, includeEntitySelection = true): string[] {
  const warnings: string[] = []
  if (!data.title) warnings.push('活動名稱必須填寫')
  if (!data.date) warnings.push('活動日期必須填寫')
  if (!data.startTime) warnings.push('開演時間必須填寫')
  if (!data.place.name && !data.place.selectedId) warnings.push('開催場所必須填寫或選擇現有項目')
  if (data.actors.length === 0) warnings.push('未設定出演者，請確認活動確實沒有出演者')
  for (const actor of data.actors) if (!actor.name && !actor.selectedId) warnings.push('出演者名稱不可留空')
  for (const actor of data.actors) {
    if (actor.name && actor.createNew && (!actor.reading || !actor.searchKeywords || !actor.sex)) {
      warnings.push(`${ACTOR_METADATA_RETRY_WARNING_PREFIX}「${actor.name}」的登錄資料；提交前會自動重試`)
    }
  }
  if (includeEntitySelection) {
    if (data.place.name && !data.place.selectedId && !data.place.createNew) warnings.push('請確認使用現有場所，或建立新場所')
    for (const actor of data.actors) {
      if (actor.name && !actor.selectedId && !actor.createNew) warnings.push(`請確認出演者「${actor.name}」使用現有項目或建立新項目`)
    }
  }
  return warnings
}

function needsLinkedSource(data: EventData, sourceKind: ReturnType<typeof classifySource>): boolean {
  return sourceKind === 'x' || sourceKind === 'facebook' || sourceKind === 'instagram'
    || !data.date || !data.startTime || !data.place.name || data.actors.length === 0
}

async function searchEntityCandidates(name: string, kind: 'place' | 'actor'): Promise<EventData['place']['candidates']> {
  const shortName = name.replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim()
  const queries = [...new Set([name.trim(), shortName].filter(Boolean))]
  const candidateSets = await Promise.all(queries.map((query) => eventernote.searchEntities(query, kind)))
  const unique = new Map<string, EventData['place']['candidates'][number]>()
  for (const candidate of candidateSets.flat()) {
    const previous = unique.get(candidate.id)
    if (!previous || candidate.similarity > previous.similarity) unique.set(candidate.id, candidate)
  }
  return [...unique.values()].sort((left, right) => right.similarity - left.similarity).slice(0, 10)
}

function eventSeriesQuery(title: string): string {
  const series = title.replace(/\s+[—–-].*$/, '').replace(/[!！]+$/, '').trim()
  return series || title.trim()
}

async function prepareReview(review: ReviewEvent): Promise<ReviewEvent> {
  const candidateSearchWarnings = new Set<string>()
  const safeCandidateSearch = async (name: string, kind: 'place' | 'actor') => {
    try {
      return await searchEntityCandidates(name, kind)
    } catch {
      candidateSearchWarnings.add(EVENTERNOTE_CANDIDATE_SEARCH_WARNING)
      return []
    }
  }
  const [placeCandidates, contextualActorCandidates, ...searchedActorCandidates] = await Promise.all([
    safeCandidateSearch(review.data.place.name, 'place'),
    eventernote.searchActorsFromEvent(eventSeriesQuery(review.data.title), review.data.actors.map((actor) => actor.name))
      .catch(() => {
        candidateSearchWarnings.add(EVENTERNOTE_CANDIDATE_SEARCH_WARNING)
        return review.data.actors.map(() => [])
      }),
    ...review.data.actors.map((actor) => safeCandidateSearch(actor.name, 'actor')),
  ])
  review.data.place.candidates = placeCandidates
  review.data.actors.forEach((actor, index) => {
    const candidates = new Map((searchedActorCandidates[index] ?? []).map((candidate) => [candidate.id, candidate]))
    for (const candidate of contextualActorCandidates[index] ?? []) {
      const previous = candidates.get(candidate.id)
      if (!previous || candidate.similarity > previous.similarity) candidates.set(candidate.id, candidate)
    }
    actor.candidates = [...candidates.values()].sort((left, right) => right.similarity - left.similarity).slice(0, 10)
  })
  const exactPlaceCandidates = review.data.place.candidates.filter((candidate) => candidate.similarity === 1)
  if (!review.data.place.selectedId && !review.data.place.createNew && exactPlaceCandidates.length === 1) {
    const [candidate] = exactPlaceCandidates
    review.data.place.selectedId = candidate.id
    review.evidence['place.selection'] = {
      value: `使用現有：${candidate.name}`, source: 'Eventernote 唯一同名場所', confidence: 'high',
    }
  }
  review.data.actors.forEach((actor, index) => {
    const exactCandidates = actor.candidates.filter((candidate) => candidate.similarity === 1)
    if (actor.selectedId || actor.createNew || exactCandidates.length !== 1) return
    const [candidate] = exactCandidates
    actor.selectedId = candidate.id
    review.evidence[`actors.${index}.selection`] = {
      value: `使用現有：${candidate.name}`, source: 'Eventernote 唯一同名出演者', confidence: 'high',
    }
  })
  let resolutionWarning = ''
  if (config.openAiApiKey && candidateSearchWarnings.size === 0) {
    try {
      const resolution = await resolveEventernoteEntities(
        config.openAiApiKey, config.openAiBaseUrl, config.openAiModel, review.sourceUrl, review.data,
      )
      review.data = resolution.data
      review.evidence = { ...review.evidence, ...resolution.evidence }
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知錯誤'
      resolutionWarning = `AI 實體判斷失敗：${detail}`
    }
  }
  if ((!config.openAiApiKey || resolutionWarning) && candidateSearchWarnings.size === 0) {
    if (!review.data.place.selectedId && placeCandidates.length === 0) review.data.place.createNew = true
    review.data.actors.forEach((actor) => {
      if (!actor.selectedId && actor.candidates.length === 0) actor.createNew = true
    })
  }
  review.warnings = [
    ...eventernoteCandidateSearchWarnings(review.data, candidateSearchWarnings.size > 0),
    ...(resolutionWarning ? [resolutionWarning] : []),
    ...requiredWarnings(review.data),
  ]
  return review
}

async function executeSubmission(
  inputData: EventData,
  inputProgress: SubmissionProgress,
  image?: SubmissionImage,
): Promise<SubmissionResult> {
  if (!config.eventernoteWriteEnabled) throw new Error('EVENTERNOTE_WRITE_ENABLED 尚未設為 true')
  const data = structuredClone(inputData)
  const progress = structuredClone(inputProgress)
  const steps: SubmissionResult['steps'] = []
  try {
    const actorsMissingMetadata = data.actors.filter((actor) => (
      actor.createNew && (!actor.reading || !actor.searchKeywords || !actor.sex)
    ))
    if (actorsMissingMetadata.length) {
      if (!config.openAiApiKey) throw new Error('伺服器未設定 OpenAI，無法補全新出演者資料')
      const completed = await resolveEventernoteEntities(
        config.openAiApiKey, config.openAiBaseUrl, config.openAiModel, data.officialUrl, data,
      )
      data.actors = completed.data.actors
    }
    for (const actor of data.actors) {
      if (!actor.createNew) continue
      const missing = [
        ...(!actor.reading ? ['よみがな'] : []),
        ...(!actor.searchKeywords ? ['検索キーワード'] : []),
        ...(!actor.sex ? ['性別'] : []),
      ]
      if (missing.length) {
        throw new Error(`AI 未能補全新出演者「${actor.name}」的 ${missing.join('、')}，尚未送出 Eventernote`)
      }
    }
    for (const actor of data.actors) {
      if (actor.selectedId) {
        steps.push({ label: `出演者：${actor.name}`, status: 'skipped' })
      } else {
        if (!actor.createNew) throw new Error(`出演者「${actor.name}」尚未決定使用既有項目或建立新項目`)
        const created = await eventernote.createActor(actor)
        actor.selectedId = created.id
        steps.push({ label: `出演者：${actor.name}`, status: 'completed', url: created.url })
      }
    }
    if (data.place.selectedId) {
      steps.push({ label: `場所：${data.place.name}`, status: 'skipped' })
    } else {
      if (!data.place.createNew) throw new Error('開催場所尚未決定使用既有項目或建立新項目')
      const created = await eventernote.createPlace(data.place)
      data.place.selectedId = created.id
      steps.push({ label: `場所：${data.place.name}`, status: 'completed', url: created.url })
    }
    if (!progress.eventId) {
      const created = await eventernote.createEvent(
        data,
        data.place.selectedId,
        data.actors.map((actor) => actor.selectedId),
      )
      progress.eventId = created.id
      progress.eventUrl = created.url
      steps.push({ label: `活動：${data.title}`, status: 'completed', url: created.url })
    } else {
      steps.push({ label: `活動：${data.title}`, status: 'skipped', url: progress.eventUrl })
    }
    const submittedEventId = progress.eventId
    if (!submittedEventId) throw new Error('Eventernote 活動尚未成功建立')
    if ((image || data.imageUrl) && !progress.imageAdded) {
      if (image) {
        const bytes = Buffer.from(image.base64, 'base64')
        if (bytes.byteLength > 5_000_000) throw new Error('圖片不可超過 5 MB')
        if (!validImageSignature(bytes, image.mimeType)) throw new Error('圖片內容與檔案格式不符')
        await uploadEventImageAsJpeg(eventernote, submittedEventId, { kind: 'uploaded', bytes })
      } else {
        await uploadEventImageAsJpeg(eventernote, submittedEventId, { kind: 'remote', url: data.imageUrl })
      }
      progress.imageAdded = true
      steps.push({ label: '活動圖片', status: 'completed', url: progress.eventUrl })
    }
    progress.completed = true
    return { data, progress, steps, completed: true }
  } catch (error) {
    return {
      data,
      progress,
      steps,
      completed: false,
      error: error instanceof Error ? error.message : '提交失敗',
    }
  }
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<boolean> {
  const root = join(process.cwd(), 'dist')
  const requested = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^([/\\])+/, '')
  let filePath = join(root, requested)
  if (!filePath.startsWith(root)) return false
  try {
    if (!(await stat(filePath)).isFile()) return false
  } catch {
    filePath = join(root, 'index.html')
    try { await stat(filePath) } catch { return false }
  }
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }
  response.writeHead(200, { 'Content-Type': `${mime[extname(filePath)] ?? 'application/octet-stream'}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' })
  createReadStream(filePath).pipe(response)
  return true
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, { ok: true })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/config') {
    json(response, 200, {
      authRequired: Boolean(config.appToken),
      aiConfigured: Boolean(config.openAiApiKey),
      eventernoteConfigured: Boolean(config.eventernoteUsername && config.eventernotePassword),
      eventernoteWriteEnabled: config.eventernoteWriteEnabled,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/verify') {
    json(response, authorized(request) ? 204 : 401, authorized(request) ? undefined : { error: '存取密鑰不正確' })
    return
  }
  if (url.pathname.startsWith('/api/') && !authorized(request)) {
    json(response, 401, { error: '需要有效的存取密鑰' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/entities/search') {
    const input = z.object({
      kind: z.enum(['place', 'actor']),
      query: z.string().trim().min(1).max(300),
    }).parse({ kind: url.searchParams.get('kind'), query: url.searchParams.get('query') })
    json(response, 200, await searchEntityCandidates(input.query, input.kind))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/image-preview') {
    const input = z.object({ url: z.string().url().max(2_000) }).parse(await readJson(request, 4_096))
    const image = await loadImagePreview(input.url)
    response.writeHead(200, {
      'Content-Type': image.mimeType,
      'Content-Length': image.bytes.byteLength,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
    })
    response.end(image.bytes)
    return
  }
  const analysisProgressRoute = url.pathname.match(/^\/api\/analyses\/([0-9a-f-]+)\/progress$/)
  if (request.method === 'GET' && analysisProgressRoute) {
    const progress = analyses.take(analysisProgressRoute[1])
    json(response, progress ? 200 : 404, progress ?? { error: '找不到分析進度' })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/analyze') {
    const input = z.object({ url: z.string().url(), analysisId: z.string().uuid() }).parse(await readJson(request))
    if (!analyses.start(input.analysisId)) {
      json(response, 409, { error: '分析工作識別碼已存在' })
      return
    }
    void (async () => {
      try {
        setAnalysisStage(input.analysisId, 'fetching_source')
        let sourceKind = classifySource(input.url)
    let finalUrl = input.url
    let html = ''
    let fetchWarning = ''
    try {
      const page = await safeFetchHtml(input.url)
      finalUrl = page.finalUrl
      sourceKind = classifySource(finalUrl)
      html = page.html
    } catch (error) {
      fetchWarning = error instanceof Error ? error.message : '無法直接讀取來源頁'
    }
    const sourceParsed = parseEventPage(html || '<html></html>', finalUrl)
    const references = html ? extractSourceReferences(html, finalUrl) : { linkedUrls: [], imageUrls: [] }
    const linkedPages: Array<{ html: string; finalUrl: string }> = []
    setAnalysisStage(input.analysisId, 'following_links')
    if (html && needsLinkedSource(sourceParsed.data, sourceKind)) {
      const linkedResults = await Promise.allSettled(references.linkedUrls.map((linkedUrl) => safeFetchHtml(linkedUrl)))
      for (const result of linkedResults) if (result.status === 'fulfilled') linkedPages.push(result.value)
    }
    const parsedSources = [
      sourceParsed,
      ...linkedPages.map((page) => parseEventPage(page.html, page.finalUrl)),
    ]
    const parsed = selectBestParsedSource(parsedSources)
    let eventResults = [{ data: parsed.data, evidence: parsed.evidence }]
    let aiResponse: unknown | null = null
    let aiWarning = ''
    let aiImageCount = 0
    if (config.openAiApiKey) {
      try {
        const pageText = [
          ...linkedPages.map((page) => `Discovered linked page: ${page.finalUrl}\n${extractRelevantPageText(page.html)}`),
          html ? `Submitted page: ${finalUrl}\n${extractRelevantPageText(html)}` : `Submitted page could not be read: ${fetchWarning}`,
        ].join('\n\n')
        const imageUrls = [...new Set([...references.imageUrls, parsed.data.imageUrl].filter(Boolean))].slice(0, 4)
        setAnalysisStage(input.analysisId, 'preparing_images')
        const imageResults = await Promise.allSettled(imageUrls.map((imageUrl) => safeFetchImage(imageUrl)))
        const images = imageResults.flatMap((result) => result.status === 'fulfilled'
          ? [{ bytes: result.value.bytes, mimeType: result.value.mimeType }]
          : [])
        aiImageCount = images.length
        setAnalysisStage(input.analysisId, 'ai_extraction')
        eventResults = await extractEventsWithAi(
          config.openAiApiKey, config.openAiBaseUrl, config.openAiModel, finalUrl, pageText, parsed.data,
          (response) => { aiResponse = response },
          images,
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : '未知錯誤'
        aiWarning = `OpenAI 核對失敗：${detail}`
      }
    }
    eventResults = eventResults.filter((result) => !isOnlineOnlyEvent(result.data))
    if (eventResults.length === 0) throw new Error('來源頁沒有可建立的實體會場場次')
    setAnalysisStage(input.analysisId, 'preparing_review')
    const events: ReviewEvent[] = eventResults.map((result) => {
      const inferredOpenTime = result.data.openTime ? '' : addHoursToTime(result.data.startTime, -1)
      const inferredEndTime = result.data.endTime ? '' : addHoursToTime(result.data.startTime, 2)
      const data = inferredOpenTime || inferredEndTime ? {
        ...result.data,
        openTime: inferredOpenTime || result.data.openTime,
        endTime: inferredEndTime || result.data.endTime,
      } : result.data
      const warnings = [
        ...(aiWarning ? [aiWarning] : []),
        ...(fetchWarning ? [`來源頁無法直接讀取：${fetchWarning}${config.openAiApiKey ? '；已改用 OpenAI 搜尋核對' : '；請手動填寫或設定 OpenAI'}`] : []),
        ...(!config.openAiApiKey ? parsed.warnings : []),
        ...requiredWarnings(data, false),
      ]
      return {
        id: randomUUID(), sourceUrl: finalUrl, sourceTitle: data.title || parsed.sourceTitle, sourceKind,
        data, evidence: {
          ...parsed.evidence,
          ...result.evidence,
          ...(inferredOpenTime ? { openTime: {
            value: inferredOpenTime,
            source: '依開演時間自動減 1 小時',
            confidence: 'low' as const,
          } } : {}),
          ...(inferredEndTime ? { endTime: {
            value: inferredEndTime,
            source: '依開演時間自動加 2 小時',
            confidence: 'low' as const,
          } } : {}),
        },
        warnings: [...new Set(warnings)],
      }
    })
    const preparedEvents: ReviewEvent[] = []
    for (const event of events) preparedEvents.push(await prepareReview(event))
        const result: AnalyzeResult = {
          events: preparedEvents,
          diagnostics: {
            crawlerResult: {
              finalUrl,
              linkedSources: linkedPages.map((page) => page.finalUrl),
              aiImageCount,
              ...(fetchWarning ? { fetchWarning } : {}),
              sourceTitle: parsed.sourceTitle,
              data: parsed.data,
              evidence: parsed.evidence,
              warnings: parsed.warnings,
            },
            aiResponse,
            ...(aiWarning ? { aiError: aiWarning } : {}),
          },
        }
        analyses.complete(input.analysisId, result)
      } catch (error) {
        const progress = analyses.get(input.analysisId)
        const stage = progress?.stage ?? 'fetching_source'
        const message = error instanceof Error ? error.message : '分析失敗'
        analyses.fail(input.analysisId, stage, message)
        console.error('Background analysis failed', error)
      }
    })()
    json(response, 202, { analysisId: input.analysisId })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/submission/check') {
    const body = z.object({
      sourceUrl: z.string().url().max(2_000),
      data: EventDataSchema,
      evidence: z.record(EvidenceSchema).optional(),
    }).parse(await readJson(request))
    const data = structuredClone(body.data)
    const inferredCountry = inferCountry(`${data.place.name} ${data.place.address}`)
    if (inferredCountry) {
      data.place.countryCode = inferredCountry
      data.descriptionLanguage = languageForCountry(inferredCountry)
    }
    const review = await prepareReview({
      id: randomUUID(),
      sourceUrl: body.sourceUrl,
      sourceTitle: data.title,
      sourceKind: classifySource(body.sourceUrl),
      data,
      evidence: body.evidence ?? {},
      warnings: [],
    })
    const blockingWarnings = review.warnings.filter((warning) => (
      !warning.startsWith('未設定出演者') && !warning.startsWith(ACTOR_METADATA_RETRY_WARNING_PREFIX)
    ))
    json(response, 200, {
      data: review.data,
      evidence: review.evidence,
      warnings: review.warnings,
      ready: blockingWarnings.length === 0,
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/submission') {
    const body = z.object({
      data: EventDataSchema,
      progress: SubmissionProgressSchema.optional(),
      image: SubmissionImageSchema.optional(),
    }).parse(await readJson(request, 8_000_000))
    const blockingWarnings = requiredWarnings(body.data).filter((warning) => (
      !warning.startsWith('未設定出演者') && !warning.startsWith(ACTOR_METADATA_RETRY_WARNING_PREFIX)
    ))
    if (blockingWarnings.length) {
      json(response, 400, { error: blockingWarnings.join('；') })
      return
    }
    if (body.data.uploadedImage && !body.image && !body.progress?.imageAdded) {
      json(response, 400, { error: '找不到瀏覽器中的上傳圖片，請重新選擇圖片' })
      return
    }
    json(response, 200, await executeSubmission(body.data, body.progress ?? {}, body.image))
    return
  }
  if (url.pathname.startsWith('/api/')) {
    json(response, 404, { error: 'Not found' })
    return
  }
  if (!(await serveStatic(url.pathname, response))) json(response, 404, { error: 'Web build not found; run npm run dev or npm run build' })
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    console.error('Request failed', error)
    if (!response.headersSent) json(response, error instanceof z.ZodError ? 400 : 500, {
      error: error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join('; ') : error instanceof Error ? error.message : '伺服器錯誤',
    })
  })
})
server.listen(config.port, '0.0.0.0', () => console.log(`Eventernote Autofill listening on http://0.0.0.0:${config.port}`))

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
