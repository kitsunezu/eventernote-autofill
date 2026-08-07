import * as cheerio from 'cheerio'
import type { Draft, EventData } from '../shared/types.js'
import { classifySource } from './location.js'

const TICKET_LINK_TEXT = /ticket|tickets|ticketing|buy|reserve|reservation|チケット|入場券|前売|予約|申込|申し込み|購票|售票|門票|買票/i
const SHORTENER_HOSTS = new Set(['t.co', 'bit.ly', 'tinyurl.com', 'x.gd', 'is.gd', 'lnk.to'])
const MAX_LINKED_URLS = 5
const MAX_IMAGE_URLS = 4

export interface SourceReferences {
  linkedUrls: string[]
  imageUrls: string[]
}

type ParsedSource = Pick<Draft, 'sourceTitle' | 'data' | 'evidence' | 'warnings'>

function httpUrl(value: string, baseUrl: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed, baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function urlFromText(value: string): string {
  const match = value.trim().match(/(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i)?.[0] ?? ''
  return match && !/^https?:\/\//i.test(match) ? `https://${match}` : match
}

function isShortener(value: string): boolean {
  return SHORTENER_HOSTS.has(new URL(value).hostname.toLowerCase().replace(/^www\./, ''))
}

function likelyContentImage(value: string): boolean {
  const url = new URL(value)
  const path = url.pathname.toLowerCase()
  if (/profile_images|emoji|avatar|favicon|logo|icon/.test(path)) return false
  if (url.hostname === 'pbs.twimg.com') return path.startsWith('/media/')
  return true
}

function imageIdentity(value: string): string {
  const url = new URL(value)
  const twitterMediaId = url.pathname.match(/^\/media\/([^./:]+)/)?.[1]
  return twitterMediaId && url.hostname === 'pbs.twimg.com'
    ? `${url.hostname}/media/${twitterMediaId}`
    : `${url.hostname}${url.pathname}`
}

export function extractSourceReferences(html: string, sourceUrl: string): SourceReferences {
  const $ = cheerio.load(html)
  const source = new URL(sourceUrl)
  const links = new Map<string, number>()

  $('a[href]').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim()
    const candidates = [$(element).attr('href') ?? '', urlFromText(text)]
    for (const candidate of candidates) {
      const resolved = httpUrl(candidate, sourceUrl)
      if (!resolved) continue
      const url = new URL(resolved)
      if (url.hostname === source.hostname) continue
      const kind = classifySource(resolved)
      const priority = kind === 'ticketing' ? 0 : TICKET_LINK_TEXT.test(text) ? 1 : isShortener(resolved) ? 2 : -1
      if (priority < 0) continue
      const previous = links.get(resolved)
      if (previous === undefined || priority < previous) links.set(resolved, priority)
    }
  })

  const images = new Map<string, string>()
  const addImage = (value: string | undefined) => {
    if (images.size >= MAX_IMAGE_URLS) return
    const resolved = httpUrl(value ?? '', sourceUrl)
    if (resolved && likelyContentImage(resolved)) {
      const identity = imageIdentity(resolved)
      if (!images.has(identity)) images.set(identity, resolved)
    }
  }
  $('meta[property="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]').each((_, element) => {
    addImage($(element).attr('content'))
  })
  $('main img[src], article img[src]').each((_, element) => addImage($(element).attr('src')))

  return {
    linkedUrls: [...links.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(0, MAX_LINKED_URLS)
      .map(([url]) => url),
    imageUrls: [...images.values()],
  }
}

export function extractionScore(data: EventData): number {
  return Number(Boolean(data.title))
    + Number(Boolean(data.date)) * 4
    + Number(Boolean(data.startTime)) * 3
    + Number(Boolean(data.endTime))
    + Number(Boolean(data.place.name)) * 3
    + Number(Boolean(data.place.address))
    + Math.min(data.actors.length, 3)
}

export function selectBestParsedSource(sources: ParsedSource[]): ParsedSource {
  if (sources.length === 0) throw new Error('沒有可用的來源解析結果')
  return sources.reduce((best, candidate) => (
    extractionScore(candidate.data) > extractionScore(best.data) ? candidate : best
  ))
}
