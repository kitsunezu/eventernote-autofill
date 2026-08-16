export function removeActorConfirmation(
  confirmations: string[],
  eventId: string,
  removedIndex: number,
): string[] {
  const actorPrefix = `${eventId}:actor:`

  return confirmations.flatMap((confirmation) => {
    if (!confirmation.startsWith(actorPrefix)) return [confirmation]

    const actorIndex = Number(confirmation.slice(actorPrefix.length))
    if (!Number.isInteger(actorIndex)) return [confirmation]
    if (actorIndex === removedIndex) return []
    if (actorIndex < removedIndex) return [confirmation]
    return [`${actorPrefix}${actorIndex - 1}`]
  })
}

export function actorSearchTargetsForEditing<T extends { index: number }>(
  targets: T[],
  eventId: string,
  editingEntity: string,
): T[] {
  const actorPrefix = `${eventId}:actor:`
  if (!editingEntity.startsWith(actorPrefix)) return targets
  return targets.filter(({ index }) => editingEntity === `${actorPrefix}${index}`)
}
