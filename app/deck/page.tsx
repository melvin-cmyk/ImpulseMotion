"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import {
  Trash2,
  GripVertical,
  Download,
  Plus,
  Type,
  FileText,
  Image as ImageIcon,
  Edit3,
  Check,
  X,
  Presentation,
  Send,
  Loader2,
  Bot,
  User,
  Wrench,
  Copy,
  Table2,
  PanelLeftClose,
  PanelRightClose,
  ChevronDown,
  ArrowRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  useDeck,
  addSlide,
  removeSlide,
  updateSlide,
  reorderSlides,
  setDeckName,
  clearDeck,
  type Slide,
  type TableData,
} from "@/lib/deck-store"
import { streamChat, type ChatMessage, type StreamEvent } from "@/lib/relay-client"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

// ── Markdown table parser ────────────────────────────────────────────────────
function parseMarkdownTable(md: string): TableData | null {
  const lines = md.trim().split("\n").filter((l) => l.includes("|"))
  if (lines.length < 2) return null
  const parse = (line: string) =>
    line.split("|").map((c) => c.trim()).filter(Boolean)
  const headers = parse(lines[0])
  // skip separator line (index 1)
  const rows = lines.slice(2).map(parse).filter((r) => r.length === headers.length)
  if (headers.length === 0 || rows.length === 0) return null
  return { headers, rows }
}

// ── Extract tables and images from markdown ──────────────────────────────────
function extractContentBlocks(content: string) {
  const blocks: { type: "table" | "image" | "text"; content: string; tableData?: TableData }[] = []
  const lines = content.split("\n")
  let buffer: string[] = []
  let inTable = false

  const flushBuffer = () => {
    if (buffer.length > 0) {
      const text = buffer.join("\n").trim()
      if (text) blocks.push({ type: "text", content: text })
      buffer = []
    }
  }

  for (const line of lines) {
    const isTableLine = line.trim().startsWith("|") && line.trim().endsWith("|")

    if (isTableLine && !inTable) {
      flushBuffer()
      inTable = true
      buffer.push(line)
    } else if (isTableLine && inTable) {
      buffer.push(line)
    } else if (!isTableLine && inTable) {
      const tableStr = buffer.join("\n")
      const tableData = parseMarkdownTable(tableStr)
      if (tableData) {
        blocks.push({ type: "table", content: tableStr, tableData })
      } else {
        blocks.push({ type: "text", content: tableStr })
      }
      buffer = []
      inTable = false
      buffer.push(line)
    } else {
      // Check for image URLs
      const imgMatch = line.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/)
      if (imgMatch) {
        flushBuffer()
        blocks.push({ type: "image", content: imgMatch[1] })
      } else {
        buffer.push(line)
      }
    }
  }

  if (inTable) {
    const tableStr = buffer.join("\n")
    const tableData = parseMarkdownTable(tableStr)
    if (tableData) {
      blocks.push({ type: "table", content: tableStr, tableData })
    } else {
      blocks.push({ type: "text", content: tableStr })
    }
  } else {
    flushBuffer()
  }

  return blocks
}

// ── Chat message type ────────────────────────────────────────────────────────
interface UIMessage {
  id: string
  role: "user" | "assistant"
  content: string
  toolCalls?: { name: string; id: string }[]
  toolResults?: { id: string; content: string; is_error: boolean }[]
  usage?: { cost: number; turns: number; duration: number }
  isStreaming?: boolean
}

