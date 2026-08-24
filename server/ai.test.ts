import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventData } from '../shared/types.js'
import { enrichWithAi, extractEventsWithAi, resolveEventernoteEntities, titleWithTourVenue } from './ai.js'

const scalar = (value = '', confidence: 'high' | 'medium' | 'low' = 'low') => ({ value, confidence })

function aiResult() {
  return {
    title: scalar(),
    date: scalar(),
    openTime: scalar(),
    startTime: scalar(),
    endTime: scalar(),
    officialUrl: scalar(),
    imageUrl: scalar(),
    placeName: scalar(),
    placeAddress: scalar(),
    countryCode: scalar(),
    actors: { value: [] as string[], confidence: 'low' as const },
  }
}

function currentEvent(): EventData {
  return {
    title: 'Parser title',
    date: '2026-08-20',
    openTime: '',
    startTime: '',
    endTime: '',
    description: '',
    officialUrl: '',
    imageUrl: '',
    descriptionLanguage: 'zh-Hant',
    place: {
      name: 'Parser venue',
      address: '',
      countryCode: 'HK',
      selectedId: '123',
      createNew: false,
      candidates: [{ id: '123', name: 'Parser venue', url: '/places/123', similarity: 1 }],
    },
    actors: [{
      name: 'Existing Artist', reading: '', searchKeywords: '', sex: '', selectedId: '456', createNew: false,
      candidates: [{ id: '456', name: 'Existing Artist', url: '/actors/456', similarity: 1 }],
    }],
  }
}

function stubJsonResponse(result: unknown) {
  const completedResult = result && typeof result === 'object' && 'decisions' in result
    ? {
        ...result,
        decisions: (result as { decisions: Array<Record<string, unknown>> }).decisions.map((decision) => ({
          searchKeywords: '', sex: '', ...decision,
        })),
      }
    : result
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(completedResult) }] }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stubResponse(result: ReturnType<typeof aiResult>) {
  return stubJsonResponse({ events: [result] })
}

afterEach(() => vi.unstubAllGlobals())

