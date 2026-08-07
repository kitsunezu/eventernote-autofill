import { describe, expect, it } from 'vitest'
import { parseEventPage } from './parser.js'
import { extractSourceReferences, selectBestParsedSource } from './source-discovery.js'

describe('source discovery', () => {
  it('finds ticketing links and event media in a server-rendered X page', () => {
    const html = `
      <html><head>
        <meta property="og:image" content="https://pbs.twimg.com/media/event-poster.jpg:large">
      </head><body><main>
        <a href="https://cultureofasia.zaiko.io/e/boukawa-2026">cultureofasia.zaiko.io/e/boukawa-2026</a>
        <a href="https://x.com/example/status/1/photo/1"><img src="https://pbs.twimg.com/media/event-poster.jpg:large"></a>
        <img src="https://pbs.twimg.com/profile_images/avatar_normal.jpg">
      </main></body></html>
    `

    expect(extractSourceReferences(html, 'https://x.com/example/status/1')).toEqual({
      linkedUrls: ['https://cultureofasia.zaiko.io/e/boukawa-2026'],
      imageUrls: ['https://pbs.twimg.com/media/event-poster.jpg:large'],
    })
  })

  it('keeps short purchase links as fallback candidates', () => {
    const html = '<a href="https://t.co/example">TICKET INFO</a>'
    expect(extractSourceReferences(html, 'https://x.com/example/status/1').linkedUrls).toEqual([
      'https://t.co/example',
    ])
  })

  it('selects a complete linked ticket page over social metadata', () => {
    const social = parseEventPage(`
      <meta property="og:title" content="Xユーザーの主催者（@example）さん">
    `, 'https://x.com/example/status/1')
    const ticket = parseEventPage(`
      <script type="application/ld+json">{
        "@context":"https://schema.org","@type":"Event","name":"Sample Live",
        "startDate":"2026-09-26T12:00:00+09:00","endDate":"2026-09-26T20:30:00+09:00",
        "location":{"@type":"EventVenue","name":"Sample Venue","address":{"streetAddress":"Tokyo"}},
        "performer":[{"@type":"MusicGroup","name":"Artist A"}]
      }</script>
    `, 'https://tickets.example/event')

    expect(selectBestParsedSource([social, ticket]).data).toMatchObject({
      title: 'Sample Live', date: '2026-09-26', startTime: '12:00', endTime: '20:30',
      place: { name: 'Sample Venue' },
    })
  })
})
