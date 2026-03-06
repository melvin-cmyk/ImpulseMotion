"use client"

import { useEffect, useState } from "react"
import { format } from "date-fns"
import { CheckSquare, Clock, FolderOpen, Zap, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

type Task = {
  id: number
  title: string
  priority: "high" | "medium" | "low"
  duration_minutes: number
  due_date: string | null
  status: string
  project_name: string | null
  project_color: string | null
  scheduled_start: string | null
  scheduled_end: string | null
}

type CalEvent = {
  id: number
  title: string
  start_time: string
  end_time: string
  color: string
}

const priorityColor: Record<string, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-blue-100 text-blue-700",
}

export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [events, setEvents] = useState<CalEvent[]>([])
  const [scheduling, setScheduling] = useState(false)
  const [scheduleResult, setScheduleResult] = useState<string | null>(null)

  const loadData = () => {
    fetch("/api/tasks").then(r => r.json()).then(setTasks)
    const today = new Date()
    const from = new Date(today); from.setHours(0, 0, 0, 0)
    const to = new Date(today); to.setHours(23, 59, 59, 999)
    fetch(`/api/events?from=${from.toISOString()}&to=${to.toISOString()}`).then(r => r.json()).then(setEvents)
  }

  useEffect(() => { loadData() }, [])

  const todoTasks = tasks.filter(t => t.status === "todo")
  const inProgressTasks = tasks.filter(t => t.status === "in-progress")
  const doneTasks = tasks.filter(t => t.status === "done")
  const scheduledToday = tasks.filter(t => {
    if (!t.scheduled_start) return false
    const d = new Date(t.scheduled_start)
    const today = new Date()
    return d.getDate() === today.getDate() && d.getMonth() === today.getMonth()
  })

  const handleSchedule = async () => {
    setScheduling(true)
    setScheduleResult(null)
    const r = await fetch("/api/schedule", { method: "POST" })
    const data = await r.json()
    setScheduleResult(`${data.scheduled} tâche${data.scheduled > 1 ? "s" : ""} planifiée${data.scheduled > 1 ? "s" : ""}`)
    loadData()
    setScheduling(false)
  }

  return (
    <div className="p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
            <p className="text-gray-500 mt-0.5 capitalize">{format(new Date(), "EEEE d MMMM yyyy")}</p>
          </div>
          <Button onClick={handleSchedule} disabled={scheduling} className="bg-indigo-500 hover:bg-indigo-600 text-white gap-2">
            <Zap className="w-4 h-4" />
            {scheduling ? "Planification..." : "Auto-planifier"}
          </Button>
        </div>

        {scheduleResult && (
          <div className="mb-6 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            ✓ {scheduleResult} ajoutées dans votre agenda.
          </div>
        )}

        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: "À faire", value: todoTasks.length, icon: CheckSquare, color: "text-gray-600" },
            { label: "En cours", value: inProgressTasks.length, icon: Play, color: "text-indigo-600" },
            { label: "Terminées", value: doneTasks.length, icon: CheckSquare, color: "text-green-600" },
            { label: "Planifiées auj.", value: scheduledToday.length, icon: Clock, color: "text-orange-600" },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-4 h-4 ${color}`} />
                <span className="text-xs text-gray-500">{label}</span>
              </div>
              <div className="text-3xl font-bold text-gray-900">{value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="p-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-500" />
                Agenda aujourd&apos;hui
              </h2>
            </div>
            <div className="p-4 space-y-2">
              {events.length === 0 && scheduledToday.length === 0 && (
                <p className="text-gray-400 text-sm">Rien de prévu aujourd&apos;hui</p>
              )}
              {events.map(ev => (
                <div key={`ev-${ev.id}`} className="flex items-center gap-3 p-2 rounded-lg bg-gray-50">
                  <div className="w-1 h-8 rounded-full shrink-0" style={{ backgroundColor: ev.color }} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{ev.title}</div>
                    <div className="text-xs text-gray-500">
                      {format(new Date(ev.start_time), "HH:mm")} - {format(new Date(ev.end_time), "HH:mm")}
                    </div>
                  </div>
                </div>
              ))}
              {scheduledToday.map(t => (
                <div key={`t-${t.id}`} className="flex items-center gap-3 p-2 rounded-lg bg-indigo-50">
                  <div className="w-1 h-8 rounded-full shrink-0 bg-indigo-400" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">{t.title}</div>
                    <div className="text-xs text-gray-500">
                      {t.scheduled_start && format(new Date(t.scheduled_start), "HH:mm")}
                      {" · "}{t.duration_minutes}min
                    </div>
                  </div>
                  <Badge className={priorityColor[t.priority]} variant="secondary">
                    {t.priority}
                  </Badge>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="p-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-indigo-500" />
                Tâches prioritaires
              </h2>
            </div>
            <div className="p-4 space-y-2">
              {todoTasks.slice(0, 6).map(t => (
                <div key={t.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: t.priority === "high" ? "#ef4444" : t.priority === "medium" ? "#f59e0b" : "#3b82f6" }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">{t.title}</div>
                    {t.due_date && (
                      <div className="text-xs text-gray-500">Échéance {format(new Date(t.due_date + "T00:00:00"), "d MMM")}</div>
                    )}
                  </div>
                  <div className="text-xs text-gray-400">{t.duration_minutes}min</div>
                </div>
              ))}
              {todoTasks.length === 0 && <p className="text-gray-400 text-sm">Toutes les tâches sont terminées 🎉</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
