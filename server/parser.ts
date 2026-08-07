import * as cheerio from 'cheerio'
import type { EventData, Evidence, ReviewEvent } from '../shared/types.js'
import { inferCountry, languageForCountry } from './location.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function text(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return /&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(trimmed)
      ? cheerio.load(trimmed, undefined, false).text().trim()
      : trimmed
  }
  if (typeof value === 'number') return String(value)
  return ''
}

function joinedAddress(parts: unknown[]): string {
  return parts.map(text).filter(Boolean).reduce((result, part) => {
    if (!result || part.startsWith(result)) return part
    if (result.endsWith(part)) return result
    return `${result}${part}`
  }, '')
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const result = text(value)
    if (result) return result
  }
  return ''
}

function collectObjects(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(collectObjects)
  const candidate = object(value)
  if (!candidate) return []
  return [candidate, ...Object.values(candidate).flatMap(collectObjects)]
}

function isEvent(value: JsonObject): boolean {
  const type = value['@type']
  return type === 'Event' || (Array.isArray(type) && type.includes('Event'))
}

function isPerformerEntity(value: JsonObject): boolean {
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']]
  return types.some((type) => ['MusicGroup', 'PerformingGroup', 'DanceGroup', 'TheaterGroup', 'Person'].includes(text(type)))
}

function isoParts(value: string): { date: string; time: string } {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/)
  return { date: match?.[1] ?? '', time: match?.[2] ?? '' }
}

function sameSessionEnd(startValue: string, endValue: string): boolean {
  if (!startValue || !endValue) return true
  const start = Date.parse(startValue)
  const end = Date.parse(endValue)
  if (Number.isFinite(start) && Number.isFinite(end)) {
    const duration = end - start
    return duration >= 0 && duration <= 24 * 60 * 60 * 1_000
  }
  return isoParts(startValue).date === isoParts(endValue).date
}

function names(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.map((item) => firstText(object(item)?.name, item)).filter(Boolean)
}

function meta($: cheerio.CheerioAPI, key: string): string {
  return $(`meta[property="${key}"], meta[name="${key}"]`).first().attr('content')?.trim() ?? ''
}

