import { getDb, type Task, type CalendarEvent } from './db'

const WORK_START_HOUR = 9
const WORK_END_HOUR = 18

function toMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

export function runAutoScheduler(): { scheduled: number } {
  const db = getDb()

  const tasks = db.prepare(`
    SELECT * FROM tasks WHERE status != 'done' AND scheduled_start IS NULL
    ORDER BY
      CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      due_date ASC NULLS LAST
  `).all() as Task[]

  const events = db.prepare('SELECT * FROM events').all() as CalendarEvent[]
  const scheduledTasks = db.prepare(`
    SELECT * FROM tasks WHERE scheduled_start IS NOT NULL AND status != 'done'
  `).all() as Task[]

  // Build busy slots per day
  type Slot = { start: number; end: number }
  const busyByDay: Map<string, Slot[]> = new Map()

  const addBusy = (dayStr: string, startMin: number, endMin: number) => {
    if (!busyByDay.has(dayStr)) busyByDay.set(dayStr, [])
    busyByDay.get(dayStr)!.push({ start: startMin, end: endMin })
  }

  for (const ev of events) {
    const s = new Date(ev.start_time)
    const e = new Date(ev.end_time)
    const dayStr = s.toISOString().split('T')[0]
    addBusy(dayStr, toMinutes(s), toMinutes(e))
  }

  for (const t of scheduledTasks) {
    if (!t.scheduled_start) continue
    const s = new Date(t.scheduled_start)
    const e = new Date(t.scheduled_end!)
    const dayStr = s.toISOString().split('T')[0]
    addBusy(dayStr, toMinutes(s), toMinutes(e))
  }

  const update = db.prepare(`
    UPDATE tasks SET scheduled_start = ?, scheduled_end = ? WHERE id = ?
  `)

  let scheduled = 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (const task of tasks) {
    let placed = false

    for (let dayOffset = 0; dayOffset <= 14 && !placed; dayOffset++) {
      const day = new Date(today)
      day.setDate(day.getDate() + dayOffset)

      // Skip weekends
      if (day.getDay() === 0 || day.getDay() === 6) continue

      const dayStr = day.toISOString().split('T')[0]
      const busy = (busyByDay.get(dayStr) || []).sort((a, b) => a.start - b.start)

      // Try to place in free slots
      let cursor = WORK_START_HOUR * 60

      // If today, start from now + 15min buffer
      if (dayOffset === 0) {
        const now = new Date()
        cursor = Math.max(cursor, toMinutes(now) + 15)
      }

      const endOfDay = WORK_END_HOUR * 60

      while (cursor + task.duration_minutes <= endOfDay && !placed) {
        const slotEnd = cursor + task.duration_minutes

        const conflict = busy.find(b => b.start < slotEnd && b.end > cursor)

        if (!conflict) {
          const startDate = new Date(day)
          startDate.setHours(Math.floor(cursor / 60), cursor % 60, 0, 0)
          const endDate = new Date(day)
          endDate.setHours(Math.floor(slotEnd / 60), slotEnd % 60, 0, 0)

          update.run(startDate.toISOString(), endDate.toISOString(), task.id)
          addBusy(dayStr, cursor, slotEnd)
          scheduled++
          placed = true
        } else {
          cursor = conflict.end
        }
      }
    }
  }

  return { scheduled }
}
