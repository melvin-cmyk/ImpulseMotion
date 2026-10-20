"use client";

/**
 * Two-column chat of the private client bot.
 *   left  — the user's conversations (new / open / delete), with a pulse on
 *           the ones where a reply is being produced
 *   right — messages (Markdown), the live reply, tool indicator, input
 *
 * A turn is detached (lib/ai-jobs.ts): POST /api/bot/[id]/chat starts it and
 * answers a job id; the reply is produced by the relay whatever happens here
 * and stored by the server. This component only follows it (GET
 * /api/ai/jobs/[jobId]/events) to show it live — on several conversations at
 * once if need be — and reloads the thread when it is over. Leaving the page
 * stops the following, never the reply.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { SAFE_MD_COMPONENTS } from "@/components/ai/safe-image";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Bot, Loader2, MessageSquare, Plus, Send, Square, Trash2 } from "lucide-react";
import type { BotMessage, BotSources } from "@/lib/bot-types";
import { AI_JOB_FINISHED_EVENT, AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent, type PublicAiJob } from "@/lib/ai-job-client";
import { useAiJobs } from "@/components/ai-jobs-watcher";

type ConversationRow = { id: string; title: string | null; updatedAt: string; jobId?: string | null };
type UiMessage = Pick<BotMessage, "role" | "content">;
/** Live state of a reply being produced on one conversation. */
type Run = { jobId: string; text: string; toolNote: string | null; stopping?: boolean };

const SOURCE_LABELS: Array<[keyof BotSources, string]> = [
  ["data", "Commandes e-commerce"],
  ["meta", "Meta Ads"],
  ["google", "Google Ads"],
  ["tiktok", "TikTok Ads"],
  ["ga4PropertyId", "Google Analytics"],
];

