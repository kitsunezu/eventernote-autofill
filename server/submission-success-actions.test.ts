import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SubmissionSuccessActions } from '../src/SubmissionSuccessActions.js'

describe('SubmissionSuccessActions', () => {
  it('offers landing-page and Eventernote actions after completion', () => {
    const markup = renderToStaticMarkup(createElement(SubmissionSuccessActions, {
      eventUrl: 'https://www.eventernote.com/events/12345',
      onBackToLanding: vi.fn(),
    }))

    expect(markup).toContain('回到首頁')
    expect(markup).toContain('開啟 Eventernote 活動頁')
    expect(markup).toContain('href="https://www.eventernote.com/events/12345"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noreferrer"')
  })

  it.each([
    ['ja', 'ホームに戻る', 'Eventernote のイベントページを開く'],
    ['en', 'Back to home', 'Open Eventernote event page'],
  ] as const)('renders %s actions', (locale, backLabel, eventLabel) => {
    const markup = renderToStaticMarkup(createElement(SubmissionSuccessActions, {
      eventUrl: 'https://www.eventernote.com/events/12345',
      onBackToLanding: vi.fn(),
      locale,
    }))

    expect(markup).toContain(backLabel)
    expect(markup).toContain(eventLabel)
  })
})
