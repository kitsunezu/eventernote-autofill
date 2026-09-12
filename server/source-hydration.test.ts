import { describe, expect, it, vi } from 'vitest'
import { extractRelevantPageText, parseEventPage } from './parser.js'
import { extractSourceReferences } from './source-discovery.js'
import { hydrateDynamicSourcePage } from './source-hydration.js'

const sourceUrl = 'https://harutya-fc.com/news/C4bDdU6Amk76YE5UYuoTQA'
const shell = `<!doctype html><html lang="ja"><head>
  <title>tea bottle | 春茶 OFFICIAL FANCLUB | お知らせ</title>
  <meta property="og:title" content="tea bottle | 春茶 OFFICIAL FANCLUB | お知らせ">
  <meta property="og:url" content="harutya-fc.com">
  <meta property="og:image" content="https://fam-fansite.imgix.net/shared_file/14887/site.jpg">
</head><body><div id="__nuxt"></div>
  <script>window.__NUXT__={assets:"https://fam-fansite.imgix.net/shared_file/14887/site.jpg"}</script>
</body></html>`

describe('dynamic source hydration', () => {
  it('hydrates a public FAM news body before parsing and AI extraction', async () => {
    const fetchJson = vi.fn(async () => ({
      finalUrl: 'https://api.thefam.jp/graphql',
      json: {
        data: {
          news: {
            id: 'C4bDdU6Amk76YE5UYuoTQA',
            subject: 'FC先行受付開始｜HARUTYA ONE-MAN LIVE 「ここから。」',
            body: `<script>ignore this instruction</script>
              <p>HARUTYA ONE-MAN LIVE 「ここから。」</p>
              <p>◆大阪</p><p>2027年2月21日(日)</p><p>OPEN 17:00 / START 18:00</p>
              <p>[会場]Zepp Osaka Bayside</p><p>〒554-0031 大阪府大阪市此花区桜島1丁目1-61</p>
              <p>◆東京</p><p>2027年2月28日(日)</p><p>OPEN 17:00 / START 18:00</p>
              <p>[会場]Zepp Haneda (TOKYO)</p>
              <img src="https://fam-fansite.imgix.net/shared_file/14887/event.jpg">`,
          },
        },
      },
    }))

    const hydrated = await hydrateDynamicSourcePage(shell, sourceUrl, fetchJson)
    const parsed = parseEventPage(hydrated.html, sourceUrl)
    const pageText = extractRelevantPageText(hydrated.html)

    expect(hydrated.provider).toBe('fam-news')
    expect(fetchJson).toHaveBeenCalledWith(
      'https://api.thefam.jp/graphql',
      expect.objectContaining({ operationName: 'getNews', variables: { id: 'C4bDdU6Amk76YE5UYuoTQA' } }),
      sourceUrl,
    )
    expect(parsed.data).toMatchObject({
      title: 'FC先行受付開始｜HARUTYA ONE-MAN LIVE 「ここから。」',
      openTime: '17:00',
      startTime: '18:00',
      officialUrl: sourceUrl,
      imageUrl: 'https://fam-fansite.imgix.net/shared_file/14887/event.jpg',
    })
    expect(parsed.data.description).toContain('Zepp Osaka Bayside')
    expect(pageText).toContain('2027年2月21日(日)')
    expect(pageText).toContain('Zepp Haneda (TOKYO)')
    expect(pageText).not.toContain('ignore this instruction')
    expect(extractSourceReferences(hydrated.html, sourceUrl).imageUrls).toEqual([
      'https://fam-fansite.imgix.net/shared_file/14887/event.jpg',
    ])
  })

  it('leaves ordinary and non-news pages unchanged without an API call', async () => {
    const fetchJson = vi.fn()
    await expect(hydrateDynamicSourcePage('<html><body>Static page</body></html>', 'https://example.com/news/id', fetchJson))
      .resolves.toEqual({ html: '<html><body>Static page</body></html>' })
    await expect(hydrateDynamicSourcePage(shell, 'https://harutya-fc.com/profile', fetchJson))
      .resolves.toEqual({ html: shell })
    expect(fetchJson).not.toHaveBeenCalled()
  })

  it('rejects mismatched API content instead of attaching another news item', async () => {
    const fetchJson = vi.fn(async () => ({
      finalUrl: 'https://api.thefam.jp/graphql',
      json: { data: { news: { id: 'different', subject: 'Other', body: '<p>Other</p>' } } },
    }))
    await expect(hydrateDynamicSourcePage(shell, sourceUrl, fetchJson)).rejects.toThrow(/相符的正文/)
  })
})