function friendlyTool(name: string | undefined): string {
  const n = String(name ?? "");
  if (n.startsWith("mcp__client-data__") || n.startsWith("data_")) return "Consultation des commandes…";
  if (n.startsWith("mcp__meta-ads")) return "Consultation de Meta Ads…";
  if (n.startsWith("mcp__mcp-google-ads")) return "Consultation de Google Ads…";
  if (n.startsWith("mcp__mcp-tiktok-ads")) return "Consultation de TikTok Ads…";
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
  enabled = true,
  accessCount = 0,
  initialConversations,
  initialActiveId = null,
}: {
  botId: string;
  botName: string;
  dashboardName: string;
  sources: BotSources;
  suggestions: string[];
  isStaff: boolean;
  /** Staff only: a disabled bot is reachable in test mode, invisible to clients. */
  enabled?: boolean;
  /** Staff only: number of client accesses (0 → clients cannot reach it yet). */
  accessCount?: number;
  initialConversations: ConversationRow[];
  /** Thread to open first (?c= in the URL), else the most recent one. */
  initialActiveId?: string | null;
}) {
  const [conversations, setConversations] = useState<ConversationRow[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(initialActiveId ?? initialConversations[0]?.id ?? null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [input, setInput] = useState("");
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followers = useRef<Map<string, AbortController>>(new Map());
  const activeRef = useRef<string | null>(activeId);
  activeRef.current = activeId;
  const jobs = useAiJobs();

  const base = `/api/bot/${botId}`;
  const activeRun = activeId ? runs[activeId] : undefined;
  const busy = !!activeRun || sending;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun?.text, activeRun?.toolNote]);

  // Leaving the page stops the following only: the replies go on in the relay.
  useEffect(() => {
    const map = followers.current;
    return () => { for (const ctl of map.values()) ctl.abort(); map.clear(); };
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const r = await fetch(`${base}/conversations`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { conversations: ConversationRow[] };
      setConversations(j.conversations);
    } catch { /* best effort */ }
  }, [base]);

  const loadThread = useCallback(async (id: string): Promise<PublicAiJob | null> => {
    const r = await fetch(`${base}/conversations/${id}`, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "Conversation introuvable" : `Erreur ${r.status}`);
    const j = (await r.json()) as { conversation: { messages: BotMessage[] }; job: PublicAiJob | null };
    if (activeRef.current === id) setMessages(j.conversation.messages.map(({ role, content }) => ({ role, content })));
    return j.job;
  }, [base]);

  /** Follows a reply being produced on `conversationId`; one follower per thread. */
  const follow = useCallback((conversationId: string, jobId: string) => {
    if (followers.current.has(conversationId)) return;
    const ctl = new AbortController();
    followers.current.set(conversationId, ctl);
    setRuns((prev) => (prev[conversationId]?.jobId === jobId ? prev : { ...prev, [conversationId]: { jobId, text: "", toolNote: null } }));
    jobs.ignore(jobId);
    const patch = (fn: (run: Run) => Run) => setRuns((prev) => (prev[conversationId] ? { ...prev, [conversationId]: fn(prev[conversationId]) } : prev));
    const onEvent = (event: JobEvent) => {
      if (event.type === "delta" && typeof event.text === "string") patch((r) => ({ ...r, text: r.text + event.text, toolNote: null }));
      else if (event.type === "content" && typeof event.text === "string") patch((r) => (r.text ? r : { ...r, text: event.text as string }));
      else if (event.type === "tool_call") patch((r) => ({ ...r, toolNote: friendlyTool(event.name) }));
      else if (event.type === "tool_result") patch((r) => ({ ...r, toolNote: null }));
      else if (event.type === "error" && activeRef.current === conversationId) setError(String(event.message ?? "Réponse interrompue"));
    };
    void followJob(jobId, onEvent, ctl.signal)
      .then(async (outcome) => {
        if (outcome === "aborted") return;
        followers.current.delete(conversationId);
        if (outcome === "unknown") {
          // The relay no longer knows the job: the server gives it up after a
          // few minutes (reconciliation); the thread is reloaded then.
          if (activeRef.current === conversationId) setError("Le suivi de la réponse a été perdu. La conversation se mettra à jour d'elle-même.");
        }
        setRuns((prev) => { const next = { ...prev }; delete next[conversationId]; return next; });
        if (activeRef.current === conversationId) {
          try { await loadThread(conversationId); } catch { /* the list below shows it */ }
        }
        void refreshList();
        jobs.refresh();
      })
      .catch((e) => {
        followers.current.delete(conversationId);
        setRuns((prev) => { const next = { ...prev }; delete next[conversationId]; return next; });
        if (activeRef.current === conversationId) setError(e instanceof Error ? e.message : "Suivi interrompu");
      });
  }, [jobs, loadThread, refreshList]);

  // Replies already being produced when the page opens (another tab, a reload).
  useEffect(() => {
    for (const c of initialConversations) if (c.jobId) follow(c.id, c.jobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the active thread's messages (and follow its reply, if one is being produced).
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    let cancelled = false;
    setLoadingThread(true);
    setError(null);
    loadThread(activeId)
      .then((job) => { if (!cancelled && job) follow(activeId, job.id); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Erreur"); })
      .finally(() => { if (!cancelled) setLoadingThread(false); });
    return () => { cancelled = true; };
  }, [activeId, follow, loadThread]);

  // A reply that ended while this page was not following it (watcher).
  useEffect(() => {
    const onFinished = (e: Event) => {
      const job = (e as CustomEvent<PublicAiJob>).detail;
      if (!job || job.botId !== botId) return;
      void refreshList();
      if (job.conversationId === activeRef.current && !followers.current.has(job.conversationId)) void loadThread(job.conversationId).catch(() => undefined);
    };
    window.addEventListener(AI_JOB_FINISHED_EVENT, onFinished);
    return () => window.removeEventListener(AI_JOB_FINISHED_EVENT, onFinished);
  }, [botId, loadThread, refreshList]);

  function newConversation() {
    setActiveId(null);
    setMessages([]);
    setError(null);
    setInput("");
    inputRef.current?.focus();
  }

  async function removeConversation(id: string) {
    if (runs[id]) return; // a reply is being produced on it
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
    activeRef.current = j.conversation.id;
    return j.conversation.id;
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const previous = messages;
    setMessages([...previous, { role: "user", content }]);
    setInput("");
    setSending(true);
    setError(null);
    try {
      const conversationId = await ensureConversation();
      const res = await fetch(`${base}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: content }),
      });
      const j = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (res.status === 409 && j.jobId) { follow(conversationId, j.jobId); return; }
      if (!res.ok || !j.jobId) throw new Error(j.error ?? `Erreur ${res.status}`);
      follow(conversationId, j.jobId);
      window.dispatchEvent(new Event(AI_JOB_STARTED_EVENT));
      void refreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
      setMessages(previous);
      setInput(content);
    } finally {
      setSending(false);
    }
  }

  async function stopActive() {
    if (!activeId || !activeRun || activeRun.stopping) return;
    setRuns((prev) => (prev[activeId] ? { ...prev, [activeId]: { ...prev[activeId], stopping: true } } : prev));
    try { await stopJob(activeRun.jobId); }
    catch (e) { setError(e instanceof Error ? e.message : "Arrêt impossible"); }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  const enabledSources = SOURCE_LABELS.filter(([k]) => !!sources[k]).map(([, label]) => label);
  const showSuggestions = messages.length === 0 && !activeRun && !loadingThread && !sending;
  const runningCount = Object.keys(runs).length;

  return (
    <div className="flex h-full min-h-0 bg-gray-950 text-gray-100">
      {/* Conversations */}
      <aside className="w-64 shrink-0 border-r border-gray-800 flex flex-col min-h-0">
        <div className="p-3 border-b border-gray-800">
          <button
            type="button"
            onClick={newConversation}
            className="w-full flex items-center justify-center gap-2 text-sm font-medium bg-violet-600 hover:bg-violet-500 text-white rounded-lg px-3 py-2 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Nouvelle conversation
          </button>
          {runningCount > 0 && (
            <p className="text-[11px] text-violet-300 mt-2 px-1">
              {runningCount} réponse{runningCount > 1 ? "s" : ""} en cours — vous pouvez changer de conversation ou de page.
            </p>
          )}
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {conversations.length === 0 && (
            <p className="text-xs text-gray-600 px-4 py-3">Vos conversations apparaîtront ici.</p>
          )}
          {conversations.map((c) => {
            const active = c.id === activeId;
            const running = !!runs[c.id];
            return (
              <div
                key={c.id}
                className={`group flex items-start gap-2 px-3 py-2 mx-2 rounded-lg cursor-pointer ${active ? "bg-gray-800 text-white" : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"}`}
                onClick={() => setActiveId(c.id)}
              >
                {running
                  ? <Loader2 className="w-4 h-4 mt-0.5 shrink-0 text-violet-400 animate-spin" aria-label="Réponse en cours" />
                  : <MessageSquare className="w-4 h-4 mt-0.5 shrink-0 text-gray-600" />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{c.title || "Nouvelle conversation"}</div>
                  <div className="text-[11px] text-gray-600">{running ? "Réponse en cours…" : fmtDate(c.updatedAt)}</div>
                </div>
                {!running && (
                  <button
                    type="button"
                    aria-label="Supprimer"
                    onClick={(e) => { e.stopPropagation(); void removeConversation(c.id); }}
                    className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-opacity"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
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
          </div>
        </header>

        {isStaff && !enabled && (
          <div className="px-5 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 text-xs flex items-center gap-2 shrink-0">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Assistant inactif : invisible pour les clients, mode test
          </div>
        )}
        {isStaff && enabled && accessCount === 0 && (
          <div className="px-5 py-1.5 border-b border-gray-800 text-gray-500 text-[11px] shrink-0">
            Aucun accès client sur cet assistant : seul le staff peut l&apos;ouvrir pour l&apos;instant.
          </div>
        )}

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
                    Vous pouvez changer de page pendant que je travaille : la réponse vous attendra ici.
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
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={SAFE_MD_COMPONENTS}>{m.content}</ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {(activeRun || sending) && (
              <div className="flex justify-start">
                <div className="max-w-[90%] bg-gray-900 border border-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
                  {activeRun?.text ? (
                    <div className="prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-table:text-xs prose-th:text-gray-300 prose-headings:text-white">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={SAFE_MD_COMPONENTS}>{activeRun.text}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500 flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {activeRun?.stopping ? "Arrêt…" : activeRun?.toolNote ?? "Réflexion…"}
                    </div>
                  )}
                  {activeRun?.text && (activeRun.toolNote || activeRun.stopping) && (
                    <div className="text-[11px] text-gray-500 mt-2 flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {activeRun.stopping ? "Arrêt…" : activeRun.toolNote}
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
              placeholder={activeRun ? "Réponse en cours sur cette conversation — ouvrez-en une autre pour poser une nouvelle question." : "Posez votre question… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)"}
              className="flex-1 resize-none bg-gray-900 border border-gray-800 focus:border-violet-500 focus:outline-none rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-gray-600 max-h-40 disabled:opacity-60"
            />
            {activeRun ? (
              <button
                type="button"
                onClick={() => void stopActive()}
                disabled={activeRun.stopping}
                aria-label="Arrêter la réponse"
                title="Arrêter la réponse"
                className="h-10 w-10 flex items-center justify-center rounded-xl bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white transition-colors"
              >
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => send(input)}
                disabled={busy || !input.trim()}
                aria-label="Envoyer"
                className="h-10 w-10 flex items-center justify-center rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white transition-colors"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            )}
          </div>
          <p className="max-w-3xl mx-auto text-[11px] text-gray-600 mt-1.5">
            L&apos;assistant est en lecture seule et n&apos;agit jamais sur vos campagnes. Les réponses peuvent contenir des erreurs : vérifiez les chiffres importants avec votre équipe Impulse Analytics.
          </p>
        </div>
      </section>
    </div>
  );
}
