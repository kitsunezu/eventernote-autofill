import type { EventData } from './types.js'

export const EVENTERNOTE_CANDIDATE_SEARCH_WARNING =
  'Eventernote 候選搜尋暫時失敗，請稍後重試或手動確認使用現有項目或建立新項目'

export function hasUnresolvedEventernoteEntitySelection(data: EventData): boolean {
  if (data.place.name && !data.place.selectedId && !data.place.createNew) return true
  return data.actors.some((actor) => actor.name && !actor.selectedId && !actor.createNew)
}

export function eventernoteCandidateSearchWarnings(data: EventData, searchFailed: boolean): string[] {
  return searchFailed && hasUnresolvedEventernoteEntitySelection(data)
    ? [EVENTERNOTE_CANDIDATE_SEARCH_WARNING]
    : []
}
