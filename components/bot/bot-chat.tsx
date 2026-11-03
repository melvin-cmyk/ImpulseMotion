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
import { AlertTriangle, ArrowUp, ArrowUpRight, BarChart3, FileSpreadsheet, Globe, Images, Loader2, MessageSquare, Plus, ShieldCheck, ShoppingBag, Sparkles, Square, Trash2 } from "lucide-react";
import { LogoMark } from "@/components/brand/logo-mark";
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
  ["files", "Fichiers"],
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

  const enabledSources = SOURCE_LABELS.filter(([k]) => !!sources[k]);
  const showSuggestions = messages.length === 0 && !activeRun && !loadingThread && !sending;
  const runningCount = Object.keys(runs).length;

  return (
    <div className="flex h-full min-h-0 bg-[#09090f] text-gray-100">
      {/* Conversations */}
      <aside className="hidden md:flex w-72 shrink-0 border-r border-white/[0.06] bg-white/[0.015] flex-col min-h-0">
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-3">
            <LogoMark size={36} />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white truncate">{botName}</div>
              <div className="text-xs text-gray-500 truncate">{dashboardName}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={newConversation}
            className="w-full flex items-center justify-center gap-2 text-sm font-medium bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500 text-white rounded-xl px-3 py-2.5 shadow-lg shadow-violet-900/30 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Nouvelle conversation
          </button>
          {runningCount > 0 && (
            <p className="text-[11px] text-violet-300/90 px-1">
              {runningCount} réponse{runningCount > 1 ? "s" : ""} en cours — vous pouvez changer de conversation ou de page.
            </p>
          )}
        </div>
        <div className="px-5 pb-1 text-[11px] font-medium uppercase tracking-wider text-gray-600">Historique</div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 && (
            <p className="text-xs text-gray-600 px-3 py-3">Vos conversations apparaîtront ici.</p>
          )}
          {conversations.map((c) => {
            const active = c.id === activeId;
            const running = !!runs[c.id];
            return (
              <div
                key={c.id}
                className={`group relative flex items-start gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer transition-colors ${active ? "bg-white/[0.07] text-white" : "text-gray-400 hover:bg-white/[0.04] hover:text-gray-200"}`}
                onClick={() => setActiveId(c.id)}
              >
                {active && <span className="absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-violet-400" />}
                {running
                  ? <Loader2 className="w-4 h-4 mt-0.5 shrink-0 text-violet-400 animate-spin" aria-label="Réponse en cours" />
                  : <MessageSquare className={`w-4 h-4 mt-0.5 shrink-0 ${active ? "text-violet-300" : "text-gray-600"}`} />}
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
        <div className="m-3 rounded-xl border border-emerald-500/15 bg-emerald-500/[0.05] px-3 py-2.5 flex gap-2.5" title="Cet assistant ne lit que les données de votre espace. Les réponses sont générées sur Amazon Bedrock (AWS, région Europe), dans un environnement dédié.">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <p className="text-[11px] leading-snug text-emerald-200/80">Espace privé : uniquement vos données, IA hébergée en Europe (AWS Bedrock).</p>
        </div>
      </aside>

      {/* Chat */}
      <section className="relative flex-1 flex flex-col min-w-0 min-h-0">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.14),transparent_70%)]" />
        <header className="relative h-14 px-5 border-b border-white/[0.06] flex items-center justify-between gap-3 shrink-0 backdrop-blur">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="md:hidden"><LogoMark size={28} /></span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white truncate flex items-center gap-2">
                {botName}
                <span className="inline-flex items-center gap-1 text-[11px] font-normal text-emerald-300"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />en ligne</span>
              </div>
              <div className="text-[11px] text-gray-500 truncate">Lecture seule · données de {dashboardName}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 overflow-hidden">
            {enabledSources.length > 0 ? enabledSources.map(([k, label]) => (
              <span key={k} className="hidden lg:inline-flex items-center gap-1.5 text-[11px] text-gray-300 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 whitespace-nowrap">
                <span className={`w-1.5 h-1.5 rounded-full ${SOURCE_DOT[k] ?? "bg-gray-400"}`} />{label}
              </span>
            )) : <span className="text-[11px] text-gray-500">Aucune source branchée</span>}
            <button type="button" onClick={newConversation} aria-label="Nouvelle conversation" className="md:hidden h-8 w-8 flex items-center justify-center rounded-lg bg-white/[0.06] text-white"><Plus className="w-4 h-4" /></button>
          </div>
        </header>

        {isStaff && !enabled && (
          <div className="relative px-5 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 text-xs flex items-center gap-2 shrink-0">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Assistant inactif : invisible pour les clients, mode test
          </div>
        )}
        {isStaff && enabled && accessCount === 0 && (
          <div className="relative px-5 py-1.5 border-b border-white/[0.06] text-gray-500 text-[11px] shrink-0">
            Aucun accès client sur cet assistant : seul le staff peut l&apos;ouvrir pour l&apos;instant.
          </div>
        )}

        <div className="relative flex-1 overflow-y-auto px-4 sm:px-6 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {loadingThread && (
              <div className="text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Chargement…</div>
            )}
            {showSuggestions && (
              <div className="pt-6 sm:pt-14 flex flex-col items-center text-center">
                <LogoMark size={56} />
                <h2 className="mt-5 text-2xl sm:text-3xl font-semibold tracking-tight bg-gradient-to-b from-white to-gray-400 bg-clip-text text-transparent">
                  Bonjour, que voulez-vous savoir ?
                </h2>
                <p className="mt-2 max-w-lg text-sm text-gray-500">
                  Vos performances, vos meilleures créas avec leurs visuels, votre trafic : je réponds à partir de vos données, avec la source et la période.
                </p>
                <div className="mt-8 w-full grid sm:grid-cols-2 gap-3 text-left">
                  {suggestions.map((s) => {
                    const Icon = suggestionIcon(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => send(s)}
                        className="group flex items-start gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] px-4 py-3.5 text-sm text-gray-300 hover:border-violet-500/50 hover:bg-violet-500/[0.06] hover:text-white transition-colors"
                      >
                        <span className="mt-0.5 h-7 w-7 shrink-0 rounded-lg bg-violet-500/10 text-violet-300 flex items-center justify-center group-hover:bg-violet-500/20"><Icon className="w-4 h-4" /></span>
                        <span className="flex-1">{s}</span>
                        <ArrowUpRight className="w-4 h-4 mt-0.5 shrink-0 text-gray-600 group-hover:text-violet-300" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] bg-gradient-to-br from-violet-500 to-purple-600 text-white text-sm px-4 py-2.5 rounded-2xl rounded-br-md shadow-lg shadow-violet-950/40 whitespace-pre-wrap">{m.content}</div>
                </div>
              ) : (
                <div key={i} className="flex gap-3">
                  <span className="mt-0.5"><LogoMark size={28} /></span>
                  <div className={`min-w-0 flex-1 ${PROSE}`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={SAFE_MD_COMPONENTS}>{m.content}</ReactMarkdown>
                  </div>
                </div>
              )
            ))}
            {(activeRun || sending) && (
              <div className="flex gap-3">
                <span className="mt-0.5"><LogoMark size={28} /></span>
                <div className="min-w-0 flex-1">
                  {activeRun?.text ? (
                    <div className={PROSE}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={SAFE_MD_COMPONENTS}>{activeRun.text}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="inline-flex items-center gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-2.5 text-sm text-gray-400">
                      <TypingDots />
                      {activeRun?.stopping ? "Arrêt…" : activeRun?.toolNote ?? "Analyse de vos données…"}
                    </div>
                  )}
                  {activeRun?.text && (activeRun.toolNote || activeRun.stopping) && (
                    <div className="text-[11px] text-gray-500 mt-2 flex items-center gap-2">
                      <TypingDots />
                      {activeRun.stopping ? "Arrêt…" : activeRun.toolNote}
                    </div>
                  )}
                </div>
              </div>
            )}
            {error && (
              <div className="text-xs text-red-300 bg-red-950/30 border border-red-900/40 rounded-xl px-3 py-2">{error}</div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="relative px-4 sm:px-6 pb-4 pt-2 shrink-0">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-end gap-2 rounded-2xl border border-white/[0.09] bg-white/[0.03] p-2 pl-4 shadow-2xl shadow-black/40 focus-within:border-violet-500/60 focus-within:ring-4 focus-within:ring-violet-500/10 transition">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; }}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={busy}
                placeholder={activeRun ? "Réponse en cours sur cette conversation — ouvrez-en une autre pour poser une nouvelle question." : "Posez votre question… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)"}
                className="flex-1 resize-none bg-transparent py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none max-h-40 disabled:opacity-60"
              />
              {activeRun ? (
                <button
                  type="button"
                  onClick={() => void stopActive()}
                  disabled={activeRun.stopping}
                  aria-label="Arrêter la réponse"
                  title="Arrêter la réponse"
                  className="h-9 w-9 shrink-0 flex items-center justify-center rounded-xl bg-white/10 hover:bg-white/15 disabled:opacity-40 text-white transition-colors"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => send(input)}
                  disabled={busy || !input.trim()}
                  aria-label="Envoyer"
                  className="h-9 w-9 shrink-0 flex items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500 disabled:opacity-30 text-white transition-colors"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
                </button>
              )}
            </div>
            <p className="text-center text-[11px] text-gray-600 mt-2">
              Lecture seule : l&apos;assistant n&apos;agit jamais sur vos campagnes. Vérifiez les chiffres importants avec votre équipe Impulse Analytics.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

const PROSE = "prose prose-invert prose-sm max-w-none text-gray-200 prose-p:my-2 prose-p:leading-relaxed prose-strong:text-white prose-headings:text-white prose-headings:font-semibold prose-a:text-violet-300 prose-li:my-0.5 prose-table:my-3 prose-table:text-xs prose-table:border prose-table:border-white/10 prose-thead:bg-white/[0.04] prose-th:px-3 prose-th:py-2 prose-th:text-gray-300 prose-td:px-3 prose-td:py-1.5 prose-tr:border-white/[0.06] prose-img:my-3";

const SOURCE_DOT: Partial<Record<keyof BotSources, string>> = {
  data: "bg-emerald-400", meta: "bg-sky-400", google: "bg-amber-400", tiktok: "bg-pink-400", ga4PropertyId: "bg-orange-400", files: "bg-teal-400",
};

function suggestionIcon(text: string) {
  const t = text.toLowerCase();
  if (/créa|visuel|vidéo/.test(t)) return Images;
  if (/trafic|source/.test(t)) return Globe;
  if (/chiffre d'affaires|commande|produit|client/.test(t)) return ShoppingBag;
  if (/fichier/.test(t)) return FileSpreadsheet;
  if (/meta|google|tiktok|campagne|coût|compare/.test(t)) return BarChart3;
  return Sparkles;
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {[0, 150, 300].map((d) => <span key={d} className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
    </span>
  );
}