function contentText($: cheerio.CheerioAPI, selector: string): string {
  const content = $(selector).first().clone()
  if (content.length === 0) return ''
  content.find('br').replaceWith('\n')
  content.find('p, li, dt, dd, h1, h2, h3, h4, h5, h6, section, article, div').each((_, element) => {
    $(element).prepend('\n')
    $(element).append('\n')
  })
  return content.text()
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function evidence(value: string, source: string, confidence: Evidence['confidence']): Evidence {
  return { value, source, confidence: value ? confidence : 'missing' }
}

export function extractRelevantPageText(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, noscript, iframe, template, svg').remove()
  const main = $('main, article, [role="main"]').first()
  const root = main.text().replace(/\s+/g, ' ').trim().length >= 200 ? main : $('body')
  root.find('br').replaceWith('\n')
  root.find('h1, h2, h3, h4, h5, h6, p, li, dt, dd, tr, section, article, div').each((_, element) => {
    $(element).append('\n')
  })
  const seen = new Set<string>()
  const lines = root.text().split(/\r?\n/).map((line) => line.replace(/[\t ]+/g, ' ').trim()).filter((line) => {
    if (!line || seen.has(line)) return false
    seen.add(line)
    return true
  })
  const heading = [
    $('title').text().replace(/\s+/g, ' ').trim(),
    meta($, 'og:title'),
    meta($, 'description'),
    meta($, 'og:description'),
  ].filter(Boolean)
  return [...new Set([...heading, ...lines])].join('\n').slice(0, 30_000)
}

export function parseEventPage(html: string, sourceUrl: string): Pick<ReviewEvent, 'sourceTitle' | 'data' | 'evidence' | 'warnings'> {
  const $ = cheerio.load(html)
  const jsonObjects: JsonObject[] = []
  $('script[type="application/ld+json"]').each((_, element) => {
    try { jsonObjects.push(...collectObjects(JSON.parse($(element).text()))) } catch { /* ignore invalid blocks */ }
  })
  const event = jsonObjects.find(isEvent) ?? {}
  const location = object(event.location) ?? {}
  const addressValue = object(location.address)
  const start = isoParts(text(event.startDate))
  const end = isoParts(text(event.endDate))
  const structuredEndTime = sameSessionEnd(text(event.startDate), text(event.endDate)) ? end.time : ''
  const visibleText = extractRelevantPageText(html)
  const eventernoteTable = $('.gb_events_info_table').first()
  const eventernoteRows = eventernoteTable.find('tr').toArray()
  const eventernoteTimeRow = eventernoteRows.find((row) => $(row).find('td').first().text().trim() === '時間')
  const eventernoteTimeText = eventernoteTimeRow
    ? $(eventernoteTimeRow).find('td').eq(1).text().replace(/\s+/g, ' ').trim()
    : ''
  const eventernoteVenue = eventernoteTable.find('a[href^="/places/"]').first()
  const eventernoteActorLinks = eventernoteTable.find('a[href^="/actors/"]').toArray()
  const eventernoteDate = visibleText.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? ''
  const eventernoteOpenTime = eventernoteTimeText.match(/開場\s*([0-2]?\d:[0-5]\d)/)?.[1] ?? ''
  const eventernoteStartTime = eventernoteTimeText.match(/開演\s*([0-2]?\d:[0-5]\d)/)?.[1] ?? ''
  const eventernoteEndTime = eventernoteTimeText.match(/終演\s*([0-2]?\d:[0-5]\d)/)?.[1] ?? ''
  const openMatch = visibleText.match(/(?:開場|OPEN)\s*[:：]?\s*(\d{1,2}:\d{2})/i)
  const startMatch = visibleText.match(/(?:開演|START)\s*[:：]?\s*(\d{1,2}:\d{2})/i)
  const title = firstText(event.name, meta($, 'og:title'), $('title').text()).replace(/\s+/g, ' ')
  const pageDescription = contentText($, '[data-testid="event-description"]')
  const description = firstText(pageDescription, event.description, meta($, 'description'), meta($, 'og:description'))
  const image = Array.isArray(event.image) ? text(event.image[0]) : firstText(object(event.image)?.url, event.image, meta($, 'og:image'))
  const address = addressValue
    ? joinedAddress([addressValue.addressRegion, addressValue.addressLocality, addressValue.streetAddress])
    : text(location.address)
  const linkedActors = eventernoteActorLinks.map((link) => ({
    id: ($(link).attr('href') ?? '').match(/\/actors\/.*?\/(\d+)(?:[/?#]|$)/)?.[1]
      ?? ($(link).attr('href') ?? '').match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? '',
    name: $(link).text().replace(/\s+/g, ' ').trim(),
  })).filter((actor) => actor.name)
  const performers = [...new Set([
    ...names(event.performer),
    ...jsonObjects.filter(isPerformerEntity).map((item) => text(item.name)).filter(Boolean),
    ...linkedActors.map((actor) => actor.name),
  ])]
  const placeName = firstText(location.name, eventernoteVenue.text())
  const placeId = (eventernoteVenue.attr('href') ?? '').match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? ''
  const countryCode = inferCountry(`${placeName} ${address} ${description} ${visibleText.slice(0, 6_000)}`, $('html').attr('lang') ?? '')
  const data: EventData = {
    title,
    date: start.date || eventernoteDate,
    openTime: eventernoteOpenTime || openMatch?.[1]?.padStart(5, '0') || '',
    startTime: start.time || eventernoteStartTime || startMatch?.[1]?.padStart(5, '0') || '',
    endTime: structuredEndTime || eventernoteEndTime,
    description,
    officialUrl: firstText(event.url, meta($, 'og:url'), sourceUrl),
    imageUrl: image,
    descriptionLanguage: languageForCountry(countryCode),
    place: { name: placeName, address, countryCode, selectedId: placeId, createNew: false, candidates: [] },
    actors: performers.map((name) => ({
      name, reading: '',
      selectedId: linkedActors.find((actor) => actor.name === name)?.id ?? '', createNew: false,
      candidates: [],
    })),
  }
  const evidenceMap: ReviewEvent['evidence'] = {
    title: evidence(title, event.name ? 'JSON-LD: Event.name' : '頁面標題 / Open Graph', event.name ? 'high' : 'medium'),
    date: evidence(data.date, start.date ? 'JSON-LD: Event.startDate' : 'Eventernote 活動詳情', data.date ? 'high' : 'missing'),
    openTime: evidence(data.openTime, '頁面文字: 開場 / OPEN', openMatch ? 'medium' : 'missing'),
    startTime: evidence(data.startTime, start.time ? 'JSON-LD: Event.startDate' : '頁面文字: 開演 / START', data.startTime ? 'high' : 'missing'),
    endTime: evidence(data.endTime, structuredEndTime ? 'JSON-LD: Event.endDate' : 'Eventernote 時間欄', data.endTime ? 'high' : 'missing'),
    ...(description ? { description: evidence(
      description,
      pageDescription
        ? '頁面: [data-testid="event-description"]'
        : event.description ? 'JSON-LD: Event.description' : 'Meta description',
      pageDescription || event.description ? 'high' : 'medium',
    ) } : {}),
    officialUrl: evidence(data.officialUrl, event.url ? 'JSON-LD: Event.url' : '來源網址', event.url ? 'high' : 'medium'),
    imageUrl: evidence(data.imageUrl, event.image ? 'JSON-LD: Event.image' : 'Open Graph image', data.imageUrl ? 'high' : 'missing'),
    'place.name': evidence(data.place.name, location.name ? 'JSON-LD: Event.location.name' : 'Eventernote 場所連結', data.place.name ? 'high' : 'missing'),
    'place.address': evidence(data.place.address, 'JSON-LD: Event.location.address', data.place.address ? 'high' : 'missing'),
    'place.countryCode': evidence(data.place.countryCode, '活動地點文字判斷', data.place.countryCode ? 'medium' : 'missing'),
    descriptionLanguage: evidence(data.descriptionLanguage, '依活動國家/地區選擇', data.place.countryCode ? 'high' : 'low'),
    actors: evidence(performers.join('、'), linkedActors.length ? 'Eventernote 出演者連結' : 'JSON-LD: Event.performer / performer entities', performers.length ? 'high' : 'missing'),
  }
  const warnings: string[] = []
  if (!data.title) warnings.push('找不到活動名稱')
  if (!data.date) warnings.push('找不到活動日期')
  if (!data.startTime) warnings.push('找不到開演時間')
  if (!data.place.name) warnings.push('找不到開催場所')
  if (data.actors.length === 0) warnings.push('找不到出演者')
  return { sourceTitle: title || new URL(sourceUrl).hostname, data, evidence: evidenceMap, warnings }
}
