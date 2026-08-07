import type { Draft } from '../shared/types.js'

export async function syncDashboard(
  url: string,
  token: string,
  userId: string,
  draft: Draft,
): Promise<void> {
  if (!draft.submittedEventId) throw new Error('Eventernote 活動 ID 尚未產生')
  const response = await fetch(new URL('/api/internal/events/import', url), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      event: {
        id: draft.submittedEventId,
        title: draft.data.title,
        date: draft.data.date,
        openTime: draft.data.openTime,
        startTime: draft.data.startTime,
        endTime: draft.data.endTime,
        description: draft.data.description,
        officialUrl: draft.submittedEventUrl ?? draft.data.officialUrl,
        imageUrl: draft.data.imageUrl,
        venue: draft.data.place.name,
        placeId: draft.data.place.selectedId,
        placeAddress: draft.data.place.address,
        actors: draft.data.actors.map((actor) => actor.name),
      },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error ?? `Dashboard 同步失敗 (HTTP ${response.status})`)
  }
}
