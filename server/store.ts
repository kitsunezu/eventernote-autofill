import type { Draft } from '../shared/types.js'

export class DraftStore {
  private drafts = new Map<string, Draft>()

  list(): Draft[] {
    return [...this.drafts.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): Draft | undefined {
    return this.drafts.get(id)
  }

  async save(draft: Draft): Promise<Draft> {
    this.drafts.set(draft.id, structuredClone(draft))
    return draft
  }

  async replace(draft: Draft): Promise<Draft> {
    this.drafts.clear()
    return this.save(draft)
  }

  async replaceAll(drafts: Draft[]): Promise<Draft[]> {
    this.drafts.clear()
    for (const draft of drafts) await this.save(draft)
    return drafts
  }

  async remove(id: string): Promise<boolean> {
    return this.drafts.delete(id)
  }
}
