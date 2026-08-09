import { describe, expect, it } from 'vitest'
import { detectLocale, getMessages, interpolate, localeOptions } from '../src/i18n'

describe('interface localization', () => {
  it('detects the supported browser languages and falls back to Traditional Chinese', () => {
    expect(detectLocale('ja-JP')).toBe('ja')
    expect(detectLocale('en-US')).toBe('en')
    expect(detectLocale('zh-TW')).toBe('zh-TW')
    expect(detectLocale('fr-FR')).toBe('zh-TW')
  })

  it('provides a complete message set for every language', () => {
    const referenceKeys = Object.keys(getMessages('zh-TW')).sort()
    for (const { value } of localeOptions) {
      expect(Object.keys(getMessages(value)).sort()).toEqual(referenceKeys)
      expect(Object.values(getMessages(value)).every(Boolean)).toBe(true)
    }
  })

  it('interpolates dynamic interface values', () => {
    expect(interpolate(getMessages('en').sessionRemoved, { title: 'Live' })).toBe('Removed session “Live”.')
    expect(interpolate(getMessages('ja').aiNotes, { count: 3 })).toBe('AI の注意事項（3）')
  })
})
