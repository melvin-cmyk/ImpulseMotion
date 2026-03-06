"use client"

import { useEffect, useState, useRef } from "react"
import { format, addDays, startOfWeek, isSameDay, parseISO } from "date-fns"
import { fr } from "date-fns/locale"
import { ChevronLeft, ChevronRight, Plus, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type CalEvent = {
  id: number
  title: string
  start_time: string
  end_time: string
  color: string
  all_day: number
}

type Task = {
  id: number
  title: string
  priority: string
  duration_minutes: number
  scheduled_start: string | null
  scheduled_end: string | null
  project_color: string | null
  status: string
}

const HOURS = Array.from({ length: 13 }, (_, i) => i + 8) // 8h to 20h
const HOUR_HEIGHT = 64 // px per hour

function eventTop(startTime: string, dayDate: Date): number {
  const d = parseISO(startTime)
  if (!isSameDay(d, dayDate)) return -9999
  const mins = d.getHours() * 60 + d.getMinutes() - 8 * 60
  return (mins / 60) * HOUR_HEIGHT
}

function eventHeight(startTime: string, endTime: string): number {
  const s = parseISO(startTime)
  const e = parseISO(endTime)
  const mins = (e.getTime() - s.getTime()) / 60000
  return Math.max((mins / 60) * HOUR_HEIGHT, 20)
}

export default function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }))
  const [events, setEvents] = useState<CalEvent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [scheduling, setScheduling] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [newEvent, setNewEvent] = useState({ title: "", start_time: "", end_time: "", color: "#6366f1" })
  const scrollRef = useRef<HTMLDivElement>(null)

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  const loadData = () => {
    const from = weekStart.toISOString()
    const to = addDays(weekStart, 7).toISOString()
    fetch(`/api/events?from=${from}&to=${to}`).then(r => r.json()).then(setEvents)
    fetch("/api/tasks").then(r => r.json()).then(setTasks)
  }

  useEffect(() => {
    loadData()
    // Scroll to 8am
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart])

  const handleSchedule = async () => {
    setScheduling(true)
    await fetch("/api/schedule", { method: "POST" })
    loadData()
    setScheduling(false)
  }

  const handleAddEvent = async () => {
    if (!newEvent.title || !newEvent.start_time || !newEvent.end_time) return
    await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newEvent),
    })
    setShowAdd(false)
    setNewEvent({ title: "", start_time: "", end_time: "", color: "#6366f1" })
    loadData()
  }

  const scheduledTasks = tasks.filter(t => t.scheduled_start)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setWeekStart(d => addDays(d, -7))}
            className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-50"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h2 className="text-base font-semibold text-gray-900">
            {format(weekStart, "d MMM", { locale: fr })} – {format(addDays(weekStart, 6), "d MMM yyyy", { locale: fr })}
          </h2>
          <button
            onClick={() => setWeekStart(d => addDays(d, 7))}
            className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-50"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}
            className="px-3 py-1 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            Aujourd&apos;hui
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAdd(true)}
            className="gap-1"
          >
            <Plus className="w-4 h-4" /> Événement
          </Button>
          <Button
            size="sm"
            onClick={handleSchedule}
            disabled={scheduling}
            className="bg-indigo-500 hover:bg-indigo-600 text-white gap-1"
          >
            <Zap className="w-4 h-4" />
            {scheduling ? "..." : "Auto-planifier"}
          </Button>
        </div>
      </div>

      {/* Day headers */}
      <div className="flex border-b border-gray-100 bg-white shrink-0">
        <div className="w-14 shrink-0" />
        {weekDays.map(day => {
          const isToday = isSameDay(day, new Date())
          return (
            <div key={day.toISOString()} className="flex-1 text-center py-2">
              <div className="text-xs text-gray-400 uppercase">{format(day, "EEE", { locale: fr })}</div>
              <div className={`text-sm font-semibold mt-0.5 w-7 h-7 rounded-full flex items-center justify-center mx-auto ${
                isToday ? "bg-indigo-500 text-white" : "text-gray-900"
              }`}>
                {format(day, "d")}
              </div>
            </div>
          )
        })}
      </div>

      {/* Time grid */}
      <div className="flex-1 overflow-auto" ref={scrollRef}>
        <div className="flex">
          {/* Time labels */}
          <div className="w-14 shrink-0">
            {HOURS.map(h => (
              <div key={h} className="relative" style={{ height: HOUR_HEIGHT }}>
                <span className="absolute -top-2.5 right-2 text-xs text-gray-400">{h}:00</span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          {weekDays.map(day => {
            const dayEvents = events.filter(ev => isSameDay(parseISO(ev.start_time), day))
            const dayTasks = scheduledTasks.filter(t => t.scheduled_start && isSameDay(parseISO(t.scheduled_start), day))

            return (
              <div
                key={day.toISOString()}
                className="flex-1 relative border-l border-gray-100"
                style={{ height: HOURS.length * HOUR_HEIGHT }}
              >
                {/* Hour lines */}
                {HOURS.map(h => (
                  <div
                    key={h}
                    className="absolute w-full border-t border-gray-100"
                    style={{ top: (h - 8) * HOUR_HEIGHT }}
                  />
                ))}

                {/* Calendar events */}
                {dayEvents.map(ev => (
                  <div
                    key={`ev-${ev.id}`}
                    className="absolute left-1 right-1 rounded-md px-2 py-1 overflow-hidden text-white text-xs font-medium shadow-sm"
                    style={{
                      top: eventTop(ev.start_time, day),
                      height: eventHeight(ev.start_time, ev.end_time),
                      backgroundColor: ev.color,
                      minHeight: 20,
                    }}
                  >
                    <div className="truncate">{ev.title}</div>
                    <div className="opacity-80 text-[10px]">
                      {format(parseISO(ev.start_time), "HH:mm")} – {format(parseISO(ev.end_time), "HH:mm")}
                    </div>
                  </div>
                ))}

                {/* Scheduled tasks */}
                {dayTasks.map(t => (
                  <div
                    key={`t-${t.id}`}
                    className="absolute left-1 right-1 rounded-md px-2 py-1 overflow-hidden text-xs font-medium shadow-sm border-l-2 border-indigo-400 bg-indigo-50 text-indigo-900"
                    style={{
                      top: eventTop(t.scheduled_start!, day),
                      height: eventHeight(t.scheduled_start!, t.scheduled_end!),
                      minHeight: 20,
                    }}
                  >
                    <div className="truncate">{t.title}</div>
                    <div className="opacity-70 text-[10px]">{t.duration_minutes}min</div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      {/* Add event dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nouvel événement</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label>Titre</Label>
              <Input
                className="mt-1"
                placeholder="Réunion client..."
                value={newEvent.title}
                onChange={e => setNewEvent(p => ({ ...p, title: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Début</Label>
                <Input
                  className="mt-1"
                  type="datetime-local"
                  value={newEvent.start_time}
                  onChange={e => setNewEvent(p => ({ ...p, start_time: e.target.value }))}
                />
              </div>
              <div>
                <Label>Fin</Label>
                <Input
                  className="mt-1"
                  type="datetime-local"
                  value={newEvent.end_time}
                  onChange={e => setNewEvent(p => ({ ...p, end_time: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Couleur</Label>
              <Input
                className="mt-1 h-10 w-16 p-1 cursor-pointer"
                type="color"
                value={newEvent.color}
                onChange={e => setNewEvent(p => ({ ...p, color: e.target.value }))}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setShowAdd(false)}>Annuler</Button>
              <Button onClick={handleAddEvent} className="bg-indigo-500 hover:bg-indigo-600 text-white">Créer</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
