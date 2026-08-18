import * as cheerio from 'cheerio'
import makeFetchCookie from 'fetch-cookie'
import { CookieJar } from 'tough-cookie'
import type { AnyNode } from 'domhandler'
import type { ActorData, EntityCandidate, EventData, ExistingEventReference, PlaceData } from '../shared/types.js'

interface SubmittedEntity { id: string; url: string }

interface SubmittedAttendance {
  created: boolean
  noteId: string
  url: string
}

export interface ExistingEventMatch extends ExistingEventReference {
  actorIds: string[]
  actors: Array<{ id: string; name: string }>
  complete: boolean
  hasImage: boolean
  missingFields: string[]
  place?: { id: string; name: string }
  titleSimilarity: number
}

interface PostCreateForm {
  $: cheerio.CheerioAPI
  form: cheerio.Cheerio<AnyNode>
  pageUrl: string
}

interface ExistingEventForm extends PostCreateForm {
  detailHtml: string
}

type SubmissionStage = 'login' | 'open_form' | 'initial_post' | 'initial_response' | 'confirmation_post' | 'confirmation_response'

interface SubmissionLogContext {
  entity: 'actors' | 'places' | 'events'
  stage: SubmissionStage
  response?: Response
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s・･\-_.,，。()（）「」『』]/g, '')
}

function eventSearchQueries(title: string): string[] {
  const sessionPrefix = title.replace(/\s+(?:day|part|vol(?:ume)?)\s*[._-]?\s*\d+.*$/i, '').trim()
  return [...new Set([title.trim(), sessionPrefix].filter(Boolean))]
}

const SIMILAR_EVENT_TITLE_THRESHOLD = 0.6

function similarity(left: string, right: string): number {
  const a = normalize(left)
  const b = normalize(right)
  if (a === b) return 1
  if (a.startsWith(b) || b.startsWith(a)) return 0.92
  if (a.includes(b) || b.includes(a)) return 0.86
  const grams = (value: string) => new Set([...value].map((char, index) => char + (value[index + 1] ?? '')))
  const ag = grams(a)
  const bg = grams(b)
  const intersection = [...ag].filter((gram) => bg.has(gram)).length
  return ag.size + bg.size ? (2 * intersection) / (ag.size + bg.size) : 0
}

function apiResultSimilarity(query: string, aliases: Array<string | undefined>): number {
  const aliasScore = Math.max(0, ...aliases.flatMap((alias) => {
    if (!alias) return []
    return alias.split(/[,，]/).map((value) => similarity(query, value.trim()))
  }))
  // Eventernote's dedicated APIs also match aliases that are not exposed in their response.
  // Keep those results visible, but below the threshold used for automatic selection.
  return Math.max(0.25, aliasScore)
}

function idFromPath(path: string): string {
  return path.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? ''
}

function entityFromCompletePage(
  html: string,
  origin: string,
  entityPath: 'actors' | 'places' | 'events',
  expectedName = '',
): SubmittedEntity | undefined {
  const $ = cheerio.load(html)
  const metadataCandidates = new Map<string, string>()
  const namedCandidates = new Map<string, string>()
  const allCandidates = new Map<string, string>()
  const addCandidate = (candidates: Map<string, string>, value?: string): void => {
    if (!value) return
    try {
      const url = new URL(value, origin)
      if (url.origin !== new URL(origin).origin) return
      const match = url.pathname.match(new RegExp(`^/${entityPath}/(?:[^/]+/)?(\\d+)/?$`))
      if (match) candidates.set(match[1], new URL(`/${entityPath}/${match[1]}`, origin).toString())
    } catch {
      // Ignore malformed upstream links and keep looking for one unambiguous entity URL.
    }
  }
  $('link[rel~="canonical"][href]').each((_, node) => addCandidate(metadataCandidates, $(node).attr('href')))
  $('meta[property="og:url"][content], meta[name="twitter:url"][content]')
    .each((_, node) => addCandidate(metadataCandidates, $(node).attr('content')))
  if (metadataCandidates.size === 1) {
    const [id, url] = [...metadataCandidates.entries()][0]
    return { id, url }
  }

  $('a[href]').each((_, node) => {
    const href = $(node).attr('href')
    addCandidate(allCandidates, href)
    if (expectedName && normalize($(node).text()) === normalize(expectedName)) addCandidate(namedCandidates, href)
  })
  const candidates = namedCandidates.size ? namedCandidates : allCandidates
  if (candidates.size !== 1) return undefined
  const [id, url] = [...candidates.entries()][0]
  return { id, url }
}

function integerFormValue(value: string): string {
  return /^\d+$/.test(value) ? String(Number.parseInt(value, 10)) : value
}

function timeFormValue(hour: string, minute: string): string {
  if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute)) return ''
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const direct = 'code' in error ? error.code : undefined
  const cause = 'cause' in error && error.cause && typeof error.cause === 'object' && 'code' in error.cause
    ? error.cause.code
    : undefined
  const code = typeof direct === 'string' ? direct : typeof cause === 'string' ? cause : undefined
  return code?.slice(0, 80)
}

function safePathname(response?: Response): string | undefined {
  if (!response?.url) return undefined
  try {
    return new URL(response.url).pathname
  } catch {
    return undefined
  }
}

function logSubmissionFailure(context: SubmissionLogContext, error: unknown): void {
  console.error(JSON.stringify({
    event: 'eventernote_submission_failed',
    entity: context.entity,
    stage: context.stage,
    ...(context.response ? { httpStatus: context.response.status } : {}),
    ...(safePathname(context.response) ? { pathname: safePathname(context.response) } : {}),
    errorType: error instanceof Error ? error.name : 'UnknownError',
    ...(errorCode(error) ? { errorCode: errorCode(error) } : {}),
  }))
}

async function fetchEventernoteRead(input: string | URL, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(input, { ...init, signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 1) throw error
    }
  }
  throw new Error('Eventernote read failed')
}

