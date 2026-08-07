import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { z } from 'zod'
import type { AnalysisProgress, AnalysisStage, Draft, EventData } from '../shared/types.js'
import { addHoursToTime } from '../shared/time.js'
import { extractEventsWithAi, resolveEventernoteEntities } from './ai.js'
import { loadConfig } from './config.js'
import { syncDashboard } from './dashboard.js'
import { EventernoteClient } from './eventernote.js'
import { classifySource, inferCountry, isOnlineOnlyEvent, languageForCountry } from './location.js'
import { extractRelevantPageText, parseEventPage } from './parser.js'
import { safeFetchHtml, safeFetchImage } from './safe-fetch.js'
import { extractSourceReferences, selectBestParsedSource } from './source-discovery.js'
import { DraftStore } from './store.js'

const config = loadConfig()
const store = new DraftStore()
const eventernote = new EventernoteClient(
  config.eventernoteOrigin,
  config.eventernoteUsername,
  config.eventernotePassword,
)
const confirmations = new Map<string, { draftId: string; revision: number; hash: string; expiresAt: number }>()
const analyses = new Map<string, AnalysisProgress>()

function setAnalysisStage(analysisId: string, stage: AnalysisStage): void {
  const expiry = Date.now() - 10 * 60_000
  for (const [id, progress] of analyses) {
    if (Date.parse(progress.updatedAt) < expiry) analyses.delete(id)
  }
  analyses.set(analysisId, { stage, updatedAt: new Date().toISOString() })
}

