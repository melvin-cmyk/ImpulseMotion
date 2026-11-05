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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { SAFE_MD_COMPONENTS } from "@/components/ai/safe-image";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpRight, Mic, BarChart3, FileSpreadsheet, Globe, Images, Loader2, MessageSquare, Plus, ShieldCheck, ShoppingBag, Square, Trash2 } from "lucide-react";
import { botPersonaName, type BotMessage, type BotSources } from "@/lib/bot-types";
import { AI_JOB_FINISHED_EVENT, AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent, type PublicAiJob } from "@/lib/ai-job-client";
import { useAiJobs } from "@/components/ai-jobs-watcher";
import { AttachFileButton, BotFilesList, useBotFiles } from "@/components/bot/bot-files";
import { useVoice } from "@/components/mo/use-voice";
import { BotFeedbackBox } from "@/components/bot/bot-feedback";
import { BotTable } from "@/components/bot/bot-table";
import { BotCreativeCards, looksLikeCreatives } from "@/components/bot/bot-creative-cards";

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
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the reply only while the reader is at the bottom: scrolling up to
  // read stops the follow, the ↓ button (or sending) brings it back.
  const stickRef = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followers = useRef<Map<string, AbortController>>(new Map());
  const activeRef = useRef<string | null>(activeId);
  activeRef.current = activeId;
  const jobs = useAiJobs();

  const base = `/api/bot/${botId}`;
  const activeRun = activeId ? runs[activeId] : undefined;
  const busy = !!activeRun || sending;
  const filesOn = !!sources.files;
  const botFiles = useBotFiles(botId, filesOn);

  // Dictation: click to talk, click again to stop; the text lands in the box
  // (appended), to read over before sending. Transcribed on the relay only.
  const voice = useVoice(
    (text) => {
      setInput((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      });
    },
    { sttUrl: `/api/bot/${botId}/stt`, liveRecognition: false, tooShortHint: "Je n'ai rien entendu : cliquez sur le micro, parlez, puis cliquez à nouveau pour arrêter." },
  );

  async function onImport(file: File) {
    const name = await botFiles.importFile(file);
    if (name && !input.trim()) {
      setInput(`Analyse le fichier « ${name} » que je viens d'importer : que contient-il et quels sont les points clés ?`);
      inputRef.current?.focus();
    }
  }

  function scrollToBottom(smooth = false) {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setAwayFromBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = atBottom;
    setAwayFromBottom(!atBottom);
  }

  // Inside the chat pane only (scrollIntoView also moved the page), and only when following.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, activeRun?.text, activeRun?.toolNote]);

  // Opening another conversation starts at its latest message.
  // (the scroll event fired by the jump then clears the ↓ button by itself)
  useEffect(() => { stickRef.current = true; }, [activeId]);

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
    stickRef.current = true;
    setAwayFromBottom(false);
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

  // Tables of the replies carry « Ouvrir dans Google Sheets », named after the conversation.
  const activeTitle = conversations.find((c) => c.id === activeId)?.title || dashboardName;
  const mdComponents = useMemo(() => ({
    ...SAFE_MD_COMPONENTS,
    table: ({ children }: { children?: React.ReactNode }) => <BotTable botId={botId} title={activeTitle}>{children}</BotTable>,
    // ```creas block → grid of creative cards (components/bot/bot-creative-cards.tsx).
    pre: ({ node, children, ...rest }: React.HTMLAttributes<HTMLPreElement> & { node?: MdNode }) => {
      const code = node?.children?.[0];
      const cls = code?.properties?.className;
      const lang = Array.isArray(cls) ? String(cls.find((c) => String(c).startsWith("language-")) ?? "").replace("language-", "") : "";
      const text = (code?.children ?? []).map((c) => c.value ?? "").join("");
      if (looksLikeCreatives(text, lang)) return <BotCreativeCards text={text} botId={botId} />;
      return <pre {...rest}>{children}</pre>;
    },
  }), [botId, activeTitle]);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const persona = botPersonaName(botName);
  const enabledSources = SOURCE_LABELS.filter(([k]) => !!sources[k]);
  const showSuggestions = messages.length === 0 && !activeRun && !loadingThread && !sending;
  const runningCount = Object.keys(runs).length;

  return (
    <div className="flex h-full min-h-0 bg-ui-bg text-ui-fg">
      {/* Conversations */}
      <aside className="hidden md:flex w-64 shrink-0 border-r border-ui-line bg-ui-sunken flex-col min-h-0">
        <div className="p-4 space-y-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ui-fg truncate">{persona}</div>
            <div className="text-xs text-ui-muted truncate">Assistant IA de {dashboardName}</div>
          </div>
          <button
            type="button"
            onClick={newConversation}
            className="w-full h-9 flex items-center justify-center gap-2 text-sm font-medium bg-ui-accent text-ui-on-accent rounded-lg px-3 hover:brightness-110 active:scale-[0.98] transition-[filter,transform] duration-150 ease-ui"
          >
            <Plus className="w-4 h-4" strokeWidth={1.5} />
            Nouvelle conversation
          </button>
          {runningCount > 0 && (
            <p className="text-xs text-ui-fg2">
              {runningCount} réponse{runningCount > 1 ? "s" : ""} en cours, vous pouvez changer de conversation ou de page
            </p>
          )}
        </div>
        <div className="px-4 pt-2 pb-2 text-xs text-ui-muted">Historique</div>
        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
          {conversations.length === 0 && (
            <p className="text-xs text-ui-muted px-2 py-2">Vos conversations apparaîtront ici</p>
          )}
          {conversations.map((c) => {
            const active = c.id === activeId;
            const running = !!runs[c.id];
            return (
              <div
                key={c.id}
                className={`group flex items-center gap-2.5 h-12 px-2 rounded-lg cursor-pointer transition-colors duration-150 ${active ? "bg-ui-raised text-ui-fg" : "text-ui-fg2 hover:bg-ui-raised/60 hover:text-ui-fg"}`}
                onClick={() => setActiveId(c.id)}
              >
                <span className="w-4 shrink-0 flex justify-center">
                  {running
                    ? <Loader2 className="w-4 h-4 text-ui-accent-ink animate-spin" strokeWidth={1.5} aria-label="Réponse en cours" />
                    : <MessageSquare className="w-4 h-4 text-ui-muted" strokeWidth={1.5} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{c.title || "Nouvelle conversation"}</div>
                  <div className="text-xs text-ui-muted font-mono tabular-nums">{running ? "réponse en cours" : fmtDate(c.updatedAt)}</div>
                </div>
                {!running && (
                  <button
                    type="button"
                    aria-label="Supprimer la conversation"
                    onClick={(e) => { e.stopPropagation(); void removeConversation(c.id); }}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-ui-muted hover:text-ui-neg transition-[opacity,color] duration-150"
                  >
                    <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {filesOn && <BotFilesList files={botFiles.files} onRemove={(f) => void botFiles.removeFile(f)} />}
        <div className="mx-4 mb-3 pt-3 border-t border-ui-line">
          <BotFeedbackBox botId={botId} conversationId={activeId} />
        </div>
        <div className="mx-4 mb-4 pt-3 border-t border-ui-line flex gap-2" title="Cet assistant ne lit que les données de votre espace. Les réponses sont générées sur Amazon Bedrock (AWS, région Europe), dans un environnement dédié.">
          <ShieldCheck className="w-4 h-4 text-ui-muted shrink-0 mt-0.5" strokeWidth={1.5} />
          <p className="text-xs leading-4 text-ui-muted">Uniquement vos données, IA hébergée en Europe (AWS Bedrock)</p>
        </div>
      </aside>

      {/* Chat */}
      <section className="relative flex-1 flex flex-col min-w-0 min-h-0">
        <header className="h-14 px-4 sm:px-6 border-b border-ui-line flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ui-fg truncate">{persona}</div>
            <div className="text-xs text-ui-muted truncate">Assistant IA de {dashboardName} · lecture seule</div>
          </div>
          <div className="flex items-center gap-4 overflow-hidden">
            {enabledSources.length > 0 ? (
              <div className="hidden lg:flex items-center gap-4" aria-label="Sources lues par l'assistant">
                {enabledSources.map(([k, label]) => (
                  <span key={k} className="inline-flex items-center gap-1.5 text-xs text-ui-fg2 whitespace-nowrap">
                    <span className={`w-1.5 h-1.5 rounded-full ${SOURCE_DOT[k] ?? "bg-ui-muted"}`} />{label}
                  </span>
                ))}
              </div>
            ) : <span className="text-xs text-ui-muted">Aucune source branchée</span>}
            <button type="button" onClick={newConversation} aria-label="Nouvelle conversation" className="md:hidden h-8 w-8 flex items-center justify-center rounded-lg bg-ui-raised text-ui-fg"><Plus className="w-4 h-4" strokeWidth={1.5} /></button>
          </div>
        </header>

        {isStaff && !enabled && (
          <div className="px-6 py-2 bg-ui-warn/10 border-b border-ui-line text-ui-warn text-xs flex items-center gap-2 shrink-0">
            <AlertTriangle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            Assistant inactif : invisible pour les clients, mode test
          </div>
        )}
        {isStaff && enabled && accessCount === 0 && (
          <div className="px-6 py-2 border-b border-ui-line text-ui-muted text-xs shrink-0">
            Aucun accès client sur cet assistant : seul le staff peut l&apos;ouvrir pour l&apos;instant
          </div>
        )}

        <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto px-4 sm:px-6 py-8">
          <div className="max-w-3xl mx-auto space-y-8">
            {loadingThread && (
              <div className="text-xs text-ui-muted flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Chargement</div>
            )}
            {showSuggestions && (
              <div className="pt-8 sm:pt-16">
                <h2 className="text-3xl font-normal leading-tight text-ui-fg">{dashboardName}</h2>
                <p className="mt-2 max-w-xl text-[15px] leading-6 text-ui-fg2">
                  Posez une question sur vos campagnes, vos créas ou votre trafic. Chaque réponse cite sa source et sa période, avec les visuels des créas concernées.
                </p>
                <div className="mt-8 border-t border-ui-line">
                  {suggestions.map((s) => {
                    const Icon = suggestionIcon(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => send(s)}
                        className="group w-full flex items-center gap-3 h-12 px-1 text-left border-b border-ui-line text-sm text-ui-fg2 hover:text-ui-fg transition-colors duration-150"
                      >
                        <Icon className="w-4 h-4 shrink-0 text-ui-muted group-hover:text-ui-accent-ink transition-colors duration-150" strokeWidth={1.5} />
                        <span className="flex-1 truncate">{s}</span>
                        <ArrowUpRight className="w-4 h-4 shrink-0 text-ui-muted opacity-0 group-hover:opacity-100 transition-opacity duration-150" strokeWidth={1.5} />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] bg-ui-raised text-ui-fg text-sm leading-6 px-4 py-2 rounded-xl whitespace-pre-wrap">{m.content}</div>
                </div>
              ) : (
                <div key={i} className={`min-w-0 ${PROSE}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{m.content}</ReactMarkdown>
                </div>
              )
            ))}
            {(activeRun || sending) && (
              <div className="min-w-0">
                {activeRun?.text ? (
                  <div className={PROSE}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{activeRun.text}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-2 text-sm text-ui-fg2">
                    <Loader2 className="w-4 h-4 animate-spin text-ui-accent-ink" strokeWidth={1.5} />
                    {activeRun?.stopping ? "Arrêt" : activeRun?.toolNote ?? "Lecture de vos données"}
                  </div>
                )}
                {activeRun?.text && (activeRun.toolNote || activeRun.stopping) && (
                  <div className="text-xs text-ui-muted mt-2 flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} />
                    {activeRun.stopping ? "Arrêt" : activeRun.toolNote}
                  </div>
                )}
              </div>
            )}
            {error && (
              <div className="text-sm text-ui-neg bg-ui-neg/10 rounded-lg px-3 py-2">{error}</div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {awayFromBottom && messages.length > 0 && (
          <div className="relative h-0">
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              aria-label="Aller au dernier message"
              title="Aller au dernier message"
              className="absolute -top-12 left-1/2 -translate-x-1/2 h-9 w-9 flex items-center justify-center rounded-full border border-ui-line-strong bg-ui-card text-ui-fg2 hover:text-ui-fg transition-colors duration-150"
            >
              <ArrowDown className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        )}

        <div className="px-4 sm:px-6 pb-4 pt-2 shrink-0">
          <div className="max-w-3xl mx-auto">
            {feedbackOpen && (
              <div className="md:hidden mb-3 rounded-xl border border-ui-line bg-ui-card p-3">
                <BotFeedbackBox botId={botId} conversationId={activeId} onClose={() => setFeedbackOpen(false)} />
              </div>
            )}
            {(voice.listening || voice.transcribing || voice.error) && (
              <div className={`mb-2 flex items-center gap-2 text-xs ${voice.error && !voice.listening && !voice.transcribing ? "text-ui-warn" : "text-ui-fg2"}`} role="status">
                {voice.listening ? (
                  <><span className="h-2 w-2 rounded-full bg-ui-neg" /> Je vous écoute, cliquez à nouveau sur le micro pour arrêter</>
                ) : voice.transcribing ? (
                  <><Loader2 className="w-3 h-3 animate-spin" /> Transcription de votre message</>
                ) : (
                  voice.error
                )}
              </div>
            )}
            {(botFiles.upload || botFiles.notice) && (
              <div className={`mb-2 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${botFiles.notice?.tone === "error" && !botFiles.upload ? "bg-ui-neg/10 text-ui-neg" : "bg-ui-raised text-ui-fg2"}`}>
                <span className="flex-1">
                  {botFiles.upload
                    ? `Import de « ${botFiles.upload.fileName} » ${botFiles.upload.total > 1 ? `${botFiles.upload.done}/${botFiles.upload.total}` : ""}`
                    : botFiles.notice?.text}
                </span>
                {!botFiles.upload && (
                  <button type="button" onClick={() => botFiles.setNotice(null)} className="text-ui-muted hover:text-ui-fg" aria-label="Fermer">×</button>
                )}
              </div>
            )}
            <div className={`flex items-end gap-1 rounded-xl border border-ui-line-strong bg-ui-card p-2 ${filesOn || voice.supported ? "pl-2" : "pl-4"} focus-within:border-ui-accent transition-colors duration-150`}>
              {filesOn && <AttachFileButton uploading={!!botFiles.upload} onFile={(f) => void onImport(f)} />}
              {voice.supported && (
                <button
                  type="button"
                  onClick={() => (voice.listening ? voice.end() : voice.begin())}
                  disabled={busy || voice.transcribing}
                  aria-label={voice.listening ? "Arrêter la dictée" : "Dicter votre question"}
                  aria-pressed={voice.listening}
                  title={voice.listening ? "Cliquez pour arrêter : le texte s'ajoute à votre message" : "Dicter votre question au micro"}
                  className={`relative h-9 w-9 shrink-0 flex items-center justify-center rounded-lg transition-colors duration-150 disabled:opacity-40 ${voice.listening ? "bg-ui-neg/15 text-ui-neg" : "text-ui-muted hover:text-ui-fg hover:bg-ui-raised"}`}
                >
                  {voice.transcribing ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} /> : <Mic className="w-4 h-4" strokeWidth={1.5} />}
                  {voice.listening && <span className="absolute inset-0 rounded-lg ring-2 ring-ui-neg/60" style={{ opacity: 0.3 + Math.min(voice.level, 1) * 0.7 }} />}
                </button>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; }}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={busy}
                aria-label="Votre question"
                placeholder={activeRun ? "Réponse en cours sur cette conversation, ouvrez-en une autre pour une nouvelle question" : "Votre question"}
                className="flex-1 resize-none bg-transparent px-2 py-2 text-sm text-ui-fg placeholder:text-ui-muted focus:outline-none max-h-40 disabled:opacity-60"
              />
              {activeRun ? (
                <button
                  type="button"
                  onClick={() => void stopActive()}
                  disabled={activeRun.stopping}
                  aria-label="Arrêter la réponse"
                  title="Arrêter la réponse"
                  className="h-9 w-9 shrink-0 flex items-center justify-center rounded-lg bg-ui-raised hover:bg-ui-line-strong disabled:opacity-40 text-ui-fg transition-colors duration-150"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => send(input)}
                  disabled={busy || !input.trim()}
                  aria-label="Envoyer"
                  className="h-9 w-9 shrink-0 flex items-center justify-center rounded-lg bg-ui-accent text-ui-on-accent hover:brightness-110 active:scale-[0.97] disabled:opacity-30 transition-[filter,transform,opacity] duration-150 ease-ui"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} /> : <ArrowUp className="w-4 h-4" strokeWidth={1.5} />}
                </button>
              )}
            </div>
            <p className="text-xs text-ui-muted mt-2 px-1">
              Entrée pour envoyer, Maj+Entrée pour aller à la ligne. L&apos;assistant lit vos données sans jamais agir sur vos campagnes ; vérifiez les chiffres importants avec votre équipe Impulse Analytics.
              <button type="button" onClick={() => setFeedbackOpen((v) => !v)} className="md:hidden ml-1 text-ui-fg2 underline underline-offset-2">Donner votre avis</button>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

/** The hast node react-markdown hands to a component (only what the creative block reads). */
type MdNode = { children?: Array<{ properties?: { className?: unknown }; children?: Array<{ value?: string }> }> };

const PROSE = "ui-prose prose prose-sm max-w-none prose-p:my-2 prose-p:leading-6 prose-headings:font-medium prose-strong:font-medium prose-li:my-0.5 prose-table:my-4 prose-img:my-3";

// Platform dots: the only colour in the header, one per source, toned down.
const SOURCE_DOT: Partial<Record<keyof BotSources, string>> = {
  data: "bg-ui-pos", meta: "bg-[#4f8fdc]", google: "bg-[#d9a23b]", tiktok: "bg-[#d4588a]", ga4PropertyId: "bg-[#d27d3f]", files: "bg-ui-muted",
};

function suggestionIcon(text: string) {
  const t = text.toLowerCase();
  if (/créa|visuel|vidéo/.test(t)) return Images;
  if (/trafic|source/.test(t)) return Globe;
  if (/chiffre d'affaires|commande|produit|client/.test(t)) return ShoppingBag;
  if (/fichier/.test(t)) return FileSpreadsheet;
  return BarChart3;
}
