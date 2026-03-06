"use client"

import { useEffect, useState } from "react"
import { format } from "date-fns"
import { fr } from "date-fns/locale"
import { Plus, Trash2, CheckCircle2, Circle, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type Task = {
  id: number
  title: string
  priority: "high" | "medium" | "low"
  duration_minutes: number
  due_date: string | null
  status: "todo" | "in-progress" | "done"
  project_id: number | null
  project_name: string | null
  project_color: string | null
  scheduled_start: string | null
}

type Project = {
  id: number
  name: string
  color: string
}

const PRIORITY_LABEL: Record<string, string> = { high: "Urgent", medium: "Moyen", low: "Faible" }
const PRIORITY_COLOR: Record<string, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-blue-100 text-blue-700",
}
const STATUS_LABEL: Record<string, string> = { todo: "À faire", "in-progress": "En cours", done: "Terminé" }

const defaultForm = {
  title: "",
  priority: "medium",
  duration_minutes: 30,
  due_date: "",
  status: "todo",
  project_id: "",
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [filter, setFilter] = useState<"all" | "todo" | "in-progress" | "done">("all")
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(defaultForm)

  const load = () => {
    fetch("/api/tasks").then(r => r.json()).then(setTasks)
    fetch("/api/projects").then(r => r.json()).then(setProjects)
  }

  useEffect(() => { load() }, [])

  const filtered = filter === "all" ? tasks : tasks.filter(t => t.status === filter)

  const handleAdd = async () => {
    if (!form.title.trim()) return
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        duration_minutes: Number(form.duration_minutes),
        project_id: form.project_id ? Number(form.project_id) : null,
        due_date: form.due_date || null,
      }),
    })
    setShowAdd(false)
    setForm(defaultForm)
    load()
  }

  const handleStatus = async (task: Task, next: string) => {
    await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    })
    load()
  }

  const handleDelete = async (id: number) => {
    await fetch(`/api/tasks/${id}`, { method: "DELETE" })
    load()
  }

  const nextStatus = (s: string) => s === "todo" ? "in-progress" : s === "in-progress" ? "done" : "todo"

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Tâches</h1>
        <Button onClick={() => setShowAdd(true)} className="bg-indigo-500 hover:bg-indigo-600 text-white gap-2">
          <Plus className="w-4 h-4" /> Nouvelle tâche
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-6">
        {(["all", "todo", "in-progress", "done"] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
              filter === s
                ? "bg-indigo-500 text-white"
                : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            {s === "all" ? "Toutes" : STATUS_LABEL[s]}
            <span className="ml-1.5 text-xs opacity-70">
              {s === "all" ? tasks.length : tasks.filter(t => t.status === s).length}
            </span>
          </button>
        ))}
      </div>

      {/* Task list */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <CheckCircle2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p>Aucune tâche</p>
          </div>
        )}
        {filtered.map(task => (
          <div
            key={task.id}
            className={`flex items-start gap-3 p-4 bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow ${
              task.status === "done" ? "opacity-60" : ""
            }`}
          >
            <button
              onClick={() => handleStatus(task, nextStatus(task.status))}
              className="mt-0.5 shrink-0"
            >
              {task.status === "done" ? (
                <CheckCircle2 className="w-5 h-5 text-green-500" />
              ) : task.status === "in-progress" ? (
                <Clock className="w-5 h-5 text-indigo-500" />
              ) : (
                <Circle className="w-5 h-5 text-gray-300 hover:text-gray-400" />
              )}
            </button>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`font-medium text-gray-900 ${task.status === "done" ? "line-through" : ""}`}>
                  {task.title}
                </span>
                <Badge className={`text-xs ${PRIORITY_COLOR[task.priority]}`} variant="secondary">
                  {PRIORITY_LABEL[task.priority]}
                </Badge>
                {task.project_name && (
                  <span
                    className="text-xs px-2 py-0.5 rounded-full text-white font-medium"
                    style={{ backgroundColor: task.project_color || "#6366f1" }}
                  >
                    {task.project_name}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                <span>{task.duration_minutes}min</span>
                {task.due_date && (
                  <span>Échéance {format(new Date(task.due_date + "T00:00:00"), "d MMM", { locale: fr })}</span>
                )}
                {task.scheduled_start && (
                  <span className="text-indigo-400">
                    Planifiée {format(new Date(task.scheduled_start), "d MMM HH:mm", { locale: fr })}
                  </span>
                )}
              </div>
            </div>

            <button
              onClick={() => handleDelete(task.id)}
              className="shrink-0 text-gray-300 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Add task dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nouvelle tâche</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label>Titre</Label>
              <Input
                className="mt-1"
                placeholder="Nom de la tâche..."
                value={form.title}
                onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                onKeyDown={e => e.key === "Enter" && handleAdd()}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Priorité</Label>
                <Select value={form.priority} onValueChange={v => setForm(p => ({ ...p, priority: v }))}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high">Urgent</SelectItem>
                    <SelectItem value="medium">Moyen</SelectItem>
                    <SelectItem value="low">Faible</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Durée (min)</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min={5}
                  step={5}
                  value={form.duration_minutes}
                  onChange={e => setForm(p => ({ ...p, duration_minutes: Number(e.target.value) }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Projet</Label>
                <Select value={form.project_id} onValueChange={v => setForm(p => ({ ...p, project_id: v }))}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Aucun" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Aucun</SelectItem>
                    {projects.map(pr => (
                      <SelectItem key={pr.id} value={String(pr.id)}>{pr.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Échéance</Label>
                <Input
                  className="mt-1"
                  type="date"
                  value={form.due_date}
                  onChange={e => setForm(p => ({ ...p, due_date: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => { setShowAdd(false); setForm(defaultForm) }}>Annuler</Button>
              <Button onClick={handleAdd} className="bg-indigo-500 hover:bg-indigo-600 text-white">Créer</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