export function duplicateSubmissionMessage(
  html: string,
  origin: string,
  fallbackError: string,
): string | undefined {
  const $ = cheerio.load(html)
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
  const duplicateSignal = `${fallbackError} ${bodyText}`
  if (!/(?:既に.{0,20}登録|登録済|重複|duplicate|already\s+(?:exists|registered))/i.test(duplicateSignal)) return undefined
  const urls = [...new Set($('a[href^="/events/"]').toArray()
    .map((link) => $(link).attr('href') ?? '')
    .filter((href) => /\/events\/\d+/.test(href))
    .map((href) => new URL(href, origin).toString()))]
  const links = urls.length ? ` 可能的既有活動：${urls.slice(0, 3).join(' ')}` : ''
  return `Eventernote 判定活動可能已經存在，因此未完成新增。${links} 請開啟既有活動核對；如確定不是同一活動，修正名稱、日期或場所後重新確認。`
}

export class EventernoteClient {
  private readonly fetchWithCookies: typeof fetch
  private loggedIn = false

  constructor(
    private readonly origin: string,
    private readonly username?: string,
    private readonly password?: string,
  ) {
    this.fetchWithCookies = makeFetchCookie(fetch, new CookieJar())
  }

  async searchEntities(query: string, kind: 'actor' | 'place'): Promise<EntityCandidate[]> {
    if (!query.trim()) return []
    const prefix = kind === 'actor' ? '/actors/' : '/places/'
    const searchPage = async (pathname: string): Promise<EntityCandidate[]> => {
      const url = new URL(pathname, this.origin)
      url.searchParams.set('keyword', query)
      url.searchParams.set('__from', 'autofill')
      const response = await fetchEventernoteRead(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 EventernoteAutofill/0.1', 'Accept-Language': 'ja' },
      })
      if (!response.ok) throw new Error(`Eventernote 搜尋失敗 (HTTP ${response.status})`)
      const $ = cheerio.load(await response.text())
      const candidates = new Map<string, EntityCandidate>()
      $(`a[href^="${prefix}"]`).each((_, element) => {
        const href = $(element).attr('href') ?? ''
        const id = idFromPath(href)
        const name = $(element).text().replace(/\s+/g, ' ').trim()
        if (!id || !name) return
        const score = similarity(query, name)
        if (score < 0.25) return
        candidates.set(id, { id, name, url: new URL(href, this.origin).toString(), similarity: score })
      })
      return [...candidates.values()]
    }