const ActorSchema = z.object({
  name: z.string().trim().max(200),
  reading: z.string().trim().max(200),
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new Error('Request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error(`檔案超過 ${Math.floor(limit / 1_000_000)} MB 限制`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function authorized(request: IncomingMessage): boolean {
  if (!config.appToken) return true
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
  const expectedBuffer = Buffer.from(config.appToken)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function dataHash(data: EventData): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

function requiredWarnings(data: EventData, includeEntitySelection = true): string[] {
  const warnings: string[] = []
  if (!data.title) warnings.push('活動名稱必須填寫')
  if (!data.date) warnings.push('活動日期必須填寫')
  if (!data.startTime) warnings.push('開演時間必須填寫')
  if (!data.place.name && !data.place.selectedId) warnings.push('開催場所必須填寫或選擇現有項目')
  if (data.actors.length === 0) warnings.push('未設定出演者，請確認活動確實沒有出演者')
  for (const actor of data.actors) if (!actor.name && !actor.selectedId) warnings.push('出演者名稱不可留空')
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

async function prepareDraft(draft: Draft): Promise<Draft> {
  const [placeCandidates, contextualActorCandidates, ...searchedActorCandidates] = await Promise.all([
    searchEntityCandidates(draft.data.place.name, 'place'),
    eventernote.searchActorsFromEvent(eventSeriesQuery(draft.data.title), draft.data.actors.map((actor) => actor.name))
      .catch(() => draft.data.actors.map(() => [])),
    ...draft.data.actors.map((actor) => searchEntityCandidates(actor.name, 'actor')),
  ])
  draft.data.place.candidates = placeCandidates
  draft.data.actors.forEach((actor, index) => {
    const candidates = new Map((searchedActorCandidates[index] ?? []).map((candidate) => [candidate.id, candidate]))
    for (const candidate of contextualActorCandidates[index] ?? []) {
      const previous = candidates.get(candidate.id)
      if (!previous || candidate.similarity > previous.similarity) candidates.set(candidate.id, candidate)
    }
    actor.candidates = [...candidates.values()].sort((left, right) => right.similarity - left.similarity).slice(0, 10)
  })
  const exactPlaceCandidates = draft.data.place.candidates.filter((candidate) => candidate.similarity === 1)
  if (!draft.data.place.selectedId && !draft.data.place.createNew && exactPlaceCandidates.length === 1) {
    const [candidate] = exactPlaceCandidates
    draft.data.place.selectedId = candidate.id
    draft.evidence['place.selection'] = {
      value: `使用現有：${candidate.name}`, source: 'Eventernote 唯一同名場所', confidence: 'high',
    }
  }
  draft.data.actors.forEach((actor, index) => {
    const exactCandidates = actor.candidates.filter((candidate) => candidate.similarity === 1)
    if (actor.selectedId || actor.createNew || exactCandidates.length !== 1) return
    const [candidate] = exactCandidates
    actor.selectedId = candidate.id
    draft.evidence[`actors.${index}.selection`] = {
      value: `使用現有：${candidate.name}`, source: 'Eventernote 唯一同名出演者', confidence: 'high',
    }
  })
  let resolutionWarning = ''
  if (config.openAiApiKey) {
    try {
      const resolution = await resolveEventernoteEntities(
        config.openAiApiKey, config.openAiBaseUrl, config.openAiModel, draft.sourceUrl, draft.data,
      )
      draft.data = resolution.data
      draft.evidence = { ...draft.evidence, ...resolution.evidence }
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知錯誤'
      resolutionWarning = `AI 實體判斷失敗：${detail}`
    }
  }
  if (!config.openAiApiKey || resolutionWarning) {
    if (!draft.data.place.selectedId && placeCandidates.length === 0) draft.data.place.createNew = true
    draft.data.actors.forEach((actor) => {
      if (!actor.selectedId && actor.candidates.length === 0) actor.createNew = true
    })
  }
  draft.warnings = [...(resolutionWarning ? [resolutionWarning] : []), ...requiredWarnings(draft.data)]
  draft.status = draft.warnings.filter((warning) => !warning.startsWith('未設定出演者')).length ? 'review' : 'ready'
  draft.revision += 1
  draft.updatedAt = new Date().toISOString()
  return store.save(draft)
}

async function executeDraft(draft: Draft): Promise<Array<{ label: string; status: 'completed' | 'skipped'; url?: string }>> {
  if (!config.eventernoteWriteEnabled) throw new Error('EVENTERNOTE_WRITE_ENABLED 尚未設為 true')
  if (!config.dashboardUrl || !config.dashboardToken || !config.dashboardUserId) throw new Error('活動清單服務尚未完成設定')
  const steps: Array<{ label: string; status: 'completed' | 'skipped'; url?: string }> = []
  draft.status = 'submitting'
  draft.error = undefined
  await store.save(draft)
  try {
    if (!draft.submittedEventId) {
      let duplicateEvent: Awaited<ReturnType<EventernoteClient['findDuplicateEvent']>>
      try {
        duplicateEvent = await eventernote.findDuplicateEvent(draft.data)
      } catch (error) {
        const detail = error instanceof Error ? error.message : '未知錯誤'
        throw new Error(`Eventernote 重複活動檢查失敗，為避免任何前置寫入，本次未送出：${detail}`)
      }
      if (duplicateEvent) {
        throw new Error(`Eventernote 已有相同活動，未送出任何新資料：${duplicateEvent.name} ${duplicateEvent.url}。請使用既有活動；如確定不是同一活動，修正名稱、日期或場所後重新確認。`)
      }
    }
    for (const actor of draft.data.actors) {
      if (actor.selectedId) {
        steps.push({ label: `出演者：${actor.name}`, status: 'skipped' })
      } else {
        if (!actor.createNew) throw new Error(`出演者「${actor.name}」尚未決定使用既有項目或建立新項目`)
        const created = await eventernote.createActor(actor)
        actor.selectedId = created.id
        draft.updatedAt = new Date().toISOString()
        await store.save(draft)
        steps.push({ label: `出演者：${actor.name}`, status: 'completed', url: created.url })
      }
    }
    if (draft.data.place.selectedId) {
      steps.push({ label: `場所：${draft.data.place.name}`, status: 'skipped' })
    } else {
      if (!draft.data.place.createNew) throw new Error('開催場所尚未決定使用既有項目或建立新項目')
      const created = await eventernote.createPlace(draft.data.place)
      draft.data.place.selectedId = created.id
      draft.updatedAt = new Date().toISOString()
      await store.save(draft)
      steps.push({ label: `場所：${draft.data.place.name}`, status: 'completed', url: created.url })
    }
    if (!draft.submittedEventId) {
      const created = await eventernote.createEvent(
        draft.data,
        draft.data.place.selectedId,
        draft.data.actors.map((actor) => actor.selectedId),
      )
      draft.submittedEventId = created.id
      draft.submittedEventUrl = created.url
      draft.updatedAt = new Date().toISOString()
      await store.save(draft)
      steps.push({ label: `活動：${draft.data.title}`, status: 'completed', url: created.url })
    } else {
      steps.push({ label: `活動：${draft.data.title}`, status: 'skipped', url: draft.submittedEventUrl })
    }
    const submittedEventId = draft.submittedEventId
    if (!submittedEventId) throw new Error('Eventernote 活動尚未成功建立')
    if ((draft.data.uploadedImage || draft.data.imageUrl) && !draft.imageAdded) {
      let bytes: Uint8Array
      let mimeType: string
      let fileName: string
      if (draft.data.uploadedImage) {
        bytes = await readFile(uploadPath(draft.id, draft.data.uploadedImage.mimeType))
        mimeType = draft.data.uploadedImage.mimeType
        fileName = draft.data.uploadedImage.fileName
      } else {
        const downloaded = await safeFetchImage(draft.data.imageUrl)
        bytes = downloaded.bytes
        mimeType = downloaded.mimeType
        fileName = `event.${extensionForMime(mimeType)}`
      }
      await eventernote.addEventImage(submittedEventId, bytes, mimeType, fileName)
      draft.imageAdded = true
      draft.updatedAt = new Date().toISOString()
      await store.save(draft)
      steps.push({ label: '活動圖片', status: 'completed', url: draft.submittedEventUrl })
    }
    if (config.dashboardUrl && config.dashboardToken && config.dashboardUserId) {
      await syncDashboard(config.dashboardUrl, config.dashboardToken, config.dashboardUserId, draft)
      steps.push({ label: 'Dashboard 同步', status: 'completed' })
    } else {
      steps.push({ label: 'Dashboard 同步（未設定）', status: 'skipped' })
    }
    draft.status = 'completed'
    draft.revision += 1
    draft.updatedAt = new Date().toISOString()
    await store.save(draft)
    return steps
  } catch (error) {
    draft.status = 'failed'
    draft.error = error instanceof Error ? error.message : '提交失敗'
    draft.updatedAt = new Date().toISOString()
    await store.save(draft)
    throw error
  }
}

function extensionForMime(mimeType: string): string {
  return mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg'
}

function uploadPath(draftId: string, mimeType: string): string {
  return join(config.uploadsDir, `${draftId}.${extensionForMime(mimeType)}`)
}

function validImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mimeType === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (mimeType === 'image/webp') return Buffer.from(bytes.slice(0, 4)).toString() === 'RIFF' && Buffer.from(bytes.slice(8, 12)).toString() === 'WEBP'
  return false
}

async function removeUploadedImage(draft: Draft): Promise<void> {
  if (!draft.data.uploadedImage) return
  try { await unlink(uploadPath(draft.id, draft.data.uploadedImage.mimeType)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function cleanupUploadedFiles(): Promise<void> {
  try {
    const entries = await readdir(config.uploadsDir, { withFileTypes: true })
    const uploadName = /^[0-9a-f-]{36}\.(?:jpg|png|webp)$/i
    await Promise.all(entries
      .filter((entry) => entry.isFile() && uploadName.test(entry.name))
      .map((entry) => unlink(join(config.uploadsDir, entry.name))))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
      dashboardConfigured: Boolean(config.dashboardUrl && config.dashboardToken && config.dashboardUserId),
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
  if (request.method === 'GET' && url.pathname === '/api/drafts') {
    json(response, 200, store.list())
    return
  }
  const analysisProgressRoute = url.pathname.match(/^\/api\/analyses\/([0-9a-f-]+)\/progress$/)
  if (request.method === 'GET' && analysisProgressRoute) {
    const progress = analyses.get(analysisProgressRoute[1])
    json(response, progress ? 200 : 404, progress ?? { error: '找不到分析進度' })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/drafts/analyze') {
    const input = z.object({ url: z.string().url(), analysisId: z.string().uuid() }).parse(await readJson(request))
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
    setAnalysisStage(input.analysisId, 'building_drafts')
    const now = new Date().toISOString()
    const drafts: Draft[] = eventResults.map((result) => {
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
        status: 'review', data, evidence: {
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
        warnings: [...new Set(warnings)], revision: 1,
        createdAt: now, updatedAt: now,
      }
    })
    for (const previous of store.list()) await removeUploadedImage(previous)
    await store.replaceAll(drafts)
    const preparedDrafts: Draft[] = []
    for (const draft of drafts) preparedDrafts.push(await prepareDraft(draft))
    setAnalysisStage(input.analysisId, 'completed')
    json(response, 201, {
      drafts: preparedDrafts,
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
    })
    return
  }
  const draftRoute = url.pathname.match(/^\/api\/drafts\/([0-9a-f-]+)$/)
  if (draftRoute && request.method === 'GET') {
    const draft = store.get(draftRoute[1])
    json(response, draft ? 200 : 404, draft ?? { error: '找不到草稿' })
    return
  }
  if (draftRoute && request.method === 'PUT') {
    const draft = store.get(draftRoute[1])
    if (!draft) { json(response, 404, { error: '找不到草稿' }); return }
    if (draft.status === 'submitting' || draft.status === 'completed') throw new Error('提交中或已完成的草稿不可修改')
    const nextData: EventData = EventDataSchema.parse(await readJson(request))
    if (draft.data.place.selectedId !== nextData.place.selectedId || draft.data.place.createNew !== nextData.place.createNew) {
      delete draft.evidence['place.selection']
    }
    draft.data.actors.forEach((actor, index) => {
      const nextActor = nextData.actors[index]
      if (!nextActor || actor.selectedId !== nextActor.selectedId || actor.createNew !== nextActor.createNew || actor.name !== nextActor.name) {
        delete draft.evidence[`actors.${index}.selection`]
      }
    })
    const inferredCountry = inferCountry(`${nextData.place.name} ${nextData.place.address}`)
    if (inferredCountry) {
      nextData.place.countryCode = inferredCountry
      nextData.descriptionLanguage = languageForCountry(inferredCountry)
    }
    if (draft.submittedEventId) {
      const postCreateFields = (data: EventData) => {
        const core: Partial<EventData> = structuredClone(data)
        delete core.imageUrl
        delete core.uploadedImage
        return core
      }
      if (JSON.stringify(postCreateFields(draft.data)) !== JSON.stringify(postCreateFields(nextData))) {
        throw new Error('活動已在 Eventernote 建立，現在只能修改圖片')
      }
    }
    if (draft.data.imageUrl !== nextData.imageUrl) draft.imageAdded = false
    nextData.uploadedImage = draft.data.uploadedImage
    draft.data = nextData
    draft.warnings = requiredWarnings(draft.data, false)
    draft.status = 'review'
    draft.revision += 1
    draft.updatedAt = new Date().toISOString()
    await store.save(draft)
    json(response, 200, draft)
    return
  }
  if (draftRoute && request.method === 'DELETE') {
    const draft = store.get(draftRoute[1])
    if (!draft) { json(response, 204, undefined); return }
    if (draft.status === 'submitting') throw new Error('提交中的草稿不可刪除')
    await removeUploadedImage(draft)
    await store.remove(draft.id)
    json(response, 204, undefined)
    return
  }
  const imageRoute = url.pathname.match(/^\/api\/drafts\/([0-9a-f-]+)\/image$/)
  if (imageRoute && request.method === 'POST') {
    const draft = store.get(imageRoute[1])
    if (!draft) { json(response, 404, { error: '找不到目前活動' }); return }
    if (draft.status === 'submitting' || draft.status === 'completed') throw new Error('提交中或已完成的活動不可更換圖片')
    const mimeType = (request.headers['content-type'] ?? '').split(';')[0].toLowerCase()
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('圖片只支援 JPEG、PNG 或 WebP')
    const bytes = await readBytes(request, 5_000_000)
    if (!validImageSignature(bytes, mimeType)) throw new Error('圖片內容與檔案格式不符')
    if (draft.data.uploadedImage) await removeUploadedImage(draft)
    await mkdir(config.uploadsDir, { recursive: true })
    await writeFile(uploadPath(draft.id, mimeType), bytes)
    const encodedName = request.headers['x-file-name']?.toString() ?? `event.${extensionForMime(mimeType)}`
    let fileName: string
    try { fileName = decodeURIComponent(encodedName) } catch { fileName = `event.${extensionForMime(mimeType)}` }
    fileName = [...fileName].map((character) => {
      return character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character) ? '_' : character
    }).join('').slice(0, 255)
    draft.data.uploadedImage = { fileName, mimeType, size: bytes.byteLength }
    draft.imageAdded = false
    draft.revision += 1
    draft.status = 'review'
    draft.updatedAt = new Date().toISOString()
    await store.save(draft)
    json(response, 200, draft)
    return
  }
  if (imageRoute && request.method === 'DELETE') {
    const draft = store.get(imageRoute[1])
    if (!draft) { json(response, 404, { error: '找不到目前活動' }); return }
    if (draft.status === 'submitting' || draft.status === 'completed') throw new Error('提交中或已完成的活動不可更換圖片')
    await removeUploadedImage(draft)
    delete draft.data.uploadedImage
    draft.imageAdded = false
    draft.revision += 1
    draft.status = 'review'
    draft.updatedAt = new Date().toISOString()
    await store.save(draft)
    json(response, 200, draft)
    return
  }
  if (imageRoute && request.method === 'GET') {
    const draft = store.get(imageRoute[1])
    if (!draft?.data.uploadedImage) { json(response, 404, { error: '沒有已上傳圖片' }); return }
    response.writeHead(200, { 'Content-Type': draft.data.uploadedImage.mimeType, 'Content-Length': draft.data.uploadedImage.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    createReadStream(uploadPath(draft.id, draft.data.uploadedImage.mimeType)).pipe(response)
    return
  }
  const actionRoute = url.pathname.match(/^\/api\/drafts\/([0-9a-f-]+)\/(prepare|confirm|execute)$/)
  if (actionRoute && request.method === 'POST') {
    const draft = store.get(actionRoute[1])
    if (!draft) { json(response, 404, { error: '找不到草稿' }); return }
    if (actionRoute[2] === 'prepare') {
      json(response, 200, await prepareDraft(draft))
      return
    }
    if (actionRoute[2] === 'confirm') {
      if (draft.status !== 'ready') throw new Error('請先完成必填資料及執行實體比對')
      const token = randomBytes(24).toString('base64url')
      confirmations.set(token, { draftId: draft.id, revision: draft.revision, hash: dataHash(draft.data), expiresAt: Date.now() + 10 * 60_000 })
      json(response, 200, { confirmationToken: token, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() })
      return
    }
    const body = z.object({ confirmationToken: z.string().min(10) }).parse(await readJson(request))
    const confirmation = confirmations.get(body.confirmationToken)
    confirmations.delete(body.confirmationToken)
    if (!confirmation || confirmation.expiresAt < Date.now()) throw new Error('確認碼已失效，請重新確認')
    if (confirmation.draftId !== draft.id || confirmation.revision !== draft.revision || confirmation.hash !== dataHash(draft.data)) {
      throw new Error('草稿在確認後已有變更，請重新確認')
    }
    const steps = await executeDraft(draft)
    json(response, 200, { draft, steps })
    return
  }
  if (url.pathname.startsWith('/api/')) {
    json(response, 404, { error: 'Not found' })
    return
  }
  if (!(await serveStatic(url.pathname, response))) json(response, 404, { error: 'Web build not found; run npm run dev or npm run build' })
}

await cleanupUploadedFiles()
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