describe('enrichWithAi', () => {
  it('uses structured output and only lets high confidence correct parsed values', async () => {
    const result = aiResult()
    result.title = scalar('Verified title', 'high')
    result.date = scalar('2026-08-21', 'medium')
    result.startTime = scalar('19:30', 'medium')
    result.placeName = scalar('Verified venue', 'high')
    result.countryCode = scalar('JP', 'high')
    result.actors = { value: ['Existing Artist', 'New Artist'], confidence: 'high' }
    const fetchMock = stubResponse(result)

    const enriched = await enrichWithAi(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://example.com/event', 'event page', currentEvent(),
    )

    expect(enriched.data.title).toBe('Verified title')
    expect(enriched.data.date).toBe('2026-08-20')
    expect(enriched.data.startTime).toBe('19:30')
    expect(enriched.data.place).toMatchObject({ name: 'Verified venue', countryCode: 'JP', selectedId: '' })
    expect(enriched.data.descriptionLanguage).toBe('ja')
    expect(enriched.data.actors[0].selectedId).toBe('456')
    expect(enriched.data.actors[1].name).toBe('New Artist')
    expect(enriched.evidence.title?.source).toContain('核實修正')

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(fetchMock.mock.calls[0][0].toString()).toBe('https://api.openai.com/v1/responses')
    const body = JSON.parse(String(request.body))
    expect(body).toMatchObject({
      model: 'gpt-5.6-luna',
      store: false,
      reasoning: { effort: 'medium' },
      tools: [{ type: 'web_search' }],
      text: { format: { type: 'json_schema', strict: true } },
    })
    expect(body.input[0].role).toBe('system')
    expect(JSON.stringify(body)).not.toContain('test-api-key')
  })

  it('fills missing values at medium confidence and ignores low-confidence guesses', async () => {
    const result = aiResult()
    result.openTime = scalar('18:30', 'medium')
    result.placeAddress = scalar('Tokyo, Japan', 'medium')
    const fetchMock = stubResponse(result)
    const current = currentEvent()

    const enriched = await enrichWithAi(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://example.com/event', 'event page', current,
    )

    expect(enriched.data.openTime).toBe('18:30')
    expect(enriched.data.place.address).toBe('Tokyo, Japan')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('never fills a missing description with AI-generated content', async () => {
    const result = { ...aiResult(), description: scalar('AI-generated summary', 'high') }
    const fetchMock = stubJsonResponse({ events: [result] })

    const enriched = await enrichWithAi(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://example.com/event', 'event page without a description', currentEvent(),
    )

    expect(enriched.data.description).toBe('')
    expect(enriched.evidence.description).toBeUndefined()

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.text.format.schema.properties.events.items.properties).not.toHaveProperty('description')
    expect(body.text.format.schema.properties.events.items.required).not.toContain('description')
  })

  it('preserves a description extracted directly from the source page', async () => {
    stubResponse(aiResult())
    const current = currentEvent()
    current.description = 'Direct page description'

    const enriched = await enrichWithAi(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://example.com/event', current.description, current,
    )

    expect(enriched.data.description).toBe('Direct page description')
    expect(enriched.evidence.description).toBeUndefined()
  })

  it('surfaces the API error code without exposing the API key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'invalid_api_key' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })))

    await expect(enrichWithAi(
      'secret-value', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://example.com/event', 'event page', currentEvent(),
    )).rejects.toThrow('OpenAI 核對失敗 (HTTP 401，invalid_api_key)')
  })

  it('retries one transient network failure', async () => {
    const result = aiResult()
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ events: [result] }) }] }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(enrichWithAi(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://example.com/event', 'event page', currentEvent(),
    )).resolves.toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns every separately scheduled session', async () => {
    const day = aiResult()
    day.title = scalar('Sample Live 日場', 'high')
    day.startTime = scalar('14:30', 'high')
    const night = aiResult()
    night.title = scalar('Sample Live 夜場', 'high')
    night.startTime = scalar('19:00', 'high')
    stubJsonResponse({ events: [day, night] })
    const onResponse = vi.fn()

    const events = await extractEventsWithAi(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://example.com/event', 'day 14:30 night 19:00', currentEvent(),
      onResponse,
    )

    expect(events.map((event) => event.data.startTime)).toEqual(['14:30', '19:00'])
    expect(onResponse).toHaveBeenCalledWith({ events: [day, night] })
  })

  it('accepts a complete 47-stop tour and appends each venue to the title', async () => {
    const tourStops = Array.from({ length: 47 }, (_, index) => ({
      date: '2026-10-22', openTime: '', startTime: '', endTime: '',
      placeName: `Venue ${index + 1}`, placeAddress: '',
    }))
    const fetchMock = stubJsonResponse({
      tourTitle: 'SCANDAL FINAL TOUR 2026-2027 「SCANDALの47都道府県ツアー」',
      countryCode: 'JP',
      actors: ['SCANDAL'],
      stops: tourStops,
    })

    const events = await extractEventsWithAi(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://x.com/scandal_band/status/2091828361530118640', '47-stop tour poster', currentEvent(),
    )

    expect(events).toHaveLength(47)
    expect(events[0].data.title).toBe('SCANDAL FINAL TOUR 2026-2027 「SCANDALの47都道府県ツアー」 — Venue 1')
    expect(events[46].data.title).toBe('SCANDAL FINAL TOUR 2026-2027 「SCANDALの47都道府県ツアー」 — Venue 47')
    expect(events[0].data.startTime).toBe('')
    expect(events[0].data.actors[0].name).toBe('SCANDAL')
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.text.format.schema.properties.stops.maxItems).toBe(64)
    expect(body.text.format.name).toBe('eventernote_tour_stops')
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect(body.input[0].content).toContain('every explicitly dated venue row')
  })

  it('does not duplicate a tour venue already present in the title', () => {
    expect(titleWithTourVenue('Sample TOUR — Zepp Osaka Bayside', 'Zepp Osaka Bayside'))
      .toBe('Sample TOUR — Zepp Osaka Bayside')
    expect(titleWithTourVenue('One-off Live', 'Example Hall')).toBe('One-off Live')
  })

  it('fills an end time that the source explicitly labels', async () => {
    const result = aiResult()
    result.endTime = scalar('20:30', 'high')
    const fetchMock = stubResponse(result)

    const enriched = await enrichWithAi(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://example.com/event', 'OPEN / START 12:00 / CLOSE 20:30', currentEvent(),
    )

    expect(enriched.data.endTime).toBe('20:30')
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.input[0].content).toContain('actual event end time only')
  })

  it('sends validated event images as original-detail vision inputs', async () => {
    const fetchMock = stubResponse(aiResult())

    await extractEventsWithAi(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna',
      'https://x.com/example/status/1', 'event post', currentEvent(), undefined,
      [{ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' }],
    )

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.input[1].content).toEqual([
      expect.objectContaining({ type: 'input_text' }),
      {
        type: 'input_image',
        image_url: 'data:image/jpeg;base64,/9j/',
        detail: 'original',
      },
    ])
  })
})

