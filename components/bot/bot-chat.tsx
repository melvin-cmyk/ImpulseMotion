"use client";

/**
 * Two-column chat of the private client bot.
 *   left  — the user's conversations (new / open / delete)
 *   right — messages (Markdown), streaming answer, tool indicator, input
 *
 * Persistence is server-side: POST /api/bot/[id]/chat appends the user and
 * assistant messages itself when the stream ends, so the browser only mirrors
 * what the server will have stored.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Loader2, MessageSquare, Plus, Send, Trash2 } from "lucide-react";
import type { BotMessage, BotSources } from "@/lib/bot-types";

type ConversationRow = { id: string; title: string | null; updatedAt: string };
type UiMessage = Pick<BotMessage, "role" | "content">;

const SOURCE_LABELS: Array<[keyof BotSources, string]> = [
  ["data", "Commandes e-commerce"],
  ["meta", "Meta Ads"],
  ["google", "Google Ads"],
  ["ga4PropertyId", "Google Analytics"],
];

function friendlyTool(name: string | undefined): string {
  const n = String(name ?? "");
  if (n.startsWith("mcp__client-data__") || n.startsWith("data_")) return "Consultation des commandes…";
  if (n.startsWith("mcp__meta-ads")) return "Consultation de Meta Ads…";
  if (n.startsWith("mcp__mcp-google-ads")) return "Consultation de Google Ads…";
  if (n.startsWith("mcp__mcp-google-analytics")) return "Consultation de Google Analytics…";
  return "Consultation des données…";
}

function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
}

export function BotChat({
  botId,
  botName,
  dashboardName,
  sources,
  suggestions,
  isStaff,
  initialConversations,
}: {
  botId: string;
  botName: string;
  dashboardName: string;
  sources: BotSources;
  suggestions: string[];
  isStaff: boolean;
  initialConversations: ConversationRow[];
}) {
  const [conversations, setConversations] = useState<ConversationRow[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(initialConversations[0]?.id ?? null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const base = `/api/bot/${botId}`;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Load the active thread's messages.
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    let cancelled = false;
    setLoadingThread(true);
    setError(null);
    fetch(`${base}/conversations/${activeId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "Conversation introuvable" : `Erreur ${r.status}`);
        const j = (await r.json()) as { conversation: { messages: BotMessage[] } };
        if (!cancelled) setMessages(j.conversation.messages.map(({ role, content }) => ({ role, content })));
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Erreur"); })
      .finally(() => { if (!cancelled) setLoadingThread(false); });
    return () => { cancelled = true; };
  }, [activeId, base]);

  const refreshList = useCallback(async () => {
    try {
      const r = await fetch(`${base}/conversations`);
      if (!r.ok) return;
      const j = (await r.json()) as { conversations: ConversationRow[] };
      setConversations(j.conversations);
    } catch { /* best effort */ }
  }, [base]);

  function newConversation() {
    if (busy) return;
    abortRef.current?.abort();
    setActiveId(null);
    setMessages([]);
    setError(null);
    setInput("");
    inputRef.current?.focus();
  }

  async function removeConversation(id: string) {
    if (busy) return;
    if (!window.confirm("Supprimer cette conversation ?")) return;
    try {
      const r = await fetch(`${base}/conversations/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`Erreur ${r.status}`);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) { setActiveId(null); setMessages([]); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suppression impossible");
    }
  }

  async function ensureConversation(): Promise<string> {
    if (activeId) return activeId;
    const r = await fetch(`${base}/conversations`, { method: "POST" });
    if (!r.ok) throw new Error("Impossible de créer la conversation");
    const j = (await r.json()) as { conversation: ConversationRow };
    setConversations((prev) => [j.conversation, ...prev]);
    setActiveId(j.conversation.id);
    return j.conversation.id;
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const previous = messages;
    setMessages([...previous, { role: "user", content }]);
    setInput("");
    setBusy(true);
    setError(null);
    setStreamText("");
    setToolNote(null);

    const ctl = new AbortController();
    abortRef.current = ctl;
    let acc = "";
    let sawDone = false;
    try {
      const conversationId = await ensureConversation();
      const res = await fetch(`${base}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: content }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `Erreur ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          let event: { type?: string; text?: string; name?: string; message?: string };
          try { event = JSON.parse(trimmed.slice(5).trim()); } catch { continue; }
          if (event.type === "delta" && typeof event.text === "string") { acc += event.text; setStreamText(acc); setToolNote(null); }
          else if (event.type === "content" && typeof event.text === "string" && !acc) { acc = event.text; setStreamText(acc); }
          else if (event.type === "tool_call") setToolNote(friendlyTool(event.name));
          else if (event.type === "tool_result") setToolNote(null);
          else if (event.type === "done") sawDone = true;
          else if (event.type === "error") {
            if (!acc.trim()) throw new Error(String(event.message ?? "L'assistant n'a pas pu répondre"));
            setError(String(event.message ?? "Réponse interrompue"));
          }
        }
      }
      if (!acc.trim()) throw new Error("Réponse vide — réessayez");
      const answer = acc.trim() + (sawDone ? "" : "\n\n_(réponse possiblement tronquée)_");
      setMessages([...previous, { role: "user", content }, { role: "assistant", content: answer }]);
      void refreshList();
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Erreur");
      setMessages(previous);
      setInput(content);
    } finally {
      setBusy(false);
      setStreamText(null);
      setToolNote(null);
      abortRef.current = null;
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  const enabledSources = SOURCE_LABELS.filter(([k]) => !!sources[k]).map(([, label]) => label);
  const showSuggestions = messages.length === 0 && streamText === null && !loadingThread;

  return (
    <div className="flex h-full min-h-0 bg-gray-950 text-gray-100">
      {/* Conversations */}
      <aside className="w-64 shrink-0 border-r border-gray-800 flex flex-col min-h-0">
        <div className="p-3 border-b border-gray-800">
          <button
            type="button"
            onClick={newConversation}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 text-sm font-medium bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-lg px-3 py-2 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Nouvelle conversation
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {conversations.length === 0 && (
            <p className="text-xs text-gray-600 px-4 py-3">Vos conversations apparaîtront ici.</p>
          )}
          {conversations.map((c) => {
            const active = c.id === activeId;
            return (
              <div
                key={c.id}
                className={`group flex items-start gap-2 px-3 py-2 mx-2 rounded-lg cursor-pointer ${active ? "bg-gray-800 text-white" : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"}`}
                onClick={() => { if (!busy) setActiveId(c.id); }}
              >
                <MessageSquare className="w-4 h-4 mt-0.5 shrink-0 text-gray-600" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{c.title || "Nouvelle conversation"}</div>
                  <div className="text-[11px] text-gray-600">{fmtDate(c.updatedAt)}</div>
                </div>
                <button
                  type="button"
                  aria-label="Supprimer"
                  onClick={(e) => { e.stopPropagation(); void removeConversation(c.id); }}
                  className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-opacity"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Chat */}
      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="h-12 px-5 border-b border-gray-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-violet-500/15 text-violet-400 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white truncate">{botName}</div>
              <div className="text-[11px] text-gray-500 truncate">{dashboardName}</div>
            </div>
            <span
              className="hidden md:inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
              title="Cet assistant ne lit que les données de votre espace. Les réponses sont générées sur Amazon Bedrock (AWS, région Europe), dans un environnement dédié."
            >
              Espace privé · IA hébergée sur AWS Bedrock (UE)
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-gray-500">
            {enabledSources.length > 0 ? <span className="hidden sm:inline">{enabledSources.join(" · ")}</span> : <span>Aucune source branchée</span>}
            {isStaff && (
              <Link href="/bot" className="text-violet-300 hover:text-white">Tous les assistants</Link>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="max-w-3xl mx-auto space-y-4">
            {loadingThread && (
              <div className="text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Chargement…</div>
            )}
            {showSuggestions && (
              <div className="pt-6 space-y-4">
                <div>
                  <h2 className="text-lg font-semibold text-white">Bonjour, comment puis-je vous aider ?</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    Posez une question sur vos performances. Je réponds à partir de vos données, avec la source et la période utilisées.
                  </p>
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      className="text-left text-sm px-4 py-3 rounded-xl bg-gray-900 border border-gray-800 text-gray-300 hover:border-violet-500 hover:text-white transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                {m.role === "user" ? (
                  <div className="max-w-[80%] bg-violet-600 text-white text-sm px-4 py-2.5 rounded-2xl rounded-br-sm whitespace-pre-wrap">{m.content}</div>
                ) : (
                  <div className="max-w-[90%] bg-gray-900 border border-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
                    <div className="prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-table:text-xs prose-th:text-gray-300 prose-headings:text-white">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {streamText !== null && (
              <div className="flex justify-start">
                <div className="max-w-[90%] bg-gray-900 border border-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
                  {streamText ? (
                    <div className="prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-table:text-xs prose-th:text-gray-300 prose-headings:text-white">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamText}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500 flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {toolNote ?? "Réflexion…"}
                    </div>
                  )}
                  {streamText && toolNote && (
                    <div className="text-[11px] text-gray-500 mt-2 flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {toolNote}
                    </div>
                  )}
                </div>
              </div>
            )}
            {error && (
              <div className="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2">{error}</div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t border-gray-800 px-5 py-3 shrink-0">
          <div className="max-w-3xl mx-auto flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              disabled={busy}
              placeholder="Posez votre question… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)"
              className="flex-1 resize-none bg-gray-900 border border-gray-800 focus:border-violet-500 focus:outline-none rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-gray-600 max-h-40 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => send(input)}
              disabled={busy || !input.trim()}
              aria-label="Envoyer"
              className="h-10 w-10 flex items-center justify-center rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white transition-colors"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
          <p className="max-w-3xl mx-auto text-[11px] text-gray-600 mt-1.5">
            L&apos;assistant est en lecture seule et n&apos;agit jamais sur vos campagnes. Les réponses peuvent contenir des erreurs : vérifiez les chiffres importants avec votre équipe Impulse Analytics.
          </p>
        </div>
      </section>
    </div>
  );
}
