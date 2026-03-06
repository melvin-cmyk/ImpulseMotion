"use client"

import { useEffect, useState } from "react"
import { Plus, Trash2, FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

type Project = {
  id: number
  name: string
  color: string
  task_count: number
}

type Task = {
  id: number
  title: string
  priority: string
  status: string
  project_id: number | null
  duration_minutes: number
}

const PROJECT_COLORS = [
  "#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#f97316"
]

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ name: "", color: "#6366f1" })
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const load = () => {
    fetch("/api/projects").then(r => r.json()).then(setProjects)
    fetch("/api/tasks").then(r => r.json()).then(setTasks)
  }

  useEffect(() => { load() }, [])

  const handleAdd = async () => {
    if (!form.name.trim()) return
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    })
    setShowAdd(false)
    setForm({ name: "", color: "#6366f1" })
    load()
  }

  const handleDelete = async (id: number) => {
    if (!confirm("Supprimer ce projet ?")) return
    await fetch(`/api/projects/${id}`, { method: "DELETE" })
    load()
  }

  const projectTasks = (id: number) => tasks.filter(t => t.project_id === id)
  const doneCount = (id: number) => projectTasks(id).filter(t => t.status === "done").length

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Projets</h1>
        <Button onClick={() => setShowAdd(true)} className="bg-indigo-500 hover:bg-indigo-600 text-white gap-2">
          <Plus className="w-4 h-4" /> Nouveau projet
        </Button>
      </div>

      {projects.length === 0 && (
        <div className="text-center py-20 text-gray-400">
          <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>Aucun projet pour l&apos;instant</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {projects.map(project => {
          const ptasks = projectTasks(project.id)
          const done = doneCount(project.id)
          const total = ptasks.length
          const progress = total > 0 ? Math.round((done / total) * 100) : 0
          const isExpanded = expandedId === project.id

          return (
            <div key={project.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="h-1.5" style={{ backgroundColor: project.color }} />
              <div className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                      style={{ backgroundColor: project.color + "20" }}
                    >
                      <FolderOpen className="w-5 h-5" style={{ color: project.color }} />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">{project.name}</h3>
                      <p className="text-xs text-gray-400">{total} tâche{total !== 1 ? "s" : ""}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : project.id)}
                      className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded hover:bg-gray-50"
                    >
                      {isExpanded ? "Réduire" : "Voir tâches"}
                    </button>
                    <button
                      onClick={() => handleDelete(project.id)}
                      className="text-gray-300 hover:text-red-400 p-1 rounded hover:bg-red-50 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="mb-1">
                  <div className="flex justify-between text-xs text-gray-400 mb-1">
                    <span>{done}/{total} terminées</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${progress}%`, backgroundColor: project.color }}
                    />
                  </div>
                </div>

                {/* Task list expanded */}
                {isExpanded && ptasks.length > 0 && (
                  <div className="mt-4 space-y-1.5 border-t border-gray-50 pt-4">
                    {ptasks.map(t => (
                      <div key={t.id} className="flex items-center gap-2 text-sm">
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          t.status === "done" ? "bg-green-400" :
                          t.status === "in-progress" ? "bg-indigo-400" : "bg-gray-300"
                        }`} />
                        <span className={`flex-1 truncate ${t.status === "done" ? "line-through text-gray-400" : "text-gray-700"}`}>
                          {t.title}
                        </span>
                        <span className="text-xs text-gray-400 shrink-0">{t.duration_minutes}min</span>
                      </div>
                    ))}
                  </div>
                )}

                {isExpanded && ptasks.length === 0 && (
                  <p className="mt-4 text-xs text-gray-400 border-t border-gray-50 pt-4">Aucune tâche dans ce projet</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Add project dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nouveau projet</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label>Nom du projet</Label>
              <Input
                className="mt-1"
                placeholder="Mon projet..."
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                onKeyDown={e => e.key === "Enter" && handleAdd()}
              />
            </div>
            <div>
              <Label>Couleur</Label>
              <div className="flex gap-2 mt-2 flex-wrap">
                {PROJECT_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setForm(p => ({ ...p, color: c }))}
                    className={`w-7 h-7 rounded-full transition-transform ${form.color === c ? "scale-125 ring-2 ring-offset-2 ring-gray-400" : "hover:scale-110"}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => { setShowAdd(false); setForm({ name: "", color: "#6366f1" }) }}>
                Annuler
              </Button>
              <Button onClick={handleAdd} className="bg-indigo-500 hover:bg-indigo-600 text-white">
                Créer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
