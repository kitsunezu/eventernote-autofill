import * as cheerio from 'cheerio'
import { z } from 'zod'
import { safeFetchJson } from './safe-fetch.js'

const FAM_GRAPHQL_URL = 'https://api.thefam.jp/graphql'
const FAM_NEWS_PATH = /^\/news\/([A-Za-z0-9_-]{1,128})\/?$/
const FAM_PLATFORM_MARKER = /window\.__NUXT__.*(?:fam-fansite\.imgix\.net|thefam\.jp)/s
const FAM_NEWS_QUERY = `query getNews($id: ID!) {
  news(id: $id) {
    id
    subject
    body
  }
}`

const FamNewsResponse = z.object({
  data: z.object({
    news: z.object({
      id: z.string().max(200),
      subject: z.string().max(500),
      body: z.string().max(1_500_000),
    }).nullable(),
  }).optional(),
})

type JsonFetcher = (
  input: string,
  body: unknown,
  referrer?: string,
) => Promise<{ json: unknown; finalUrl: string }>

export interface HydratedSourcePage {
  html: string
  provider?: 'fam-news'
}

function httpUrl(value: string | undefined, baseUrl: string): string {
  if (!value) return ''
  try {
    const url = new URL(value, baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function setMeta($: cheerio.CheerioAPI, property: string, content: string): void {
  const current = $(`meta[property="${property}"]`).first()
  if (current.length) {
    current.attr('content', content)
    return
  }
  $('head').append($('<meta>').attr({ property, content }))
}

export async function hydrateDynamicSourcePage(
  html: string,
  sourceUrl: string,
  fetchJson: JsonFetcher = safeFetchJson,
): Promise<HydratedSourcePage> {
  const source = new URL(sourceUrl)
  const id = source.pathname.match(FAM_NEWS_PATH)?.[1]
  if (!id || !FAM_PLATFORM_MARKER.test(html)) return { html }

  const response = await fetchJson(FAM_GRAPHQL_URL, {
    operationName: 'getNews',
    variables: { id },
    query: FAM_NEWS_QUERY,
  }, sourceUrl)
  const payload = FamNewsResponse.parse(response.json)
  const news = payload.data?.news
  if (!news || news.id !== id || !news.subject.trim() || !news.body.trim()) {
    throw new Error('FAM 公開新聞 API 沒有回傳相符的正文')
  }

  const body = cheerio.load(news.body, undefined, false)
  body('script, style, noscript, iframe, template, object, embed').remove()
  const bodyImage = httpUrl(body('img[src]').first().attr('src'), sourceUrl)

  const $ = cheerio.load(html)
  $('title').first().text(news.subject.trim())
  setMeta($, 'og:title', news.subject.trim())
  setMeta($, 'og:url', sourceUrl)
  if (bodyImage) setMeta($, 'og:image', bodyImage)

  const dynamicContent = $('<main data-eventernote-dynamic-source="fam-news"><h1></h1><article data-testid="event-description"></article></main>')
  dynamicContent.find('h1').text(news.subject.trim())
  dynamicContent.find('article').html(body.html())
  $('body').append(dynamicContent)

  return { html: $.html(), provider: 'fam-news' }
}
