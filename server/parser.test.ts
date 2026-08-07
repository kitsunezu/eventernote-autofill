import { describe, expect, it } from 'vitest'
import { extractRelevantPageText, parseEventPage } from './parser.js'

describe('parseEventPage', () => {
  it('extracts event fields and evidence from JSON-LD', () => {
    const html = `<!doctype html><html><head>
      <meta property="og:image" content="https://example.com/event.jpg">
      <script type="application/ld+json">{
        "@context":"https://schema.org", "@type":"Event", "name":"Sample Live",
        "startDate":"2026-09-12T18:30:00+09:00", "endDate":"2026-09-12T20:00:00+09:00",
        "url":"https://example.com/live", "description":"Doors open 17:30",
        "location":{"@type":"Place","name":"Example Hall","address":{"addressRegion":"東京都","addressLocality":"渋谷区","streetAddress":"1-2-3"}},
        "performer":[{"@type":"Person","name":"A Singer"}]
      }</script></head><body>開場 17:30 / 開演 18:30</body></html>`
    const parsed = parseEventPage(html, 'https://example.com/source')
    expect(parsed.data.title).toBe('Sample Live')
    expect(parsed.data.date).toBe('2026-09-12')
    expect(parsed.data.openTime).toBe('17:30')
    expect(parsed.data.startTime).toBe('18:30')
    expect(parsed.data.place).toMatchObject({ name: 'Example Hall', address: '東京都渋谷区1-2-3' })
    expect(parsed.data.place.countryCode).toBe('JP')
    expect(parsed.data.descriptionLanguage).toBe('ja')
    expect(parsed.data.actors[0].name).toBe('A Singer')
    expect(parsed.evidence.title?.confidence).toBe('high')
  })

  it('uses performer entities without treating the organizer as an actor', () => {
    const html = `<script type="application/ld+json">{
      "@context":"https://schema.org","@graph":[
        {"@type":"Event","name":"Festival","startDate":"2026-09-26T12:00:00+09:00","organizer":{"@type":"Organization","name":"Ticketing Company"}},
        {"@type":"MusicGroup","name":"Artist A&#039;s"},
        {"@type":"PerformingGroup","name":"Artist B"}
      ]
    }</script>`

    expect(parseEventPage(html, 'https://tickets.example/event').data.actors.map((actor) => actor.name)).toEqual([
      "Artist A's", 'Artist B',
    ])
  })

  it('does not duplicate overlapping address regions', () => {
    const html = `<script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Event","name":"Festival",
      "startDate":"2026-09-26T12:00:00+09:00",
      "location":{"@type":"EventVenue","name":"Venue","address":{
        "addressRegion":"東京都","addressLocality":"東京都江東区","streetAddress":"青海1丁目1"
      }}
    }</script>`
    expect(parseEventPage(html, 'https://tickets.example/event').data.place.address).toBe('東京都江東区青海1丁目1')
  })

  it('does not treat a multi-day range end as the first session end time', () => {
    const html = `<script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Event","name":"Two Day Festival",
      "startDate":"2026-09-26T12:00:00+09:00","endDate":"2026-09-27T21:00:00+09:00"
    }</script>`
    expect(parseEventPage(html, 'https://tickets.example/event').data.endTime).toBe('')
  })

  it('keeps an overnight end time within the same session', () => {
    const html = `<script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Event","name":"All Night Event",
      "startDate":"2026-09-26T22:00:00+09:00","endDate":"2026-09-27T05:00:00+09:00"
    }</script>`
    expect(parseEventPage(html, 'https://tickets.example/event').data.endTime).toBe('05:00')
  })

  it('uses Open Graph metadata without inventing missing fields', () => {
    const parsed = parseEventPage('<meta property="og:title" content="Announcement"><body>No date</body>', 'https://example.com')
    expect(parsed.data.title).toBe('Announcement')
    expect(parsed.data.date).toBe('')
    expect(parsed.data.description).toBe('')
    expect(parsed.evidence.description).toBeUndefined()
    expect(parsed.data.actors).toEqual([])
    expect(parsed.warnings).toContain('找不到活動日期')
  })

  it('prefers the explicit page event description over ticketing metadata', () => {
    const parsed = parseEventPage(`<html><head>
      <meta name="description" content="Sample Event のチケット情報ページです。オンラインで簡単にチケットを購入できます。">
      <script type="application/ld+json">{
        "@context":"https://schema.org","@type":"Event","name":"Sample Event",
        "description":"Ticket sales information"
      }</script></head><body>
      <section data-testid="event-description">
        <p>イベント内容の紹介</p>
        <div><strong>出演者</strong><p>Artist A の紹介</p><p>Artist B の紹介</p></div>
      </section>
    </body></html>`, 'https://tickets.example/event')

    expect(parsed.data.description).toBe('イベント内容の紹介\n出演者\nArtist A の紹介\nArtist B の紹介')
    expect(parsed.evidence.description).toEqual({
      value: parsed.data.description,
      source: '頁面: [data-testid="event-description"]',
      confidence: 'high',
    })
  })

  it('parses Eventernote detail tables and preserves existing entity ids', () => {
    const html = `<meta property="og:title" content="Detail Event"><body>
      <div class="gb_events_info_table"><table>
        <tr><td>開催日</td><td>2026-08-14</td></tr>
        <tr><td>時間</td><td>開場 18:00 開演 19:00</td></tr>
        <tr><td>場所</td><td><a href="/places/example/123">Example Hall</a></td></tr>
        <tr><td>出演者</td><td><a href="/actors/example/456">Example Artist</a></td></tr>
      </table></div></body>`
    const parsed = parseEventPage(html, 'https://www.eventernote.com/events/99')
    expect(parsed.data.date).toBe('2026-08-14')
    expect(parsed.data.openTime).toBe('18:00')
    expect(parsed.data.startTime).toBe('19:00')
    expect(parsed.data.endTime).toBe('')
    expect(parsed.data.place).toMatchObject({ name: 'Example Hall', selectedId: '123' })
    expect(parsed.data.actors[0]).toMatchObject({ name: 'Example Artist', selectedId: '456' })
  })

  it('removes script noise while preserving the full main event content', () => {
    const html = `<html><head><title>Clean Event</title></head><body>
      <script>${'window.noise = "x";'.repeat(2_000)}</script>
      <main><h1>Clean Event</h1><p>2026年8月8日</p><p>日場 開場14:00 開演14:30</p><p>夜場 開場18:30 開演19:00</p></main>
    </body></html>`
    const text = extractRelevantPageText(html)
    expect(text).toContain('開演14:30')
    expect(text).toContain('開演19:00')
    expect(text).not.toContain('window.noise')
    expect(text.length).toBeLessThan(500)
  })

  it('keeps adjacent block text separated for performer extraction', () => {
    const html = `<main>${'<p>Event details</p>'.repeat(30)}
      <div><span>DJ WILDPARTY / Eye</span></div><div><span>Invaders (FAIZ, Ichii)</span></div>
    </main>`
    const text = extractRelevantPageText(html)
    expect(text).toContain('DJ WILDPARTY / Eye\n')
    expect(text).toContain('Invaders (FAIZ, Ichii)')
    expect(text).not.toContain('EyeInvaders')
  })
})
