const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

export function addHoursToTime(time: string, hours: number): string {
  if (!TIME_PATTERN.test(time)) return ''
  const [hour, minute] = time.split(':').map(Number)
  const minutesPerDay = 24 * 60
  const totalMinutes = ((hour * 60 + minute + hours * 60) % minutesPerDay + minutesPerDay) % minutesPerDay
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`
}