describe('resolveEventernoteEntities', () => {
  it('automatically selects existing candidates and marks unmatched entities for creation', async () => {
    const current = currentEvent()
    current.place.selectedId = ''
    current.place.candidates = [
      { id: '10', name: 'Verified Hall', url: 'https://www.eventernote.com/places/example/10', similarity: 0.85 },
      { id: '11', name: 'Different Hall', url: 'https://www.eventernote.com/places/example/11', similarity: 0.5 },
    ]
    current.actors[0].selectedId = ''
    current.actors[0].candidates = [
      { id: '20', name: 'Existing Artist', url: 'https://www.eventernote.com/actors/example/20', similarity: 1 },
    ]
    current.actors.push({
      name: 'Brand New Artist', reading: '', searchKeywords: '', sex: '', selectedId: '', createNew: false, candidates: [],
    })
    const fetchMock = stubJsonResponse({ decisions: [
      { key: 'place', action: 'existing', candidateId: '10', reading: '', confidence: 'high', reason: 'Name and Tokyo venue context match.' },
      { key: 'actor:0', action: 'existing', candidateId: '20', reading: '', confidence: 'high', reason: 'Exact performer identity.' },
      { key: 'actor:1', action: 'new', candidateId: '', reading: 'ブランド ニュー アーティスト', searchKeywords: 'Brand New Artist, BNA', sex: '3', confidence: 'medium', reason: 'No Eventernote candidate represents this artist.' },
    ] })

    const resolved = await resolveEventernoteEntities(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna', 'https://example.com/event', current,
    )

    expect(resolved.data.place).toMatchObject({ selectedId: '10', createNew: false })
    expect(resolved.data.actors[0]).toMatchObject({ selectedId: '20', createNew: false })
    expect(resolved.data.actors[1]).toMatchObject({
      selectedId: '', createNew: true, reading: 'ぶらんどにゅーあーてぃすと', searchKeywords: 'Brand New Artist,BNA', sex: '3',
    })
    expect(resolved.evidence['place.selection']?.value).toBe('使用現有：Verified Hall')
    expect(resolved.evidence['actors.1.selection']?.value).toBe('建立新出演者：Brand New Artist')

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'eventernote_entity_resolution', strict: true })
    const input = JSON.parse(body.input[1].content)
    expect(input.entities).toHaveLength(3)
    expect(input.entities[0].candidates[0].id).toBe('10')
  })

  it('requires review before using a medium-confidence existing candidate', async () => {
    const current = currentEvent()
    current.place.selectedId = ''
    current.place.candidates = [
      { id: '10', name: 'Possible Hall', url: 'https://www.eventernote.com/places/example/10', similarity: 0.85 },
    ]
    stubJsonResponse({ decisions: [
      { key: 'place', action: 'existing', candidateId: '10', reading: '', confidence: 'medium', reason: 'Context is similar but identity is not direct.' },
    ] })

    const resolved = await resolveEventernoteEntities(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna', 'https://example.com/event', current,
    )

    expect(resolved.data.place).toMatchObject({ selectedId: '', createNew: false })
    expect(resolved.evidence['place.selection']).toMatchObject({ value: '需確認', confidence: 'missing' })
  })

  it('requires review for low-confidence decisions or candidate ids outside the matching entity', async () => {
    const current = currentEvent()
    current.place.selectedId = ''
    current.place.candidates = [
      { id: '10', name: 'Verified Hall', url: 'https://www.eventernote.com/places/example/10', similarity: 0.85 },
    ]
    current.actors[0].selectedId = ''
    current.actors[0].candidates = []
    stubJsonResponse({ decisions: [
      { key: 'place', action: 'existing', candidateId: '999', reading: '', confidence: 'high', reason: 'Invalid choice.' },
      { key: 'actor:0', action: 'new', candidateId: '', reading: '', confidence: 'low', reason: 'Identity remains uncertain.' },
    ] })

    const resolved = await resolveEventernoteEntities(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna', 'https://example.com/event', current,
    )

    expect(resolved.data.place).toMatchObject({ selectedId: '', createNew: false })
    expect(resolved.data.actors[0]).toMatchObject({ selectedId: '', createNew: false })
    expect(resolved.evidence['place.selection']?.confidence).toBe('missing')
    expect(resolved.evidence['actors.0.selection']?.confidence).toBe('missing')
  })

  it('preserves an explicit create-new choice and fills its reading', async () => {
    const current = currentEvent()
    current.actors[0] = {
      ...current.actors[0],
      reading: '',
      selectedId: '',
      createNew: true,
    }
    const fetchMock = stubJsonResponse({ decisions: [
      { key: 'actor:0', action: 'new', candidateId: '', reading: 'エグジスティング アーティスト', searchKeywords: 'Existing Artist', sex: '2', confidence: 'medium', reason: 'User requested a new performer.' },
    ] })

    const resolved = await resolveEventernoteEntities(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna', 'https://example.com/event', current,
    )

    expect(resolved.data.actors[0]).toMatchObject({
      selectedId: '', createNew: true, reading: 'えぐじすてぃんぐあーてぃすと', searchKeywords: 'Existing Artist', sex: '2',
    })
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    const input = JSON.parse(body.input[1].content)
    expect(input.entities[0]).toMatchObject({ key: 'actor:0', forceCreateNew: true })
    expect(body.text.format.schema.properties.decisions.items.required).toEqual(expect.arrayContaining([
      'reading', 'searchKeywords', 'sex',
    ]))
  })

  it('keeps an explicit new actor for automatic submission retry when AI metadata is incomplete', async () => {
    const current = currentEvent()
    current.actors[0] = {
      ...current.actors[0],
      reading: '',
      searchKeywords: '',
      sex: '',
      selectedId: '',
      createNew: true,
    }
    stubJsonResponse({ decisions: [
      { key: 'actor:0', action: 'new', candidateId: '', reading: 'not-hiragana', confidence: 'medium', reason: 'Metadata is incomplete.' },
    ] })

    const resolved = await resolveEventernoteEntities(
      'test-api-key', 'https://api.openai.com/v1', 'gpt-5.6-luna', 'https://example.com/event', current,
    )

    expect(resolved.data.actors[0]).toMatchObject({
      selectedId: '', createNew: true, reading: '', searchKeywords: '', sex: '',
    })
    expect(resolved.evidence['actors.0.selection']).toMatchObject({
      value: 'AI 資料不完整', confidence: 'missing',
    })
  })
})