// ── Slide Preview Component ──────────────────────────────────────────────────
function SlidePreview({ slide }: { slide: Slide }) {
  if (slide.type === "title") {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4">
        <h2 className="text-2xl font-bold text-white mb-2">{slide.title}</h2>
        {slide.subtitle && <p className="text-base text-gray-400">{slide.subtitle}</p>}
      </div>
    )
  }

  if (slide.type === "image" || slide.type === "creative") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        {slide.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={slide.imageUrl} alt={slide.creativeName || "Slide"} className="max-h-[80%] max-w-full object-contain rounded" />
        ) : (
          <ImageIcon className="w-12 h-12 text-gray-700" />
        )}
        {slide.creativeName && (
          <p className="text-xs text-gray-400 truncate max-w-full px-2">{slide.creativeName}</p>
        )}
        {slide.creativeMetrics && (
          <div className="flex gap-3 text-[10px] text-gray-500">
            {Object.entries(slide.creativeMetrics).slice(0, 4).map(([k, v]) => (
              <span key={k}><span className="text-gray-600">{k}:</span> {v}</span>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (slide.type === "table" && slide.tableData) {
    const { headers, rows } = slide.tableData
    return (
      <div className="h-full overflow-auto p-3">
        {slide.title && <h3 className="text-sm font-semibold text-white mb-2">{slide.title}</h3>}
        <table className="w-full text-[10px] border-collapse">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="bg-gray-800/70 text-gray-300 px-2 py-1 text-left border border-gray-700 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="px-2 py-1 text-gray-400 border border-gray-800">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // markdown
  return (
    <div className="p-4 h-full overflow-auto prose prose-sm prose-invert max-w-none prose-table:text-xs prose-th:bg-gray-800/50 prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-th:text-left prose-table:border-collapse prose-th:border prose-th:border-gray-700 prose-td:border prose-td:border-gray-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{slide.content}</ReactMarkdown>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function DeckPage() {
  const deck = useDeck()

  // Slide editor state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState("")
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(deck.name)
  const [dragId, setDragId] = useState<string | null>(null)
  const [selectedSlide, setSelectedSlide] = useState<string | null>(null)

  // Chat state
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  // ── Slide actions ──────────────────────────────────────────────────────────
  const handleAddTitle = () => {
    addSlide({ type: "title", content: "", title: "Titre de la slide", subtitle: "Sous-titre" })
  }
  const handleAddMarkdown = () => {
    addSlide({ type: "markdown", content: "# Nouvelle slide\n\nContenu ici..." })
  }
  const handleAddImage = () => {
    const url = prompt("URL de l'image:")
    if (url) addSlide({ type: "image", content: "", imageUrl: url })
  }

  const handleEdit = (slide: Slide) => {
    setEditingId(slide.id)
    if (slide.type === "title") {
      setEditContent(`${slide.title || ""}\n---\n${slide.subtitle || ""}`)
    } else if (slide.type === "table" && slide.tableData) {
      // Reconstruct markdown table for editing
      const { headers, rows } = slide.tableData
      const headerLine = `| ${headers.join(" | ")} |`
      const sepLine = `| ${headers.map(() => "---").join(" | ")} |`
      const rowLines = rows.map((r) => `| ${r.join(" | ")} |`)
      setEditContent([headerLine, sepLine, ...rowLines].join("\n"))
    } else {
      setEditContent(slide.content)
    }
  }

  const handleSaveEdit = () => {
    if (!editingId) return
    const slide = deck.slides.find((s) => s.id === editingId)
    if (!slide) return

    if (slide.type === "title") {
      const [title, ...rest] = editContent.split("\n---\n")
      updateSlide(editingId, { title, subtitle: rest.join("\n---\n") })
    } else if (slide.type === "table") {
      const tableData = parseMarkdownTable(editContent)
      if (tableData) {
        updateSlide(editingId, { content: editContent, tableData })
      } else {
        updateSlide(editingId, { content: editContent })
      }
    } else {
      updateSlide(editingId, { content: editContent })
    }
    setEditingId(null)
  }

  const handleDragStart = (id: string) => setDragId(id)
  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    if (!dragId || dragId === targetId) return
    const slides = [...deck.slides]
    const fromIdx = slides.findIndex((s) => s.id === dragId)
    const toIdx = slides.findIndex((s) => s.id === targetId)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = slides.splice(fromIdx, 1)
    slides.splice(toIdx, 0, moved)
    reorderSlides(slides)
  }
  const handleDragEnd = () => setDragId(null)

  // ── PPTX Export ────────────────────────────────────────────────────────────
  const handleExportPPTX = async () => {
    const PptxGenJS = (await import("pptxgenjs")).default
    const pptx = new PptxGenJS()
    pptx.author = "ImpulseMotion"
    pptx.title = deck.name

    for (const slide of deck.slides) {
      const pptSlide = pptx.addSlide()
      pptSlide.background = { color: "0F0F17" }

      if (slide.type === "title") {
        pptSlide.addText(slide.title || "", {
          x: 0.5, y: 1.5, w: 9, h: 1.5,
          fontSize: 36, bold: true, color: "FFFFFF", align: "center",
        })
        if (slide.subtitle) {
          pptSlide.addText(slide.subtitle, {
            x: 0.5, y: 3, w: 9, h: 1,
            fontSize: 18, color: "9CA3AF", align: "center",
          })
        }
      } else if ((slide.type === "image" || slide.type === "creative") && slide.imageUrl) {
        pptSlide.addImage({
          path: slide.imageUrl,
          x: 0.5, y: 0.5, w: 9, h: 5.5,
          sizing: { type: "contain", w: 9, h: 5.5 },
        })
        if (slide.creativeName) {
          pptSlide.addText(slide.creativeName, {
            x: 0.5, y: 6.2, w: 9, h: 0.5,
            fontSize: 10, color: "9CA3AF", align: "center",
          })
        }
      } else if (slide.type === "table" && slide.tableData) {
        const { headers, rows } = slide.tableData
        if (slide.title) {
          pptSlide.addText(slide.title, {
            x: 0.5, y: 0.2, w: 9, h: 0.5,
            fontSize: 16, bold: true, color: "FFFFFF",
          })
        }
        const tableRows = [
          headers.map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: { color: "1F2937" } } })),
          ...rows.map((row) => row.map((cell) => ({ text: cell, options: { color: "E5E7EB" } }))),
        ]
        pptSlide.addTable(tableRows, {
          x: 0.3, y: slide.title ? 0.8 : 0.3, w: 9.4,
          fontSize: 9,
          border: { type: "solid", pt: 0.5, color: "374151" },
          colW: Array(headers.length).fill(9.4 / headers.length),
          rowH: 0.35,
          autoPage: true,
        })
      } else if (slide.type === "markdown") {
        const plainText = slide.content
          .replace(/#{1,6}\s+/g, "")
          .replace(/\*\*(.*?)\*\*/g, "$1")
          .replace(/\*(.*?)\*/g, "$1")
          .replace(/\|/g, "  ")
          .replace(/---+/g, "")
          .replace(/\n{3,}/g, "\n\n")
        pptSlide.addText(plainText, {
          x: 0.5, y: 0.3, w: 9, h: 6.5,
          fontSize: 11, color: "E5E7EB", valign: "top",
          fontFace: "Courier New", lineSpacingMultiple: 1.2,
        })
      }
    }

    await pptx.writeFile({ fileName: `${deck.name.replace(/\s+/g, "_")}.pptx` })
  }

  // ── Chat actions ───────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    const text = input.trim()
    if (!text || isLoading) return

    const userMsg: UIMessage = { id: crypto.randomUUID(), role: "user", content: text }
    const assistantMsg: UIMessage = {
      id: crypto.randomUUID(), role: "assistant", content: "",
      toolCalls: [], toolResults: [], isStreaming: true,
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput("")
    setIsLoading(true)

    const abort = new AbortController()
    abortRef.current = abort

    const history: ChatMessage[] = [
      ...messages.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: text },
    ]

    try {
      await streamChat(history, (event: StreamEvent) => {
        setMessages((prev) => {
          const updated = [...prev]
          const last = { ...updated[updated.length - 1] }
          switch (event.type) {
            case "delta": last.content += event.text || ""; break
            case "content": if (!last.content) last.content = event.text || ""; break
            case "tool_call":
              last.toolCalls = [...(last.toolCalls || []), { name: event.name || "unknown", id: event.id || "" }]
              break
            case "tool_result":
              last.toolResults = [...(last.toolResults || []), { id: event.id || "", content: event.content || "", is_error: event.is_error || false }]
              break
            case "usage":
              last.usage = { cost: event.cost || 0, turns: event.turns || 0, duration: event.duration || 0 }
              break
            case "error": last.content += `\n\n**Erreur:** ${event.message}`; break
          }
          updated[updated.length - 1] = last
          return updated
        })
      }, abort.signal)
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev]
          const last = { ...updated[updated.length - 1] }
          last.content += `\n\n**Erreur de connexion:** ${(err as Error).message}`
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
        return updated
      })
      setIsLoading(false)
      abortRef.current = null
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }

  const handleCopy = (id: string, content: string) => {
    navigator.clipboard.writeText(content)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  // ── Add content to deck (smart detection) ──────────────────────────────────
  const handleAddToDeck = (content: string) => {
    const blocks = extractContentBlocks(content)
    let added = 0

    for (const block of blocks) {
      if (block.type === "table" && block.tableData) {
        // Extract title from content before the table
        const titleMatch = content.match(/#+\s+(.+?)(?:\n|$)/)
        addSlide({
          type: "table",
          content: block.content,
          tableData: block.tableData,
          title: titleMatch?.[1] || undefined,
        })
        added++
      } else if (block.type === "image") {
        addSlide({ type: "image", content: "", imageUrl: block.content })
        added++
      }
    }

    // If no structured content found, add as markdown
    if (added === 0) {
      addSlide({ type: "markdown", content })
    }
  }

  const handleAddTableToDeck = (tableContent: string, tableData: TableData) => {
    addSlide({ type: "table", content: tableContent, tableData })
  }

  const formatToolName = (name: string) => {
    return name
      .replace("mcp__meta-ads-impulse__", "Meta: ")
      .replace("mcp__mcp-google-ads__", "GAds: ")
      .replace("mcp__mcp-google-analytics__", "GA: ")
      .replace(/1$/, "")
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="border-b border-gray-800 px-4 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
            <Presentation className="w-4 h-4 text-white" />
          </div>
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") { setDeckName(nameValue); setEditingName(false) } }}
              />
              <Button variant="ghost" size="icon-xs" onClick={() => { setDeckName(nameValue); setEditingName(false) }}>
                <Check className="w-3 h-3" />
              </Button>
            </div>
          ) : (
            <button
              onClick={() => { setNameValue(deck.name); setEditingName(true) }}
              className="text-sm font-semibold text-white hover:text-violet-400 transition-colors"
            >
              {deck.name}
            </button>
          )}
          <span className="text-xs text-gray-500">{deck.slides.length} slides</span>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setChatOpen(!chatOpen)} className="text-gray-400">
            {chatOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearDeck} className="text-gray-400">
            <Trash2 className="w-4 h-4 mr-1" /> Clear
          </Button>
          <Button
            size="sm"
            onClick={handleExportPPTX}
            disabled={deck.slides.length === 0}
            className="bg-violet-600 hover:bg-violet-700"
          >
            <Download className="w-4 h-4 mr-1" /> Export PPTX
          </Button>
        </div>
      </div>

      {/* ── Main split view ───────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        {/* ── LEFT: Slides panel ──────────────────────────────────────────── */}
        <div className={`flex-1 flex flex-col overflow-hidden ${chatOpen ? "border-r border-gray-800" : ""}`}>
          {/* Add slide buttons */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800/50 shrink-0">
            <span className="text-xs text-gray-500 mr-2">Ajouter:</span>
            <Button variant="outline" size="xs" onClick={handleAddTitle} className="text-gray-300 border-gray-700">
              <Type className="w-3 h-3 mr-1" /> Titre
            </Button>
            <Button variant="outline" size="xs" onClick={handleAddMarkdown} className="text-gray-300 border-gray-700">
              <FileText className="w-3 h-3 mr-1" /> Texte
            </Button>
            <Button variant="outline" size="xs" onClick={handleAddImage} className="text-gray-300 border-gray-700">
              <ImageIcon className="w-3 h-3 mr-1" /> Image
            </Button>
          </div>

          {/* Slides list */}
          <div className="flex-1 overflow-auto px-4 py-3">
            {deck.slides.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Presentation className="w-12 h-12 text-gray-700 mb-4" />
                <p className="text-gray-500 text-sm mb-1">Aucune slide</p>
                <p className="text-gray-600 text-xs max-w-xs">
                  Utilise le chat pour recuperer des donnees, puis clique <ArrowRight className="w-3 h-3 inline" /> pour les ajouter au deck
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {deck.slides.map((slide, index) => (
                  <div
                    key={slide.id}
                    draggable
                    onDragStart={() => handleDragStart(slide.id)}
                    onDragOver={(e) => handleDragOver(e, slide.id)}
                    onDragEnd={handleDragEnd}
                    onClick={() => setSelectedSlide(selectedSlide === slide.id ? null : slide.id)}
                    className={`group relative bg-gray-900 border rounded-lg overflow-hidden transition-all cursor-pointer ${
                      dragId === slide.id
                        ? "border-violet-500 opacity-50"
                        : selectedSlide === slide.id
                        ? "border-violet-500/50 ring-1 ring-violet-500/20"
                        : "border-gray-800 hover:border-gray-700"
                    }`}
                  >
                    {/* Slide header */}
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-900/50">
                      <GripVertical className="w-3 h-3 text-gray-600 cursor-grab" />
                      <span className="text-[10px] text-gray-500 font-mono">
                        #{index + 1} — {slide.type}
                      </span>
                      <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="ghost" size="icon-xs" onClick={(e) => { e.stopPropagation(); handleEdit(slide) }}>
                          <Edit3 className="w-3 h-3 text-gray-400" />
                        </Button>
                        <Button variant="ghost" size="icon-xs" onClick={(e) => { e.stopPropagation(); removeSlide(slide.id) }}>
                          <Trash2 className="w-3 h-3 text-red-400" />
                        </Button>
                      </div>
                    </div>

                    {/* Slide content */}
                    <div className="aspect-[16/9] max-h-[200px] overflow-hidden bg-[#0F0F17]">
                      {editingId === slide.id ? (
                        <div className="h-full flex flex-col p-2">
                          <textarea
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            className="flex-1 bg-gray-800 border border-gray-700 rounded p-2 text-xs text-white font-mono resize-none"
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div className="flex justify-end gap-1 mt-1">
                            <Button variant="ghost" size="xs" onClick={(e) => { e.stopPropagation(); setEditingId(null) }}>
                              <X className="w-3 h-3" />
                            </Button>
                            <Button size="xs" onClick={(e) => { e.stopPropagation(); handleSaveEdit() }} className="bg-violet-600">
                              <Check className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <SlidePreview slide={slide} />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: Chat panel ───────────────────────────────────────────── */}
        {chatOpen && (
          <div className="w-[440px] flex flex-col shrink-0">
            {/* Chat header */}
            <div className="px-4 py-2 border-b border-gray-800/50 flex items-center gap-2 shrink-0">
              <div className="w-6 h-6 rounded-md bg-violet-600/20 flex items-center justify-center">
                <Bot className="w-3.5 h-3.5 text-violet-400" />
              </div>
              <span className="text-xs font-medium text-gray-300">AI Assistant</span>
              <span className="text-[10px] text-gray-600">Meta Ads · Google Ads · GA</span>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-3 space-y-3">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center px-4">
                  <Bot className="w-10 h-10 text-violet-400/30 mb-3" />
                  <p className="text-xs text-gray-500 mb-4">
                    Demande des donnees, des tableaux, des creatives...
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 w-full">
                    {[
                      "Top 5 creatives Meta Ads ce mois avec les images",
                      "Tableau performance campagnes actives",
                      "Overview du compte sur les 30 derniers jours",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => setInput(suggestion)}
                        className="text-left text-[11px] text-gray-400 border border-gray-800 rounded-lg px-3 py-2 hover:border-violet-600 hover:text-gray-200 transition-colors"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg) => (
                <div key={msg.id} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}>
                  {msg.role === "assistant" && (
                    <div className="w-5 h-5 rounded bg-violet-600/20 flex items-center justify-center shrink-0 mt-1">
                      <Bot className="w-3 h-3 text-violet-400" />
                    </div>
                  )}

                  <div className={`max-w-[90%] ${
                    msg.role === "user"
                      ? "bg-violet-600 rounded-xl rounded-tr-sm px-3 py-2"
                      : "flex-1 min-w-0"
                  }`}>
                    {msg.role === "user" ? (
                      <p className="text-xs text-white whitespace-pre-wrap">{msg.content}</p>
                    ) : (
                      <div>
                        {/* Tool calls */}
                        {msg.toolCalls && msg.toolCalls.length > 0 && (
                          <div className="mb-2 space-y-0.5">
                            {msg.toolCalls.map((tc, i) => (
                              <div key={i} className="flex items-center gap-1.5 text-[10px] text-gray-500">
                                <Wrench className="w-2.5 h-2.5" />
                                <span>{formatToolName(tc.name)}</span>
                                {msg.toolResults?.find((r) => r.id === tc.id) ? (
                                  <Check className="w-2.5 h-2.5 text-green-500" />
                                ) : msg.isStreaming ? (
                                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                ) : null}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Content with inline add-to-deck buttons */}
                        {msg.content && (
                          <div className="text-xs">
                            {extractContentBlocks(msg.content).map((block, i) => {
                              if (block.type === "table" && block.tableData) {
                                return (
                                  <div key={i} className="relative group/table my-2">
                                    <div className="prose prose-sm prose-invert max-w-none prose-table:text-[10px] prose-th:bg-gray-800/50 prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-th:text-left prose-table:border-collapse prose-th:border prose-th:border-gray-700 prose-td:border prose-td:border-gray-800">
                                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
                                    </div>
                                    <button
                                      onClick={() => handleAddTableToDeck(block.content, block.tableData!)}
                                      className="absolute -right-1 top-0 opacity-0 group-hover/table:opacity-100 transition-opacity bg-violet-600 hover:bg-violet-500 text-white rounded-md px-2 py-1 text-[10px] flex items-center gap-1 shadow-lg"
                                    >
                                      <Plus className="w-3 h-3" /> Slide
                                    </button>
                                  </div>
                                )
                              }
                              return (
                                <div key={i} className="prose prose-sm prose-invert max-w-none">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
                                </div>
                              )
                            })}
                          </div>
                        )}

                        {/* Streaming indicator */}
                        {msg.isStreaming && !msg.content && (
                          <div className="flex items-center gap-1.5 text-xs text-gray-500">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Analyse en cours...</span>
                          </div>
                        )}

                        {/* Actions */}
                        {msg.content && !msg.isStreaming && (
                          <div className="flex items-center gap-1 mt-2">
                            <Button
                              variant="ghost" size="icon-xs"
                              onClick={() => handleCopy(msg.id, msg.content)}
                              title="Copier"
                            >
                              {copiedId === msg.id ? (
                                <Check className="w-3 h-3 text-green-400" />
                              ) : (
                                <Copy className="w-3 h-3 text-gray-500" />
                              )}
                            </Button>
                            <Button
                              variant="ghost" size="icon-xs"
                              onClick={() => handleAddToDeck(msg.content)}
                              title="Ajouter tout au deck"
                            >
                              <Presentation className="w-3 h-3 text-gray-500" />
                            </Button>
                            {msg.usage && (
                              <span className="text-[9px] text-gray-600 ml-auto">
                                {(msg.usage.duration / 1000).toFixed(1)}s · ${msg.usage.cost.toFixed(4)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Input */}
            <div className="border-t border-gray-800 px-3 py-2 shrink-0">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Demande des donnees..."
                  rows={1}
                  className="flex-1 resize-none bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder:text-gray-500 focus:outline-none focus:border-violet-600 transition-colors"
                  style={{ minHeight: "36px", maxHeight: "100px" }}
                  onInput={(e) => {
                    const t = e.target as HTMLTextAreaElement
                    t.style.height = "auto"
                    t.style.height = Math.min(t.scrollHeight, 100) + "px"
                  }}
                />
                <Button
                  onClick={handleSubmit}
                  disabled={!input.trim() || isLoading}
                  size="icon-xs"
                  className="bg-violet-600 hover:bg-violet-700 rounded-lg h-9 w-9 shrink-0"
                >
                  {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
