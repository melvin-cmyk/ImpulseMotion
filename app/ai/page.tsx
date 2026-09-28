"use client"

/**
 * Console IA des consultants (/ai).
 *
 * Même boîte à outils que le copilote dashboard : Meta / Google / GA4 dans le
 * périmètre du consultant, HQ en lecture, Google Sheets, web, bac à sable
 * Python (graphiques et exports rendus via /api/relay/files), images et
 * documents joints, choix du modèle, « Mémoriser dans HQ ».
 *
 * Les conversations sont enregistrées côté serveur, privées au consultant
 * connecté (pixels des images non conservés) ; rien n'en reste dans le
 * navigateur. Le relay garde la session CLI par conversation.
 */

import { useState, useRef, useEffect, useCallback } from "react"
import { Send, Loader2, Bot, User, Wrench, Plus, Copy, Check, History, Square, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { streamChat, type StreamEvent } from "@/lib/relay-client"
import { AiMarkdown } from "@/components/ai/ai-markdown"
import { AttachButton, MessageAttachments, PendingAttachments, useAttachments } from "@/components/ai/attachments"
import { ModelPicker } from "@/components/ai/model-picker"
import { AiActivity } from "@/components/ai/activity"
import { StaleBuildBanner } from "@/components/ai/stale-build"
import { AUTO_CONTINUE_PROMPT, INITIAL_ACTIVITY, MAX_AUTO_CONTINUES, formatToolName, reduceActivity, type ActivityState } from "@/lib/ai-activity"
import { DEFAULT_PREFS, FILES_NOTE_RE, filesNote, loadPrefs, savePrefs, type AiPrefs, type ChatFile, type ChatImage } from "@/lib/ai-chat-shared"

interface UIMessage {
  id: string
  role: "user" | "assistant"
  content: string
  images?: ChatImage[]
  files?: ChatFile[]
  toolCalls?: { name: string; id: string }[]
  toolResults?: { id: string; content: string; is_error: boolean }[]
  usage?: { cost: number; turns: number; duration: number }
  isStreaming?: boolean
  /** Live status of the running turn (never persisted). */
  activity?: ActivityState
  startedAt?: number
  /** Automatic relaunches of this turn after a time-budget cut. */
  round?: number
}

interface ConversationMeta { id: string; title: string; updatedAt: number }

const PREFS_KEY = "console:prefs"
const LEGACY_LIST_KEY = "console:conversations"
const LEGACY_CONV_KEY = (id: string) => `console:conv:${id}`
const MAX_HISTORY = 30

/** What is stored of a message: no image pixels, no tool output, no live state. */
function slimMessages(messages: UIMessage[]) {
  return messages
    .filter((m) => m.content || m.images?.length || m.files?.length)
    .map((m) => ({
      id: m.id, role: m.role, content: m.content,
      ...(m.images?.length ? { images: m.images.map((im) => ({ mediaType: im.mediaType, data: "", name: im.name })) } : {}),
      ...(m.files?.length ? { files: m.files } : {}),
      ...(m.toolCalls?.length ? { toolCalls: m.toolCalls, toolResults: (m.toolResults ?? []).map((r) => ({ ...r, content: "" })) } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
    }))
}

// Conversations are kept on the server, private to the signed-in consultant
// (/api/relay/conversations) — nothing of them stays in the browser.
async function fetchList(): Promise<ConversationMeta[]> {
  try {
    const res = await fetch("/api/relay/conversations", { cache: "no-store" })
    if (!res.ok) return []
    const json = await res.json()
    return Array.isArray(json.conversations) ? json.conversations : []
  } catch { return [] }
}

async function fetchConversation(id: string): Promise<UIMessage[]> {
  try {
    const res = await fetch(`/api/relay/conversations/${id}`, { cache: "no-store" })
    if (!res.ok) return []
    const json = await res.json()
    return Array.isArray(json.messages) ? json.messages : []
  } catch { return [] }
}

async function saveConversation(id: string, messages: UIMessage[]): Promise<boolean> {
  try {
    const res = await fetch(`/api/relay/conversations/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: slimMessages(messages) }),
    })
    return res.ok
  } catch { return false }
}

/**
 * One-off: conversations an earlier version kept in this browser are moved to
 * the account of whoever is signed in, then wiped from the browser.
 */
async function moveLegacyConversations(): Promise<void> {
  let ids: string[] = []
  try {
    const raw = localStorage.getItem(LEGACY_LIST_KEY)
    const list = raw ? JSON.parse(raw) : []
    ids = Array.isArray(list) ? list.map((c) => c?.id).filter((id): id is string => typeof id === "string") : []
  } catch { return }
  for (const id of ids.reverse()) {
    try {
      const raw = localStorage.getItem(LEGACY_CONV_KEY(id))
      const msgs = raw ? JSON.parse(raw) : []
      if (!Array.isArray(msgs) || !msgs.length) continue
      const res = await fetch(`/api/relay/conversations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: slimMessages(msgs) }),
      })
      // Server down or signed out: keep them for a later try. A refused
      // entry (4xx) is dropped with the rest.
      if (res.status >= 500 || res.status === 401) return
    } catch (e) {
      if (e instanceof TypeError) return // network failure: try again next time
    }
  }
  try {
    for (const id of ids) localStorage.removeItem(LEGACY_CONV_KEY(id))
    localStorage.removeItem(LEGACY_LIST_KEY)
  } catch { /* private mode */ }
}

