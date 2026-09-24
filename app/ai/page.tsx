"use client"

/**
 * Console IA des consultants (/ai).
 *
 * Même boîte à outils que le copilote dashboard : Meta / Google / GA4 dans le
 * périmètre du consultant, HQ en lecture, Google Sheets, web, bac à sable
 * Python (graphiques et exports rendus via /api/relay/files), images et
 * documents joints, choix du modèle, « Mémoriser dans HQ ».
 *
 * Les conversations vivent dans le navigateur (localStorage, pixels des
 * images non conservés) ; le relay garde la session CLI par conversation.
 */

import { useState, useRef, useEffect, useCallback } from "react"
import { Send, Loader2, Bot, User, Wrench, Plus, Copy, Check, History, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { streamChat, type StreamEvent } from "@/lib/relay-client"
import { AiMarkdown } from "@/components/ai/ai-markdown"
import { AttachButton, MessageAttachments, PendingAttachments, useAttachments } from "@/components/ai/attachments"
import { ModelPicker } from "@/components/ai/model-picker"
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
}

interface ConversationMeta { id: string; title: string; updatedAt: number }

const PREFS_KEY = "console:prefs"
const LIST_KEY = "console:conversations"
const CONV_KEY = (id: string) => `console:conv:${id}`
const MAX_CONVERSATIONS = 20
const MAX_HISTORY = 30

function loadList(): ConversationMeta[] {
  try {
    const raw = localStorage.getItem(LIST_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((c) => c && typeof c.id === "string") : []
  } catch { return [] }
}

function loadConversation(id: string): UIMessage[] {
  try {
    const raw = localStorage.getItem(CONV_KEY(id))
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

/** Persists a conversation without image pixels (localStorage is ~5 MB per origin). */
function saveConversation(id: string, messages: UIMessage[]) {
  try {
    const slim = messages
      .filter((m) => m.content || m.images?.length || m.files?.length)
      .map((m) => ({
        id: m.id, role: m.role, content: m.content,
        ...(m.images?.length ? { images: m.images.map((im) => ({ mediaType: im.mediaType, data: "", name: im.name })) } : {}),
        ...(m.files?.length ? { files: m.files } : {}),
        ...(m.toolCalls?.length ? { toolCalls: m.toolCalls, toolResults: (m.toolResults ?? []).map((r) => ({ ...r, content: "" })) } : {}),
        ...(m.usage ? { usage: m.usage } : {}),
      }))
    localStorage.setItem(CONV_KEY(id), JSON.stringify(slim))
    const first = messages.find((m) => m.role === "user")?.content.replace(FILES_NOTE_RE, "").trim() ?? ""
    const title = (first || "Nouvelle conversation").slice(0, 60)
    const list = [{ id, title, updatedAt: Date.now() }, ...loadList().filter((c) => c.id !== id)].slice(0, MAX_CONVERSATIONS)
    for (const gone of loadList().filter((c) => !list.some((k) => k.id === c.id))) localStorage.removeItem(CONV_KEY(gone.id))
    localStorage.setItem(LIST_KEY, JSON.stringify(list))
  } catch { /* quota or private mode: the thread still lives in memory */ }
}

const TOOL_LABELS: Array<[string, string]> = [
  ["mcp__meta-ads-impulse__", "Meta : "],
  ["mcp__mcp-google-ads__", "Google Ads : "],
  ["mcp__mcp-google-analytics__", "GA4 : "],
  ["mcp__mcp-google-sheet__", "Sheets : "],
  ["mcp__claude_ai_mcp_hq__", "HQ : "],
  ["mcp__hq__", "HQ : "],
  ["mcp__sandbox__", "Python : "],
]
function formatToolName(name: string) {
  for (const [prefix, label] of TOOL_LABELS) if (name.startsWith(prefix)) return label + name.slice(prefix.length).replace(/1$/, "")
  if (name === "WebSearch") return "Recherche web"
  if (name === "WebFetch") return "Lecture de page"
  if (name === "ToolSearch") return "Chargement d'outils"
  return name
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
  const att = useAttachments({ uploadUrl: "/api/relay/files", uploadExtra: { conversationId }, disabled: isLoading })
  const filesBase = `/api/relay/files/${conversationId}`

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  // Restore prefs + the most recent conversation.
  useEffect(() => {
    setPrefs(loadPrefs(PREFS_KEY))
    const list = loadList()
    setConversations(list)
    if (list[0]) {
      const msgs = loadConversation(list[0].id)
      if (msgs.length) { setConversationId(list[0].id); setMessages(msgs) }
    }
  }, [])

  function updatePrefs(patch: Partial<AiPrefs>) {
    setPrefs((prev) => { const next = { ...prev, ...patch }; savePrefs(PREFS_KEY, next); return next })
  }

  function persist(id: string, msgs: UIMessage[]) {
    saveConversation(id, msgs)
    setConversations(loadList())
  }

  function newConversation() {
    if (isLoading) abortRef.current?.abort()
    setConversationId(crypto.randomUUID())
    setMessages([])
    setMemo((m) => ({ ...m, open: false, note: null }))
    setShowHistory(false)
    inputRef.current?.focus()
  }

  function openConversation(id: string) {
    if (isLoading) abortRef.current?.abort()
    setConversationId(id)
    setMessages(loadConversation(id))
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
    const assistantMsg: UIMessage = { id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [], toolResults: [], isStreaming: true }

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
      await streamChat(
        history,
        (event: StreamEvent) => {
          setMessages((prev) => {
            const updated = [...prev]
            const last = { ...updated[updated.length - 1] }
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
        { conversationId, model: prefs.model, effort: prefs.effort },
      )
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
                  <button key={c.id} type="button" onClick={() => openConversation(c.id)} className={`w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-gray-900 ${c.id === conversationId ? "text-violet-300" : "text-gray-300"}`}>
                    <div className="truncate">{c.title}</div>
                    <div className="text-[10px] text-gray-600">{new Date(c.updatedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</div>
                  </button>
                ))}
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

                  {msg.isStreaming && !msg.content && (
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Analyse en cours...</span>
                    </div>
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
