"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Send, Loader2, Bot, User, Wrench, Plus, Copy, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { streamChat, type ChatMessage, type StreamEvent } from "@/lib/relay-client"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface UIMessage {
  id: string
  role: "user" | "assistant"
  content: string
  toolCalls?: { name: string; id: string }[]
  toolResults?: { id: string; content: string; is_error: boolean }[]
  usage?: { cost: number; turns: number; duration: number }
  isStreaming?: boolean
}

export default function AIPage() {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  const handleSubmit = async () => {
    const text = input.trim()
    if (!text || isLoading) return

    const userMsg: UIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    }

    const assistantMsg: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      toolCalls: [],
      toolResults: [],
      isStreaming: true,
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput("")
    setIsLoading(true)

    const abort = new AbortController()
    abortRef.current = abort

    // Build conversation history for API
    const history: ChatMessage[] = [
      ...messages.filter((m) => m.content).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user" as const, content: text },
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
                last.toolCalls = [
                  ...(last.toolCalls || []),
                  { name: event.name || "unknown", id: event.id || "" },
                ]
                break
              case "tool_result":
                last.toolResults = [
                  ...(last.toolResults || []),
                  {
                    id: event.id || "",
                    content: event.content || "",
                    is_error: event.is_error || false,
                  },
                ]
                break
              case "usage":
                last.usage = {
                  cost: event.cost || 0,
                  turns: event.turns || 0,
                  duration: event.duration || 0,
                }
                break
              case "error":
                last.content += `\n\n**Erreur:** ${event.message}`
                break
            }

            updated[updated.length - 1] = last
            return updated
          })
        },
        abort.signal
      )
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

  const formatToolName = (name: string) => {
    return name
      .replace("mcp__meta-ads-impulse__", "Meta: ")
      .replace("mcp__mcp-google-ads__", "GAds: ")
      .replace("mcp__mcp-google-analytics__", "GA: ")
      .replace(/1$/, "")
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-3 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <div>
          <h1 className="text-sm font-semibold text-white">Assistant IA</h1>
          <p className="text-xs text-gray-500">Meta Ads, Google Ads, Google Analytics</p>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-700/20 flex items-center justify-center mb-4">
              <Bot className="w-8 h-8 text-violet-400" />
            </div>
            <h2 className="text-lg font-semibold text-white mb-2">Impulse AI Assistant</h2>
            <p className="text-sm text-gray-400 max-w-md mb-6">
              Pose des questions sur tes campagnes pub. J&apos;ai acces a Meta Ads, Google Ads et Google Analytics.
            </p>
            <div className="grid grid-cols-2 gap-2 max-w-lg">
              {[
                "Overview d'un compte Meta sur les 30 derniers jours",
                "Performance des campagnes Meta Ads actives",
                "Top 5 des adsets par ROAS ce mois",
                "Breakdown par device d'un compte Google Ads",
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
          <div
            key={msg.id}
            className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}
          >
            {msg.role === "assistant" && (
              <div className="w-7 h-7 rounded-lg bg-violet-600/20 flex items-center justify-center shrink-0 mt-1">
                <Bot className="w-4 h-4 text-violet-400" />
              </div>
            )}

            <div
              className={`max-w-[85%] ${
                msg.role === "user"
                  ? "bg-violet-600 rounded-2xl rounded-tr-sm px-4 py-2.5"
                  : "flex-1"
              }`}
            >
              {msg.role === "user" ? (
                <p className="text-sm text-white whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <div>
                  {/* Tool calls */}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="mb-3 space-y-1">
                      {msg.toolCalls.map((tc, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 text-xs text-gray-500"
                        >
                          <Wrench className="w-3 h-3" />
                          <span>{formatToolName(tc.name)}</span>
                          {msg.toolResults?.find((r) => r.id === tc.id) ? (
                            <span className="text-green-500">done</span>
                          ) : msg.isStreaming ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Content */}
                  {msg.content && (
                    <div className="prose prose-sm prose-invert max-w-none prose-table:text-xs prose-th:bg-gray-800/50 prose-th:px-3 prose-th:py-1.5 prose-td:px-3 prose-td:py-1.5 prose-th:text-left prose-table:border-collapse prose-th:border prose-th:border-gray-700 prose-td:border prose-td:border-gray-800">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  )}

                  {/* Streaming indicator */}
                  {msg.isStreaming && !msg.content && (
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Analyse en cours...</span>
                    </div>
                  )}

                  {/* Actions */}
                  {msg.content && !msg.isStreaming && (
                    <div className="flex items-center gap-1 mt-3">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleCopy(msg.id, msg.content)}
                        title="Copier"
                      >
                        {copiedId === msg.id ? (
                          <Check className="w-3 h-3 text-green-400" />
                        ) : (
                          <Copy className="w-3 h-3 text-gray-500" />
                        )}
                      </Button>
                      {msg.usage && (
                        <span className="text-[10px] text-gray-600 ml-auto">
                          {(msg.usage.duration / 1000).toFixed(1)}s
                        </span>
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
        <div className="flex items-end gap-2 max-w-4xl mx-auto">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Demande des données, des analyses, des tableaux..."
              rows={1}
              className="w-full resize-none bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 pr-12 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-violet-600 transition-colors"
              style={{ minHeight: "44px", maxHeight: "120px" }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement
                target.style.height = "auto"
                target.style.height = Math.min(target.scrollHeight, 120) + "px"
              }}
            />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!input.trim() || isLoading}
            size="icon"
            className="bg-violet-600 hover:bg-violet-700 rounded-xl h-11 w-11 shrink-0"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
