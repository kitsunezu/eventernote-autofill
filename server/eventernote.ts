import * as cheerio from 'cheerio'
import makeFetchCookie from 'fetch-cookie'
import { CookieJar } from 'tough-cookie'
import type { AnyNode } from 'domhandler'
import type { ActorDraft, EntityCandidate, EventData, PlaceDraft } from '../shared/types.js'

interface SubmittedEntity { id: string; url: string }

interface PostCreateForm {
  $: cheerio.CheerioAPI
  form: cheerio.Cheerio<AnyNode>
  pageUrl: string
}

export interface DuplicateEventCandidate extends SubmittedEntity {
  name: string
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s・･\-_.,，。()（）「」『』]/g, '')
}

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

function idFromPath(path: string): string {
  return path.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? ''
}

function dateVariants(date: string): string[] {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return [date]
  return [date, `${year}年${month}月${day}日`, `${year}/${month}/${day}`]
}

export function parseDuplicateEventCandidate(
  html: string,
  origin: string,
  data: Pick<EventData, 'title' | 'date' | 'place'>,
): DuplicateEventCandidate | undefined {
  const $ = cheerio.load(html)
  const expectedTitle = normalize(data.title)
  const expectedPlace = normalize(data.place.name)
  for (const link of $('a[href^="/events/"]').toArray()) {
    const href = $(link).attr('href') ?? ''
    const id = idFromPath(href)
    const name = $(link).text().replace(/\s+/g, ' ').trim()
    if (!id || normalize(name) !== expectedTitle) continue
    const container = $(link).closest('li').length
      ? $(link).closest('li')
      : $(link).closest('tr, article, .event, .gb_event_list')
    const context = container.text().replace(/\s+/g, ' ').trim()
    if (!dateVariants(data.date).some((date) => context.includes(date))) continue
    if (expectedPlace && !normalize(context).includes(expectedPlace)) continue
    return { id, name, url: new URL(href, origin).toString() }
  }
  return undefined
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
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 EventernoteAutofill/0.1', 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(15_000),
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
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 EventernoteAutofill/0.1',
          'Accept-Language': 'ja',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Eventernote 搜尋失敗 (HTTP ${response.status})`)
      const payload = await response.json() as {
        results?: Array<{ id?: string | number; name?: string; place_name?: string }>
      }
      return (payload.results ?? []).flatMap((item) => {
        const id = String(item.id ?? '')
        const name = String(kind === 'actor' ? item.name ?? '' : item.place_name ?? '').trim()
        const score = similarity(query, name)
        if (!id || !name || score < 0.25) return []
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
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 EventernoteAutofill/0.1', 'Accept-Language': 'ja' },
      signal: AbortSignal.timeout(15_000),
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

  async findDuplicateEvent(data: EventData): Promise<DuplicateEventCandidate | undefined> {
    const url = new URL('/events/search', this.origin)
    url.searchParams.set('keyword', data.title)
    url.searchParams.set('__from', 'autofill-duplicate-check')
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 EventernoteAutofill/0.1', 'Accept-Language': 'ja' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseDuplicateEventCandidate(await response.text(), this.origin, data)
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

  private async findImageForm(eventId: string): Promise<PostCreateForm> {
    await this.login()
    const detailUrl = new URL(`/events/${eventId}`, this.origin)
    const detailResponse = await this.fetchWithCookies(detailUrl, { signal: AbortSignal.timeout(15_000) })
    const detailHtml = await detailResponse.text()
    const detail = cheerio.load(detailHtml)
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
        if (form.find('input[type="file"]').length) return { $, form, pageUrl }
      }
    }
    throw new Error('Eventernote 活動已建立，但找不到圖片新增表單；請在活動頁手動補上')
  }

  async addEventImage(eventId: string, bytes: Uint8Array, mimeType: string, fileName: string): Promise<string> {
    const { $, form, pageUrl } = await this.findImageForm(eventId)
    const fileField = form.find('input[type="file"][name]').first()
    const fileFieldName = fileField.attr('name')
    if (!fileFieldName) throw new Error('Eventernote 活動已建立，但無法辨識圖片上傳欄位')
    const body = new FormData()
    form.find('input[type="hidden"], input[type="text"], textarea, select').each((_, item) => {
      const field = $(item)
      const name = field.attr('name')
      if (name) body.append(name, field.val()?.toString() ?? '')
    })
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

  private async submitForm(
    path: string,
    configure: ($: cheerio.CheerioAPI, form: cheerio.Cheerio<AnyNode>, body: URLSearchParams) => void,
    entityPath: 'actors' | 'places' | 'events',
  ): Promise<SubmittedEntity> {
    await this.login()
    const page = await this.fetchWithCookies(new URL(path, this.origin), { signal: AbortSignal.timeout(15_000) })
    if (page.url.includes('/login')) throw new Error('Eventernote session 已失效')
    const $ = cheerio.load(await page.text())
    const form = $('form').filter((_, item) => {
      const action = $(item).attr('action') ?? ''
      return action.includes(`/${entityPath}`) && !action.includes('/search')
    }).first()
    if (!form.length) throw new Error(`無法辨識 Eventernote ${entityPath} 新增表單`)
    const body = this.collectDefaults($, form)
    configure($, form, body)
    const action = new URL(form.attr('action') ?? path, this.origin)
    const response = await this.fetchWithCookies(action, {
      method: (form.attr('method') ?? 'post').toUpperCase(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': page.url },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    })
    const html = await response.text()
    const result = cheerio.load(html)
    const errors = result('.error, .errors, .alert-danger, .field_with_errors').text().replace(/\s+/g, ' ').trim()
    const id = idFromPath(new URL(response.url).pathname)
    if (!response.ok || !id || response.url.includes('/add')) {
      const duplicateMessage = entityPath === 'events'
        ? duplicateSubmissionMessage(html, this.origin, errors)
        : undefined
      if (duplicateMessage) throw new Error(duplicateMessage)
      throw new Error(errors ? `Eventernote 拒絕提交：${errors.slice(0, 300)}` : `Eventernote ${entityPath} 提交未成功`)
    }
    return { id, url: response.url }
  }

  createActor(actor: ActorDraft): Promise<SubmittedEntity> {
    return this.submitForm('/actors/add', ($, form, body) => {
      if (!this.assignByContext($, form, body, [/名前|名稱|name/i], actor.name)) {
        this.assignNamed(body, /\[name\]$|actor_name/, actor.name)
      }
      if (!this.assignByContext($, form, body, [/よみ|読み|かな|kana|reading/i], actor.reading)) {
        this.assignNamed(body, /kana|reading|yomi/, actor.reading)
      }
    }, 'actors')
  }

  createPlace(place: PlaceDraft): Promise<SubmittedEntity> {
    return this.submitForm('/places/add', ($, form, body) => {
      if (!this.assignByContext($, form, body, [/会場名|場所名|名稱|name/i], place.name)) {
        this.assignNamed(body, /\[name\]$|place_name/, place.name)
      }
      if (!this.assignByContext($, form, body, [/住所|地址|address/i], place.address)) {
        this.assignNamed(body, /address/, place.address)
      }
    }, 'places')
  }

  async createEvent(data: EventData, placeId: string, actorIds: string[]): Promise<SubmittedEntity> {
    let duplicate: DuplicateEventCandidate | undefined
    try {
      duplicate = await this.findDuplicateEvent(data)
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知錯誤'
      throw new Error(`Eventernote 重複活動檢查失敗，為避免重複登錄，本次未送出：${detail}`)
    }
    if (duplicate) {
      throw new Error(`Eventernote 已有相同活動，未送出新資料：${duplicate.name} ${duplicate.url}。請使用既有活動；如確定不是同一活動，修正名稱、日期或場所後重新確認。`)
    }
    return this.submitForm('/events/add', ($, form, body) => {
      if (!this.assignByContext($, form, body, [/イベント名|活動名稱|タイトル|title/i], data.title)) {
        this.assignNamed(body, /\[name\]$|event_name|title/, data.title)
      }
      this.assignNamed(body, /place.*id|place_id/, placeId)
      this.assignNamed(body, /official.*url|source.*url|url/, data.officialUrl)
      this.assignByContext($, form, body, [/備考|説明|description|note/i], data.description)
      const [year, month, day] = data.date.split('-')
      this.assignNamed(body, /start.*year|year.*start|\[year\]/, year)
      this.assignNamed(body, /start.*month|month.*start|\[month\]/, month)
      this.assignNamed(body, /start.*day|day.*start|\[day\]/, day)
      const [hour, minute] = data.startTime.split(':')
      this.assignNamed(body, /start.*hour|hour.*start/, hour)
      this.assignNamed(body, /start.*min|minute.*start/, minute)
      const actorKey = [...body.keys()].find((name) => /actor.*id|performer.*id/.test(name))
      if (actorKey && actorIds.length) {
        body.delete(actorKey)
        for (const id of actorIds) body.append(actorKey, id)
      }
    }, 'events')
  }
}