export default function AIPage() {
  const [messages, setMessages] = useState<UIMessage[]>([])
  // Names the relay session so follow-ups resume it instead of replaying the thread.
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID())
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<AiPrefs>(DEFAULT_PREFS)
  const [memo, setMemo] = useState<{ open: boolean; projects: Array<{ slug: string; name: string }>; project: string; busy: boolean; note: { ok: boolean; text: string } | null }>({ open: false, projects: [], project: "", busy: false, note: null })
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Set once the consultant acts, so the restored conversation never overwrites it.
  const startedRef = useRef(false)
  const [saveError, setSaveError] = useState(false)
  const att = useAttachments({ uploadUrl: "/api/relay/files", uploadExtra: { conversationId }, disabled: isLoading })
  const filesBase = `/api/relay/files/${conversationId}`

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  // Restore prefs + the most recent conversation.
  useEffect(() => {
    setPrefs(loadPrefs(PREFS_KEY))
    let cancelled = false
    void (async () => {
      await moveLegacyConversations()
      const list = await fetchList()
      if (cancelled) return
      setConversations(list)
      if (!list[0]) return
      const msgs = await fetchConversation(list[0].id)
      // Do not replace a conversation the consultant already started typing in.
      if (cancelled || !msgs.length || startedRef.current) return
      setConversationId(list[0].id)
      setMessages(msgs)
    })()
    return () => { cancelled = true }
  }, [])

  function updatePrefs(patch: Partial<AiPrefs>) {
    setPrefs((prev) => { const next = { ...prev, ...patch }; savePrefs(PREFS_KEY, next); return next })
  }

  function persist(id: string, msgs: UIMessage[]) {
    void (async () => {
      const saved = await saveConversation(id, msgs)
      setSaveError(!saved)
      setConversations(await fetchList())
    })()
  }

  async function deleteConversation(id: string) {
    try { await fetch(`/api/relay/conversations/${id}`, { method: "DELETE" }) } catch { /* listed again below if it failed */ }
    if (id === conversationId) { setConversationId(crypto.randomUUID()); setMessages([]) }
    setConversations(await fetchList())
  }

  function newConversation() {
    if (isLoading) abortRef.current?.abort()
    startedRef.current = true
    setConversationId(crypto.randomUUID())
    setMessages([])
    setMemo((m) => ({ ...m, open: false, note: null }))
    setShowHistory(false)
    inputRef.current?.focus()
  }

  async function openConversation(id: string) {
    if (isLoading) abortRef.current?.abort()
    startedRef.current = true
    const msgs = await fetchConversation(id)
    setConversationId(id)
    setMessages(msgs)
    setMemo((m) => ({ ...m, open: false, note: null }))
    setShowHistory(false)
  }

  const handleSubmit = async () => {
    const text = input.trim()
    if ((!text && !att.hasPending) || isLoading || att.busy) return
    const { images, files } = att.take()
    const body = text || (files.length ? "Voici le(s) fichier(s), analyse-les." : images.length > 1 ? "Voici des images." : "Voici une image.")
    const content = body + filesNote(files)

    const userMsg: UIMessage = { id: crypto.randomUUID(), role: "user", content, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }
    const assistantMsg: UIMessage = { id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [], toolResults: [], isStreaming: true, activity: INITIAL_ACTIVITY, startedAt: Date.now() }

    startedRef.current = true
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput("")
    setIsLoading(true)

    const abort = new AbortController()
    abortRef.current = abort

    // History for the API (the relay resumes the session and only needs the
    // last message, but replays this when the session restarts).
    const history = [
      ...messages.filter((m) => m.content).slice(-MAX_HISTORY).map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images?.some((im) => im.data) ? { images: m.images.filter((im) => im.data) } : {}),
      })),
      { role: "user" as const, content, ...(images.length ? { images } : {}) },
    ]

    try {
      // A turn cut by the time budget (or a dropped stream) is relaunched on
      // the same relay session, in the same bubble, until the work is done.
      let turn = history
      for (let round = 0; ; round++) {
      let sawDone = false
      let resumable = false
      let text = ""
      await streamChat(
        turn,
        (event: StreamEvent) => {
          if (event.type === "done") sawDone = true
          if (event.type === "delta" || event.type === "content") text += event.text || ""
          if (event.type === "error" && event.resumable) { resumable = true; return }
          setMessages((prev) => {
            const updated = [...prev]
            const last = { ...updated[updated.length - 1] }
            last.activity = reduceActivity(last.activity ?? INITIAL_ACTIVITY, event)
            switch (event.type) {
              case "delta":
                last.content += event.text || ""
                break
              case "content":
                if (!last.content) last.content = event.text || ""
                break
              case "tool_call":
                last.toolCalls = [...(last.toolCalls || []), { name: event.name || "unknown", id: event.id || "" }]
                break
              case "tool_result":
                last.toolResults = [...(last.toolResults || []), { id: event.id || "", content: event.content || "", is_error: event.is_error || false }]
                break
              case "usage":
                if (event.partial) break
                last.usage = { cost: event.cost || 0, turns: event.turns || 0, duration: event.duration || 0 }
                break
              case "error":
                last.content += `\n\n**Erreur :** ${event.message}`
                break
            }
            updated[updated.length - 1] = last
            return updated
          })
        },
        abort.signal,
        { conversationId, model: prefs.model, effort: prefs.effort, account: prefs.account },
      )
      const cut = resumable || !sawDone
      if (!cut || abort.signal.aborted) break
      if (round >= MAX_AUTO_CONTINUES) {
        setMessages((prev) => {
          const updated = [...prev]
          const last = { ...updated[updated.length - 1] }
          last.content += `\n\n**Tâche interrompue :** la limite de temps a été atteinte ${MAX_AUTO_CONTINUES + 1} fois de suite. Le travail déjà fait est conservé — écrivez « continue » pour reprendre, ou réduisez la demande.`
          updated[updated.length - 1] = last
          return updated
        })
        break
      }
      setMessages((prev) => {
        const updated = [...prev]
        const last = { ...updated[updated.length - 1] }
        if (last.content && !last.content.endsWith("\n\n")) last.content += "\n\n"
        last.round = round + 1
        last.activity = { ...(last.activity ?? INITIAL_ACTIVITY), phase: "starting", tool: null, pending: [] }
        updated[updated.length - 1] = last
        return updated
      })
      turn = [...turn, ...(text ? [{ role: "assistant" as const, content: text }] : []), { role: "user" as const, content: AUTO_CONTINUE_PROMPT }]
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev]
          const last = { ...updated[updated.length - 1] }
          last.content += `\n\n**Erreur de connexion :** ${(err as Error).message}`
          updated[updated.length - 1] = last
          return updated
        })
      }
    } finally {
      setMessages((prev) => {
        const updated = [...prev]
        const last = { ...updated[updated.length - 1] }
        last.isStreaming = false
        updated[updated.length - 1] = last
        persist(conversationId, updated)
        return updated
      })
      setIsLoading(false)
      abortRef.current = null
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleCopy = (id: string, content: string) => {
    navigator.clipboard.writeText(content)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  async function openMemo() {
    setMemo((m) => ({ ...m, open: true, note: null }))
    if (memo.projects.length) return
    try {
      const res = await fetch("/api/relay/hq-projects")
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`)
      const projects = (json.projects as Array<{ slug: string; name: string }>).sort((a, b) => a.slug.localeCompare(b.slug))
      setMemo((m) => ({ ...m, projects, project: m.project || projects[0]?.slug || "" }))
    } catch (e) {
      setMemo((m) => ({ ...m, note: { ok: false, text: e instanceof Error ? e.message : String(e) } }))
    }
  }

  async function memorize() {
    if (!memo.project || memo.busy) return
    setMemo((m) => ({ ...m, busy: true, note: null }))
    try {
      const res = await fetch("/api/relay/memorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: memo.project, messages: messages.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })) }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`)
      setMemo((m) => ({ ...m, busy: false, open: false, note: { ok: true, text: `Note ajoutée au journal HQ du projet « ${json.project} ».` } }))
    } catch (e) {
      setMemo((m) => ({ ...m, busy: false, note: { ok: false, text: e instanceof Error ? e.message : String(e) } }))
    }
  }

  const canMemorize = messages.filter((m) => m.content).length >= 2 && !isLoading

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-3 flex flex-wrap items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-white">Assistant IA</h1>
          <p className="text-xs text-gray-500">Meta, Google Ads, GA4, HQ, Sheets, web, Python</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden md:block w-[420px]"><ModelPicker prefs={prefs} onChange={updatePrefs} disabled={isLoading} idPrefix="console" /></div>
          <Button variant="ghost" size="sm" onClick={openMemo} disabled={!canMemorize} title="Résume les conclusions de cette conversation dans le journal HQ d'un client" className="text-xs text-gray-300">
            Mémoriser dans HQ
          </Button>
          <div className="relative">
            <Button variant="ghost" size="icon" onClick={() => setShowHistory((v) => !v)} title="Conversations récentes"><History className="w-4 h-4" /></Button>
            {showHistory && (
              <div className="absolute right-0 mt-1 w-72 max-h-80 overflow-auto bg-gray-950 border border-gray-800 rounded-xl shadow-2xl z-30 p-1">
                {conversations.length === 0 && <div className="text-xs text-gray-500 px-3 py-2">Aucune conversation enregistrée.</div>}
                {conversations.map((c) => (
                  <div key={c.id} className="group flex items-center rounded-lg hover:bg-gray-900">
                    <button type="button" onClick={() => openConversation(c.id)} className={`flex-1 min-w-0 text-left px-3 py-2 text-xs ${c.id === conversationId ? "text-violet-300" : "text-gray-300"}`}>
                      <div className="truncate">{c.title}</div>
                      <div className="text-[10px] text-gray-600">{new Date(c.updatedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</div>
                    </button>
                    <button type="button" onClick={() => deleteConversation(c.id)} title="Supprimer cette conversation" className="px-2 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <div className="text-[10px] text-gray-600 px-3 py-2 border-t border-gray-900 mt-1">Historique privé : visible uniquement depuis votre compte.</div>
              </div>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={newConversation} title="Nouvelle conversation"><Plus className="w-4 h-4" /></Button>
        </div>
        <div className="w-full md:hidden"><ModelPicker prefs={prefs} onChange={updatePrefs} disabled={isLoading} idPrefix="console-m" /></div>
      </div>

      {(memo.open || memo.note) && (
        <div className="border-b border-gray-800 px-6 py-2 flex flex-wrap items-center gap-2 text-xs">
          {memo.open && (
            <>
              <span className="text-gray-400">Dossier HQ du client :</span>
              <select value={memo.project} onChange={(e) => setMemo((m) => ({ ...m, project: e.target.value }))} disabled={memo.busy} className="px-2 py-1 rounded-md bg-gray-900 border border-gray-800 text-gray-200 focus:border-violet-500 focus:outline-none">
                {memo.projects.length === 0 && <option value="">Chargement…</option>}
                {memo.projects.map((p) => <option key={p.slug} value={p.slug}>{p.name !== p.slug ? `${p.name} (${p.slug})` : p.slug}</option>)}
              </select>
              <Button size="sm" onClick={memorize} disabled={!memo.project || memo.busy} className="bg-violet-600 hover:bg-violet-700 text-xs">{memo.busy ? "Mémorisation…" : "Consigner la note"}</Button>
              <Button variant="ghost" size="sm" onClick={() => setMemo((m) => ({ ...m, open: false }))} className="text-xs text-gray-400">Annuler</Button>
            </>
          )}
          {memo.note && <span className={memo.note.ok ? "text-emerald-400" : "text-amber-400"}>{memo.note.text}</span>}
        </div>
      )}

      <StaleBuildBanner className="mx-6 mt-3" />
      {saveError && (
        <div className="mx-6 mt-3 text-xs text-amber-200 bg-amber-950/40 border border-amber-900/50 rounded-lg px-3 py-2">
          Cette conversation n&apos;a pas pu être enregistrée dans votre historique. Elle reste affichée tant que la page est ouverte.
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4 space-y-4" onDrop={att.onDrop} onDragOver={att.onDragOver}>
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-700/20 flex items-center justify-center mb-4">
              <Bot className="w-8 h-8 text-violet-400" />
            </div>
            <h2 className="text-lg font-semibold text-white mb-2">Impulse AI Assistant</h2>
            <p className="text-sm text-gray-400 max-w-md mb-2">
              Données Meta Ads, Google Ads et GA4 de ton périmètre, mémoire HQ des clients, Google Sheets, recherche web
              et analyses Python avec graphiques et exports.
            </p>
            <p className="text-xs text-gray-500 max-w-md mb-6">
              Joins des images, Excel, CSV, PDF ou Word avec le trombone, en les collant ou en les déposant ici.
            </p>
            <div className="grid grid-cols-2 gap-2 max-w-lg">
              {[
                "Overview d'un compte Meta sur les 30 derniers jours",
                "Compare le CPA Meta vs Google Ads par semaine sur 8 semaines, avec un graphique",
                "Top 5 des adsets par ROAS ce mois, en Excel",
                "Que sait-on de ce client dans HQ et quels sont ses objectifs ?",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => setInput(suggestion)}
                  className="text-left text-xs text-gray-400 border border-gray-800 rounded-lg px-3 py-2 hover:border-violet-600 hover:text-gray-200 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
            {msg.role === "assistant" && (
              <div className="w-7 h-7 rounded-lg bg-violet-600/20 flex items-center justify-center shrink-0 mt-1">
                <Bot className="w-4 h-4 text-violet-400" />
              </div>
            )}

            <div className={`max-w-[85%] ${msg.role === "user" ? "bg-violet-600 rounded-2xl rounded-tr-sm px-4 py-2.5" : "flex-1 min-w-0"}`}>
              {msg.role === "user" ? (
                <div>
                  <MessageAttachments images={msg.images} files={msg.files} />
                  <p className="text-sm text-white whitespace-pre-wrap">{msg.content.replace(FILES_NOTE_RE, "")}</p>
                </div>
              ) : (
                <div>
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="mb-3 space-y-1">
                      {msg.toolCalls.map((tc, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-gray-500">
                          <Wrench className="w-3 h-3" />
                          <span>{formatToolName(tc.name)}</span>
                          {msg.toolResults?.find((r) => r.id === tc.id) ? (
                            <span className="text-green-500">ok</span>
                          ) : msg.isStreaming ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {msg.content && (
                    <AiMarkdown
                      content={msg.content}
                      filesBase={filesBase}
                      className="prose prose-sm prose-invert max-w-none prose-table:text-xs prose-th:bg-gray-800/50 prose-th:px-3 prose-th:py-1.5 prose-td:px-3 prose-td:py-1.5 prose-th:text-left prose-table:border-collapse prose-th:border prose-th:border-gray-700 prose-td:border prose-td:border-gray-800"
                    />
                  )}

                  {msg.isStreaming && (
                    <AiActivity state={msg.activity ?? INITIAL_ACTIVITY} startedAt={msg.startedAt ?? Date.now()} round={msg.round} className={msg.content ? "mt-3" : undefined} />
                  )}

                  {msg.content && !msg.isStreaming && (
                    <div className="flex items-center gap-1 mt-3">
                      <Button variant="ghost" size="icon-xs" onClick={() => handleCopy(msg.id, msg.content)} title="Copier">
                        {copiedId === msg.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
                      </Button>
                      {msg.usage && (
                        <span className="text-[10px] text-gray-600 ml-auto">{(msg.usage.duration / 1000).toFixed(1)}s</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {msg.role === "user" && (
              <div className="w-7 h-7 rounded-lg bg-gray-700 flex items-center justify-center shrink-0 mt-1">
                <User className="w-4 h-4 text-gray-300" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 px-6 py-3">
        <div className="max-w-4xl mx-auto space-y-2">
          <PendingAttachments att={att} />
          {att.error && <div className="text-[11px] text-amber-400">{att.error}</div>}
          <div className="flex items-end gap-2">
            <AttachButton att={att} disabled={isLoading} className="h-11 px-3 rounded-xl text-base bg-gray-900 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-50" />
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={att.onPaste}
                placeholder={att.hasPending ? "Que faire de ces fichiers ?" : "Demande des données, des analyses, des graphiques, des exports..."}
                rows={1}
                className="w-full resize-none bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-violet-600 transition-colors"
                style={{ minHeight: "44px", maxHeight: "120px" }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement
                  target.style.height = "auto"
                  target.style.height = Math.min(target.scrollHeight, 120) + "px"
                }}
              />
            </div>
            {isLoading ? (
              <Button onClick={() => abortRef.current?.abort()} size="icon" title="Arrêter" className="bg-gray-800 hover:bg-gray-700 rounded-xl h-11 w-11 shrink-0">
                <Square className="w-4 h-4" />
              </Button>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={(!input.trim() && !att.hasPending) || att.busy}
                size="icon"
                className="bg-violet-600 hover:bg-violet-700 rounded-xl h-11 w-11 shrink-0"
              >
                <Send className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