    const searchApi = async (): Promise<EntityCandidate[]> => {
      const url = new URL(kind === 'actor' ? '/api/actors/search' : '/api/places/search', this.origin)
      url.searchParams.set('keyword', query)
      // Eventernote defaults to ten actor results, which can omit an exact name
      // behind many partial matches (for example, `SEE`). Keep one request but
      // widen its result set so existing actors are not offered as new entities.
      if (kind === 'actor') url.searchParams.set('limit', '100')
      const response = await fetchEventernoteRead(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 EventernoteAutofill/0.1',
          'Accept-Language': 'ja',
          Accept: 'application/json',
        },
      })
      if (!response.ok) throw new Error(`Eventernote 搜尋失敗 (HTTP ${response.status})`)
      const payload = await response.json() as {
        results?: Array<{
          id?: string | number
          name?: string
          place_name?: string
          kana?: string
          keyword?: string
          address?: string
        }>
      }
      return (payload.results ?? []).flatMap((item) => {
        const id = String(item.id ?? '')
        const name = String(kind === 'actor' ? item.name ?? '' : item.place_name ?? '').trim()
        const score = apiResultSimilarity(query, [name, item.kana, item.keyword, item.address])
        if (!id || !name) return []
        return [{ id, name, url: new URL(`${prefix}${encodeURIComponent(name)}/${id}`, this.origin).toString(), similarity: score }]
      })
    }

    const direct = await searchApi()
    if (direct.some((candidate) => candidate.similarity === 1)) {
      return direct.sort((a, b) => b.similarity - a.similarity).slice(0, 5)
    }
    const fallback = await searchPage('/events/search').catch(() => [])
    const candidates = new Map(direct.map((candidate) => [candidate.id, candidate]))
    for (const candidate of fallback) {
      const contextualCandidate = {
        ...candidate,
        similarity: Math.min(1, Number((candidate.similarity + 0.03).toFixed(2))),
      }
      const previous = candidates.get(candidate.id)
      if (!previous || contextualCandidate.similarity > previous.similarity) candidates.set(candidate.id, contextualCandidate)
    }
    return [...candidates.values()].sort((a, b) => b.similarity - a.similarity).slice(0, 5)
  }

  async searchActorsFromEvent(eventQuery: string, actorNames: string[]): Promise<EntityCandidate[][]> {
    if (!eventQuery.trim()) return actorNames.map(() => [])
    const url = new URL('/events/search', this.origin)
    url.searchParams.set('keyword', eventQuery)
    url.searchParams.set('__from', 'autofill-event-cast')
    const response = await fetchEventernoteRead(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 EventernoteAutofill/0.1', 'Accept-Language': 'ja' },
    })
    if (!response.ok) throw new Error(`Eventernote 活動出演者搜尋失敗 (HTTP ${response.status})`)
    const $ = cheerio.load(await response.text())
    const actors = new Map<string, Omit<EntityCandidate, 'similarity'>>()
    $('a[href^="/actors/"]').each((_, element) => {
      const href = $(element).attr('href') ?? ''
      const id = idFromPath(href)
      const name = $(element).text().replace(/\s+/g, ' ').trim()
      if (!id || !name) return
      actors.set(id, { id, name, url: new URL(href, this.origin).toString() })
    })
    return actorNames.map((actorName) => [...actors.values()].flatMap((actor) => {
      const score = similarity(actorName, actor.name)
      if (score < 0.25) return []
      return [{
        ...actor,
        similarity: Math.min(1, Number((score + 0.03).toFixed(2))),
      }]
    }).sort((left, right) => right.similarity - left.similarity).slice(0, 5))
  }

  private async login(): Promise<void> {
    if (this.loggedIn) return
    if (!this.username || !this.password) throw new Error('伺服器未設定 Eventernote 登入資料')
    const page = await this.fetchWithCookies(new URL('/login', this.origin), { signal: AbortSignal.timeout(15_000) })
    const $ = cheerio.load(await page.text())
    const form = $('form').filter((_, item) => ($(item).attr('action') ?? '').includes('/login/email')).first()
    if (!form.length) throw new Error('無法辨識 Eventernote 登入表單')
    const body = this.collectDefaults($, form)
    body.set('email', this.username)
    body.set('password', this.password)
    const action = new URL(form.attr('action') ?? '/login/email/', this.origin)
    const response = await this.fetchWithCookies(action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': page.url },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    const html = await response.text()
    if (response.url.includes('/login') || html.includes('アカウント名orメールアドレス')) {
      throw new Error('Eventernote 登入失敗，請檢查帳戶或密碼')
    }
    this.loggedIn = true
  }

  private collectDefaults($: cheerio.CheerioAPI, form: cheerio.Cheerio<AnyNode>): URLSearchParams {
    const body = new URLSearchParams()
    form.find('input, select, textarea').each((_, item) => {
      const field = $(item)
      const name = field.attr('name')
      if (!name || field.attr('disabled') !== undefined) return
      const type = field.attr('type')
      if (type === 'file') return
      if ((type === 'checkbox' || type === 'radio') && field.attr('checked') === undefined) return
      body.append(name, field.val()?.toString() ?? '')
    })
    return body
  }

  private assignByContext(
    $: cheerio.CheerioAPI,
    form: cheerio.Cheerio<AnyNode>,
    body: URLSearchParams,
    patterns: RegExp[],
    value: string,
  ): boolean {
    if (!value) return false
    let assigned = false
    form.find('input:not([type=hidden]):not([type=submit]), textarea, select').each((_, item) => {
      if (assigned) return
      const field = $(item)
      const name = field.attr('name') ?? ''
      const context = `${field.closest('tr, .field, .form-group, li').text()} ${name}`.replace(/\s+/g, ' ')
      if (patterns.some((pattern) => pattern.test(context))) {
        body.set(name, value)
        assigned = true
      }
    })
    return assigned
  }

  private assignNamed(body: URLSearchParams, pattern: RegExp, value: string): boolean {
    if (!value) return false
    const key = [...body.keys()].find((name) => pattern.test(name))
    if (!key) return false
    body.set(key, value)
    return true
  }

  private assignExact(body: URLSearchParams, name: string, value: string): boolean {
    if (!body.has(name)) return false
    body.set(name, value)
    return true
  }

  private assignTimeParts(body: URLSearchParams, prefix: 'open_time' | 'start_time' | 'end_time', value: string): void {
    if (!value) return
    const [hour, minute] = value.split(':')
    if (body.has(`${prefix}[hour]`)) body.set(`${prefix}[hour]`, hour)
    if (body.has(`${prefix}[minute]`)) body.set(`${prefix}[minute]`, minute)
  }

  private assignTimePartsIfMissing(
    body: URLSearchParams,
    prefix: 'open_time' | 'start_time' | 'end_time',
    value: string,
  ): void {
    if (!value) return
    const flat = body.get(prefix)?.trim() ?? ''
    const hourKey = `${prefix}[hour]`
    const minuteKey = `${prefix}[minute]`
    const hour = body.get(hourKey)?.trim() ?? ''
    const minute = body.get(minuteKey)?.trim() ?? ''
    if (flat || hour || minute) return
    const [nextHour, nextMinute] = value.split(':')
    if (body.has(prefix)) body.set(prefix, value)
    if (body.has(hourKey)) body.set(hourKey, nextHour)
    if (body.has(minuteKey)) body.set(minuteKey, nextMinute)
  }

  private eventFormValue(body: URLSearchParams, exact: string, fallback: RegExp): string {
    const exactValue = body.get(exact)
    if (exactValue !== null) return exactValue.trim()
    const key = [...body.keys()].find((name) => fallback.test(name))
    return key ? (body.get(key) ?? '').trim() : ''
  }

  private eventFormTime(body: URLSearchParams, prefix: 'open_time' | 'start_time' | 'end_time'): string {
    const flat = body.get(prefix)?.trim() ?? ''
    if (/^\d{1,2}:\d{2}$/.test(flat)) {
      const [hour, minute] = flat.split(':')
      return `${hour.padStart(2, '0')}:${minute}`
    }
    return timeFormValue(body.get(`${prefix}[hour]`) ?? '', body.get(`${prefix}[minute]`) ?? '')
  }

  private normalizeConfirmationTimes(confirmationBody: URLSearchParams, initialBody: URLSearchParams): void {
    for (const prefix of ['open_time', 'start_time', 'end_time'] as const) {
      if (!confirmationBody.has(prefix)) continue
      const hour = initialBody.get(`${prefix}[hour]`) ?? ''
      const minute = initialBody.get(`${prefix}[minute]`) ?? ''
      confirmationBody.set(prefix, hour || minute ? timeFormValue(hour, minute) : '')
    }
  }

  private preserveConfirmationEntityFields(confirmationBody: URLSearchParams, initialBody: URLSearchParams): void {
    for (const name of ['actor_ids', 'prefecture', 'place_id']) {
      const value = initialBody.get(name)
      if (value !== null) confirmationBody.set(name, value)
    }
  }

  private async placePrefecture(placeId: string, placeName: string): Promise<string> {
    const compactNumberedName = placeName.replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=\d)/gu,
      '$1',
    )
    const queries = [...new Set([placeName.trim(), compactNumberedName.trim()])].filter(Boolean)
    for (const query of queries) {
      const url = new URL('/api/places/search', this.origin)
      url.searchParams.set('keyword', query)
      const response = await fetchEventernoteRead(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 EventernoteAutofill/0.1',
          'Accept-Language': 'ja',
          Accept: 'application/json',
        },
      })
      if (!response.ok) throw new Error(`Eventernote 場所資料讀取失敗 (HTTP ${response.status})`)
      const payload = await response.json() as {
        results?: Array<{ id?: string | number; prefecture?: string | number }>
      }
      const prefecture = String(payload.results?.find((item) => String(item.id ?? '') === placeId)?.prefecture ?? '')
      if (/^\d+$/.test(prefecture)) return prefecture
    }
    throw new Error(`無法確認 Eventernote 場所「${placeName}」的都道府縣，活動尚未建立`)
  }

  private submissionForm(
    $: cheerio.CheerioAPI,
    pageUrl: string,
    entityPath: 'actors' | 'places' | 'events',
  ): cheerio.Cheerio<AnyNode> {
    const forms = $('form').filter((_, item) => {
      const form = $(item)
      const action = form.attr('action') ?? ''
      const submitsToEntityPath = action
        ? action.includes(`/${entityPath}`)
        : new URL(pageUrl).pathname.includes(`/${entityPath}/add`)
      return submitsToEntityPath && !action.includes('/search') && !action.includes('/login')
    }).toArray()
    forms.sort((left, right) => {
      const namedFields = (item: AnyNode) => $(item).find('input[name], select[name], textarea[name]').length
      return namedFields(right) - namedFields(left)
    })
    return $(forms[0])
  }

  private formAction(form: cheerio.Cheerio<AnyNode>, pageUrl: string): URL {
    const action = new URL(form.attr('action') || pageUrl, pageUrl)
    if (action.origin !== new URL(this.origin).origin) {
      throw new Error('Eventernote 表單提交目的地不安全')
    }
    return action
  }

  private async postForm(
    form: cheerio.Cheerio<AnyNode>,
    pageUrl: string,
    body: URLSearchParams,
  ): Promise<Response> {
    const multipart = (form.attr('enctype') ?? '').toLowerCase() === 'multipart/form-data'
    const requestBody = multipart ? new FormData() : body
    if (requestBody instanceof FormData) {
      for (const [name, value] of body) requestBody.append(name, value)
    }
    return this.fetchWithCookies(this.formAction(form, pageUrl), {
      method: (form.attr('method') ?? 'post').toUpperCase(),
      headers: multipart
        ? { 'Referer': pageUrl }
        : { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': pageUrl },
      body: requestBody,
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    })
  }

  private submissionError(
    html: string,
    entityPath: 'actors' | 'places' | 'events',
  ): Error {
    const result = cheerio.load(html)
    let errors = result('.error, .errors, .alert-danger, .field_with_errors, #error_explanation')
      .text().replace(/\s+/g, ' ').trim()
    const bodyText = result('body').text().replace(/\s+/g, ' ').trim()
    if (!errors && /同じ名前の声優\/アーティストが登録されています/.test(bodyText)) {
      errors = '同じ名前の声優/アーティストが登録されています'
    }
    const duplicateMessage = entityPath === 'events'
      ? duplicateSubmissionMessage(html, this.origin, errors)
      : undefined
    if (duplicateMessage) return new Error(duplicateMessage)
    return new Error(errors ? `Eventernote 拒絕提交：${errors.slice(0, 300)}` : `Eventernote ${entityPath} 提交未成功`)
  }

  private async findExistingEventForm(eventId: string): Promise<ExistingEventForm> {
    await this.login()
    const detailUrl = new URL(`/events/${eventId}`, this.origin)
    const detailResponse = await this.fetchWithCookies(detailUrl, { signal: AbortSignal.timeout(15_000) })
    const detailHtml = await detailResponse.text()
    if (!detailResponse.ok) throw new Error(`Eventernote 既有活動讀取失敗 (HTTP ${detailResponse.status})`)
    const detail = cheerio.load(detailHtml)
    const editLinks = detail('a[href]').toArray().filter((link) => {
      const value = `${detail(link).text()} ${detail(link).attr('href') ?? ''}`
      return /このイベントを編集|イベント.*編集|\/events\/\d+\/edit|edit/i.test(value)
    })
    const urls = [
      ...editLinks.map((link) => new URL(detail(link).attr('href') ?? '', detailResponse.url).toString()),
      new URL(`/events/${eventId}/edit`, this.origin).toString(),
      detailResponse.url,
    ]
    for (const pageUrl of [...new Set(urls)]) {
      const pageResponse = pageUrl === detailResponse.url
        ? detailResponse
        : await this.fetchWithCookies(pageUrl, { signal: AbortSignal.timeout(15_000) })
      if (!pageResponse.ok) continue
      const html = pageUrl === detailResponse.url ? detailHtml : await pageResponse.text()
      const $ = cheerio.load(html)
      const form = this.submissionForm($, pageUrl, 'events')
      if (form.length && form.find('input[name="event_name"], input[name*="event_name"]').length) {
        return { $, form, pageUrl, detailHtml }
      }
    }
    throw new Error('無法辨識 Eventernote 既有活動編輯表單')
  }

  private existingEventValues(existing: ExistingEventForm): {
    actorIds: string[]
    actors: Array<{ id: string; name: string }>
    date: string
    description: string
    endTime: string
    hasImage: boolean
    officialUrl: string
    openTime: string
    place?: { id: string; name: string }
    startTime: string
    title: string
  } {
    const body = this.collectDefaults(existing.$, existing.form)
    const detail = cheerio.load(existing.detailHtml)
    const actorMap = new Map<string, string>()
    detail('a[href^="/actors/"]').each((_, link) => {
      const id = idFromPath(detail(link).attr('href') ?? '')
      const name = detail(link).text().replace(/\s+/g, ' ').trim()
      if (id && name) actorMap.set(id, name)
    })
    const actorIds = [...new Set(body.getAll('actor_ids').flatMap((value) => value.split(',')).map((id) => id.trim()).filter(Boolean))]
    const placeId = this.eventFormValue(body, 'place_id', /place.*id|place_id/)
    const placeLink = detail('a[href^="/places/"]').toArray().find((link) => idFromPath(detail(link).attr('href') ?? '') === placeId)
      ?? detail('a[href^="/places/"]').first().get(0)
    const linkPlaceId = placeLink ? idFromPath(detail(placeLink).attr('href') ?? '') : ''
    const placeName = placeLink ? detail(placeLink).text().replace(/\s+/g, ' ').trim() : ''
    const year = body.get('date[year]')?.trim() ?? ''
    const month = body.get('date[month]')?.trim() ?? ''
    const day = body.get('date[day]')?.trim() ?? ''
    const flatDate = body.get('date')?.trim() ?? ''
    const date = year && month && day
      ? `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
      : /^\d{4}-\d{2}-\d{2}$/.test(flatDate) ? flatDate : ''
    const hasImage = detail('.event-image img, .event_image img, #event_image img, img[src*="event_images"], img[src*="images/events/"], img[src*="events/images"]')
      .toArray().some((image) => !/no[_-]?image|placeholder/i.test(detail(image).attr('src') ?? ''))
    return {
      actorIds,
      actors: [...actorMap].map(([id, name]) => ({ id, name })),
      date,
      description: this.eventFormValue(body, 'description', /description|note/),
      endTime: this.eventFormTime(body, 'end_time'),
      hasImage,
      officialUrl: this.eventFormValue(body, 'link', /official.*url|source.*url|url/),
      openTime: this.eventFormTime(body, 'open_time'),
      place: placeId || linkPlaceId ? { id: placeId || linkPlaceId, name: placeName } : undefined,
      startTime: this.eventFormTime(body, 'start_time'),
      title: this.eventFormValue(body, 'event_name', /event_name|title/),
    }
  }

  async matchExistingEvent(eventId: string, data: EventData): Promise<ExistingEventMatch | undefined> {
    const existingForm = await this.findExistingEventForm(eventId)
    const current = this.existingEventValues(existingForm)
    const titleSimilarity = similarity(current.title, data.title)
    const exactTitle = titleSimilarity === 1
    const sameDateAndTime = Boolean(
      current.date && data.date && current.date === data.date
      && current.startTime && data.startTime && current.startTime === data.startTime,
    )
    const samePlace = Boolean(
      current.place
      && (
        (data.place.selectedId && current.place.id === data.place.selectedId)
        || (!data.place.selectedId && normalize(current.place.name) === normalize(data.place.name))
      ),
    )
    if (!exactTitle && !(
      titleSimilarity >= SIMILAR_EVENT_TITLE_THRESHOLD
      && sameDateAndTime
      && samePlace
    )) return undefined
    if (current.date && data.date && current.date !== data.date) return undefined
    if (current.startTime && data.startTime && current.startTime !== data.startTime) return undefined
    const missingFields: string[] = []
    const missing = (label: string, incoming: string, present: string) => {
      if (incoming.trim() && !present.trim()) missingFields.push(label)
    }
    missing('活動日期', data.date, current.date)
    missing('開場時間', data.openTime, current.openTime)
    missing('開演時間', data.startTime, current.startTime)
    missing('結束時間', data.endTime, current.endTime)
    missing('活動說明', data.description, current.description)
    missing('官方連結', data.officialUrl, current.officialUrl)
    if ((data.place.selectedId || data.place.name) && !current.place?.id && !current.place?.name) missingFields.push('場所')
    const currentActorIds = new Set(current.actorIds)
    const currentActorNames = new Set(current.actors.map((actor) => normalize(actor.name)))
    for (const actor of data.actors) {
      if ((actor.selectedId && currentActorIds.has(actor.selectedId)) || currentActorNames.has(normalize(actor.name))) continue
      missingFields.push(`出演者：${actor.name}`)
    }
    if ((data.uploadedImage || data.imageUrl) && !current.hasImage) missingFields.push('活動圖片')
    return {
      id: eventId,
      url: new URL(`/events/${eventId}`, this.origin).toString(),
      actorIds: current.actorIds,
      actors: current.actors,
      complete: missingFields.length === 0,
      hasImage: current.hasImage,
      missingFields,
      place: current.place,
      titleSimilarity,
    }
  }

  async findMatchingEvent(data: EventData): Promise<ExistingEventMatch | undefined> {
    if (!data.title.trim()) return undefined
    const [year, month, day] = data.date.split('-')
    const candidates = new Set<string>()
    const queries = [...new Set([...eventSearchQueries(data.title), data.place.name.trim()].filter(Boolean))]
    const searchResults = await Promise.allSettled(queries.map(async (query) => {
      const url = new URL('/events/search', this.origin)
      url.searchParams.set('keyword', query)
      url.searchParams.set('__from', 'autofill-duplicate-check')
      if (year && month && day) {
        url.searchParams.set('year', integerFormValue(year))
        url.searchParams.set('month', integerFormValue(month))
        url.searchParams.set('day', integerFormValue(day))
      }
      const response = await fetchEventernoteRead(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 EventernoteAutofill/0.1', 'Accept-Language': 'ja' },
      })
      if (!response.ok) throw new Error(`Eventernote 活動搜尋失敗 (HTTP ${response.status})`)
      const $ = cheerio.load(await response.text())
      const ids = new Set<string>()
      $('a[href^="/events/"]').each((_, link) => {
        const href = $(link).attr('href') ?? ''
        const id = href.match(/^\/events\/(\d+)(?:[/?#]|$)/)?.[1] ?? ''
        if (id) ids.add(id)
      })
      return ids
    }))
    for (const result of searchResults) {
      if (result.status === 'fulfilled') for (const id of result.value) candidates.add(id)
    }
    if (searchResults.every((result) => result.status === 'rejected')) {
      const failure = searchResults[0]
      throw failure.status === 'rejected' ? failure.reason : new Error('Eventernote 活動搜尋失敗')
    }
    const matches: Array<{ match: ExistingEventMatch; score: number }> = []
    for (const id of [...candidates].sort((left, right) => Number(left) - Number(right))) {
      const match = await this.matchExistingEvent(id, data)
      if (match) matches.push({ match, score: match.titleSimilarity })
    }
    const exactMatches = matches.filter(({ score }) => score === 1)
      .sort(({ match: left }, { match: right }) => Number(left.id) - Number(right.id))
    if (exactMatches.length) return exactMatches[0].match
    const [best, runnerUp] = matches.sort((left, right) => right.score - left.score)
    if (!best || (runnerUp && best.score - runnerUp.score < 0.08)) return undefined
    return best.match
  }

  async completeExistingEvent(
    eventId: string,
    data: EventData,
    placeId: string,
    actorIds: string[],
  ): Promise<SubmittedEntity> {
    let stage: SubmissionStage = 'open_form'
    let lastResponse: Response | undefined
    try {
      const existing = await this.findExistingEventForm(eventId)
      const body = this.collectDefaults(existing.$, existing.form)
      const setIfMissing = (exact: string, fallback: RegExp, value: string): void => {
        if (!value || this.eventFormValue(body, exact, fallback)) return
        if (!this.assignExact(body, exact, value)) this.assignNamed(body, fallback, value)
      }
      setIfMissing('event_name', /event_name|title/, data.title)
      const existingPlaceId = this.eventFormValue(body, 'place_id', /place.*id|place_id/)
      if (!existingPlaceId && placeId && body.has('prefecture')) {
        body.set('prefecture', await this.placePrefecture(placeId, data.place.name))
      }
      setIfMissing('place_id', /place.*id|place_id/, placeId)
      setIfMissing('link', /official.*url|source.*url|url/, data.officialUrl)
      setIfMissing('description', /description|note/, data.description)
      const [year, month, day] = data.date.split('-')
      if (!(body.get('date[year]') ?? '').trim()) this.assignExact(body, 'date[year]', integerFormValue(year))
      if (!(body.get('date[month]') ?? '').trim()) this.assignExact(body, 'date[month]', integerFormValue(month))
      if (!(body.get('date[day]') ?? '').trim()) this.assignExact(body, 'date[day]', integerFormValue(day))
      this.assignTimePartsIfMissing(body, 'open_time', data.openTime)
      this.assignTimePartsIfMissing(body, 'start_time', data.startTime)
      this.assignTimePartsIfMissing(body, 'end_time', data.endTime)
      const actorKey = body.has('actor_ids')
        ? 'actor_ids'
        : [...body.keys()].find((name) => /actor.*id|performer.*id/.test(name))
      if (actorKey) {
        const existingActorIds = body.getAll(actorKey).flatMap((value) => value.split(',')).map((id) => id.trim()).filter(Boolean)
        body.set(actorKey, [...new Set([...existingActorIds, ...actorIds.filter(Boolean)])].join(','))
      }
      stage = 'initial_post'
      let response = await this.postForm(existing.form, existing.pageUrl, body)
      lastResponse = response
      stage = 'initial_response'
      let html = await response.text()
      let responsePath = new URL(response.url).pathname
      const isEventDetailPath = (pathname: string): boolean => new RegExp(`^/events/${eventId}/?$`).test(pathname)
      if (response.ok && isEventDetailPath(responsePath)) {
        return { id: eventId, url: new URL(`/events/${eventId}`, this.origin).toString() }
      }
      if (response.ok && /\/confirm\/?$/.test(responsePath)) {
        const confirmationPage = cheerio.load(html)
        const confirmationForm = this.submissionForm(confirmationPage, response.url, 'events')
        if (!confirmationForm.length) throw new Error('無法辨識 Eventernote 活動修改確認表單')
        const confirmationBody = this.collectDefaults(confirmationPage, confirmationForm)
        this.normalizeConfirmationTimes(confirmationBody, body)
        this.preserveConfirmationEntityFields(confirmationBody, body)
        stage = 'confirmation_post'
        response = await this.postForm(confirmationForm, response.url, confirmationBody)
        lastResponse = response
        stage = 'confirmation_response'
        html = await response.text()
        responsePath = new URL(response.url).pathname
      }
      if (response.ok && (isEventDetailPath(responsePath) || /\/complete\/?$/.test(responsePath))) {
        return { id: eventId, url: new URL(`/events/${eventId}`, this.origin).toString() }
      }
      throw this.submissionError(html, 'events')
    } catch (error) {
      logSubmissionFailure({ entity: 'events', stage, response: lastResponse }, error)
      throw error
    }
  }

  private async findImageForm(eventId: string): Promise<PostCreateForm & { placeId: string }> {
    await this.login()
    const detailUrl = new URL(`/events/${eventId}`, this.origin)
    const detailResponse = await this.fetchWithCookies(detailUrl, { signal: AbortSignal.timeout(15_000) })
    const detailHtml = await detailResponse.text()
    const detail = cheerio.load(detailHtml)
    const placeLink = detail('.gb_events_info_table a[href^="/places/"]').toArray()
      .find((link) => idFromPath(detail(link).attr('href') ?? ''))
      ?? detail('a[href^="/places/"]').toArray().find((link) => idFromPath(detail(link).attr('href') ?? ''))
    const placeId = placeLink ? idFromPath(detail(placeLink).attr('href') ?? '') : ''
    const specificText = /画像|写真|イメージ|image|photo/i
    const editText = /このイベントを編集|イベント.*編集|edit/i
    const links = detail('a[href]').toArray()
    const candidates = [...links.filter((link) => specificText.test(`${detail(link).text()} ${detail(link).attr('href') ?? ''}`)),
      ...links.filter((link) => editText.test(`${detail(link).text()} ${detail(link).attr('href') ?? ''}`))]
    const urls = [detailResponse.url, ...candidates.map((link) => new URL(detail(link).attr('href') ?? '', detailResponse.url).toString())]
    for (const pageUrl of [...new Set(urls)]) {
      const html = pageUrl === detailResponse.url
        ? detailHtml
        : await this.fetchWithCookies(pageUrl, { signal: AbortSignal.timeout(15_000) }).then((response) => response.text())
      const $ = cheerio.load(html)
      const forms = $('form').toArray()
      for (const formNode of forms) {
        const form = $(formNode)
        if (form.find('input[type="file"]').length) return { $, form, pageUrl, placeId }
      }
    }
    throw new Error('Eventernote 活動已建立，但找不到圖片新增表單；請在活動頁手動補上')
  }

  async addEventImage(eventId: string, bytes: Uint8Array, mimeType: string, fileName: string): Promise<string> {
    const { $, form, pageUrl, placeId } = await this.findImageForm(eventId)
    const fileField = form.find('input[type="file"][name]').first()
    const fileFieldName = fileField.attr('name')
    if (!fileFieldName) throw new Error('Eventernote 活動已建立，但無法辨識圖片上傳欄位')
    const body = new FormData()
    form.find('input[type="hidden"], input[type="text"], textarea, select').each((_, item) => {
      const field = $(item)
      const name = field.attr('name')
      if (name) body.append(name, field.val()?.toString() ?? '')
    })
    // Eventernote fills the venue select with JavaScript after the edit page loads,
    // so the server-rendered form contains an empty place_id even for an existing venue.
    if (placeId) body.set('place_id', placeId)
    body.append(fileFieldName, new Blob([bytes], { type: mimeType }), fileName)
    const response = await this.fetchWithCookies(new URL(form.attr('action') ?? pageUrl, this.origin), {
      method: (form.attr('method') ?? 'post').toUpperCase(),
      headers: { 'Referer': pageUrl },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(35_000),
    })
    const html = await response.text()
    const errors = cheerio.load(html)('.error, .errors, .alert-danger, .field_with_errors').text().replace(/\s+/g, ' ').trim()
    if (!response.ok || errors) throw new Error(errors ? `Eventernote 圖片上傳失敗：${errors.slice(0, 300)}` : 'Eventernote 圖片上傳失敗')
    return response.url
  }

  async attendEvent(eventId: string): Promise<SubmittedAttendance> {
    await this.login()
    const eventUrl = new URL(`/events/${eventId}`, this.origin)
    const page = await this.fetchWithCookies(eventUrl, { signal: AbortSignal.timeout(15_000) })
    const html = await page.text()
    if (!page.ok) throw new Error(`Eventernote 活動參加狀態讀取失敗 (HTTP ${page.status})`)
    const $ = cheerio.load(html)
    const existingNoteHref = $('a[href^="/notes/"][href$="/edit"]').first().attr('href')
    const existingNoteId = existingNoteHref?.match(/^\/notes\/(\d+)\/edit(?:[/?#]|$)/)?.[1]
    if (existingNoteId) {
      return {
        created: false,
        noteId: existingNoteId,
        url: new URL(`/notes/${existingNoteId}/edit`, this.origin).toString(),
      }
    }
    const crumb = $('meta[name="crumb"]').attr('content')?.trim() ?? ''
    if (!crumb) throw new Error('Eventernote 活動已建立，但無法取得參加活動所需的驗證資訊')
    const addUrl = new URL('/api/notes/add', this.origin)
    addUrl.searchParams.set('event_id', eventId)
    addUrl.searchParams.set('crumb', crumb)
    const response = await this.fetchWithCookies(addUrl, {
      headers: { Accept: 'application/json', Referer: page.url || eventUrl.toString() },
      signal: AbortSignal.timeout(15_000),
    })
    let payload: { code?: number; results?: { note_id?: string | number } } = {}
    try {
      payload = JSON.parse(await response.text()) as typeof payload
    } catch {
      throw new Error(`Eventernote 活動已建立，但參加活動未成功 (HTTP ${response.status})`)
    }
    const noteId = String(payload.results?.note_id ?? '')
    if (!response.ok || payload.code !== 200 || !/^\d+$/.test(noteId)) {
      throw new Error(`Eventernote 活動已建立，但參加活動未成功 (HTTP ${response.status})`)
    }
    return {
      created: true,
      noteId,
      url: new URL(`/notes/${noteId}/edit`, this.origin).toString(),
    }
  }

  private async submitForm(
    path: string,
    configure: ($: cheerio.CheerioAPI, form: cheerio.Cheerio<AnyNode>, body: URLSearchParams) => void | Promise<void>,
    entityPath: 'actors' | 'places' | 'events',
    expectedName = '',
  ): Promise<SubmittedEntity> {
    let stage: SubmissionStage = 'login'
    let lastResponse: Response | undefined
    const findExactNamedEntity = async (): Promise<SubmittedEntity | undefined> => {
      if (!expectedName || entityPath === 'events') return undefined
      const kind = entityPath === 'actors' ? 'actor' : 'place'
      const matches = await this.searchEntities(expectedName, kind).catch(() => [])
      const exact = new Map(matches
        .filter((candidate) => normalize(candidate.name) === normalize(expectedName))
        .map((candidate) => [candidate.id, candidate]))
      if (exact.size !== 1) return undefined
      const candidate = [...exact.values()][0]
      return { id: candidate.id, url: new URL(`/${entityPath}/${candidate.id}`, this.origin).toString() }
    }
    const identifyCreatedEntity = async (html: string): Promise<SubmittedEntity | undefined> => {
      const fromPage = entityFromCompletePage(html, this.origin, entityPath, expectedName)
      return fromPage ?? findExactNamedEntity()
    }
    try {
      await this.login()
      stage = 'open_form'
      const page = await this.fetchWithCookies(new URL(path, this.origin), { signal: AbortSignal.timeout(15_000) })
      lastResponse = page
      if (page.url.includes('/login')) throw new Error('Eventernote session 已失效')
      const pageHtml = await page.text()
      if (!page.ok) {
        const pageText = cheerio.load(pageHtml)('body').text().replace(/\s+/g, ' ').trim()
        if (/メール認証が必要/.test(pageText)) {
          throw new Error('Eventernote 帳號尚未完成電子郵件驗證；請先登入 Eventernote 完成信箱驗證，再重新上傳')
        }
        throw new Error(
          `Eventernote 拒絕開啟 ${entityPath} 新增表單 (HTTP ${page.status})；請確認該帳號可在 Eventernote 網站新增資料，並檢查伺服器連線是否遭限制`,
        )
      }
      const $ = cheerio.load(pageHtml)
      if ($('form[action*="/login/email"]').length) throw new Error('Eventernote session 已失效')
      const form = this.submissionForm($, page.url, entityPath)
      if (!form.length) throw new Error(`無法辨識 Eventernote ${entityPath} 新增表單`)
      const body = this.collectDefaults($, form)
      await configure($, form, body)

      stage = 'initial_post'
      let response = await this.postForm(form, page.url, body)
      lastResponse = response
      stage = 'initial_response'
      let html = await response.text()
      let id = idFromPath(new URL(response.url).pathname)
      if (response.ok && id && !response.url.includes('/add')) return { id, url: response.url }

      let responsePath = new URL(response.url).pathname
      if (response.ok && new RegExp(`^/${entityPath}/add/complete/?$`).test(responsePath)) {
        const created = await identifyCreatedEntity(html)
        if (created) return created
      }

      const isConfirmationPage = response.ok && /\/add\/confirm\/?$/.test(responsePath)
      if (!isConfirmationPage) throw this.submissionError(html, entityPath)

      const confirmationPage = cheerio.load(html)
      const confirmationForm = this.submissionForm(confirmationPage, response.url, entityPath)
      if (!confirmationForm.length) throw new Error(`無法辨識 Eventernote ${entityPath} 確認表單`)
      const confirmationActionPath = this.formAction(confirmationForm, response.url).pathname
      if (confirmationActionPath === `/${entityPath}/add/confirm`) {
        const existing = await findExactNamedEntity()
        if (existing) return existing
        throw this.submissionError(html, entityPath)
      }
      const confirmationBody = this.collectDefaults(confirmationPage, confirmationForm)
      this.normalizeConfirmationTimes(confirmationBody, body)
      this.preserveConfirmationEntityFields(confirmationBody, body)
      stage = 'confirmation_post'
      response = await this.postForm(confirmationForm, response.url, confirmationBody)
      lastResponse = response
      stage = 'confirmation_response'
      html = await response.text()
      id = idFromPath(new URL(response.url).pathname)
      responsePath = new URL(response.url).pathname
      if (response.ok && id && !response.url.includes('/add')) return { id, url: response.url }
      if (response.ok && new RegExp(`^/${entityPath}/add/complete/?$`).test(responsePath)) {
        const created = await identifyCreatedEntity(html)
        if (created) return created
      }
      throw this.submissionError(html, entityPath)
    } catch (error) {
      logSubmissionFailure({ entity: entityPath, stage, response: lastResponse }, error)
      throw error
    }
  }

  createActor(actor: ActorData): Promise<SubmittedEntity> {
    return this.submitForm('/actors/add', ($, form, body) => {
      if (!this.assignExact(body, 'name', actor.name)
        && !this.assignByContext($, form, body, [/名前|名稱|name/i], actor.name)) {
        this.assignNamed(body, /\[name\]$|actor_name/, actor.name)
      }
      if (!this.assignExact(body, 'kana', actor.reading)
        && !this.assignByContext($, form, body, [/よみ|読み|かな|kana|reading/i], actor.reading)) {
        this.assignNamed(body, /kana|reading|yomi/, actor.reading)
      }
      if (!this.assignExact(body, 'keyword', actor.searchKeywords)) {
        this.assignByContext($, form, body, [/検索キーワード|search.*keyword/i], actor.searchKeywords)
      }
      if (actor.sex && form.find('input[name="sex"], select[name="sex"]').length) body.set('sex', actor.sex)
    }, 'actors', actor.name)
  }

  createPlace(place: PlaceData): Promise<SubmittedEntity> {
    return this.submitForm('/places/add', ($, form, body) => {
      if (!this.assignByContext($, form, body, [/会場名|場所名|名稱|name/i], place.name)) {
        this.assignNamed(body, /\[name\]$|place_name/, place.name)
      }
      if (!this.assignByContext($, form, body, [/住所|地址|address/i], place.address)) {
        this.assignNamed(body, /address/, place.address)
      }
    }, 'places', place.name)
  }

  async createEvent(data: EventData, placeId: string, actorIds: string[]): Promise<SubmittedEntity> {
    return this.submitForm('/events/add', async ($, form, body) => {
      if (!this.assignExact(body, 'event_name', data.title)) {
        this.assignNamed(body, /\[name\]$|event_name|title/, data.title)
      }
      if (placeId && body.has('prefecture')) {
        body.set('prefecture', await this.placePrefecture(placeId, data.place.name))
      }
      if (!this.assignExact(body, 'place_id', placeId)) {
        this.assignNamed(body, /place.*id|place_id/, placeId)
      }
      if (!this.assignExact(body, 'link', data.officialUrl)) {
        this.assignNamed(body, /official.*url|source.*url|url/, data.officialUrl)
      }
      if (!this.assignExact(body, 'description', data.description)) {
        this.assignByContext($, form, body, [/備考|説明|description|note/i], data.description)
      }
      const [year, month, day] = data.date.split('-')
      this.assignExact(body, 'date[year]', integerFormValue(year))
      this.assignExact(body, 'date[month]', integerFormValue(month))
      this.assignExact(body, 'date[day]', integerFormValue(day))
      this.assignTimeParts(body, 'open_time', data.openTime)
      this.assignTimeParts(body, 'start_time', data.startTime)
      this.assignTimeParts(body, 'end_time', data.endTime)
      const actorKey = body.has('actor_ids')
        ? 'actor_ids'
        : [...body.keys()].find((name) => /actor.*id|performer.*id/.test(name))
      if (actorKey && actorIds.length) {
        body.set(actorKey, actorIds.filter(Boolean).join(','))
      }
    }, 'events', data.title)
  }
}
