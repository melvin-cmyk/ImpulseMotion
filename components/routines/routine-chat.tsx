"use client";

/**
 * Conversation with the AI that writes the routine (staff only).
 *
 * The AI streams a reply and proposes the routine in one ```routine block,
 * shown as a card. The block is extracted here for display, then validated by
 * the server when the conversation is saved: « Appliquer » exists only for a
 * proposal the server found valid, and the click goes through
 * POST /api/routines/[id]/definition, which validates again and runs its own
 * controls. The AI itself never writes anything.
 *
 * What happened to a proposal (applied, refused, rejected and why) is handed
 * to the AI with the consultant's next message, so that it corrects itself.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Send, WifiOff } from "lucide-react";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { AiActivity } from "@/components/ai/activity";
import { AUTO_CONTINUE_PROMPT, INITIAL_ACTIVITY, MAX_AUTO_CONTINUES, reduceActivity, type ActivityState } from "@/lib/ai-activity";
import {
  ROUTINE_CHAT_MAX_MESSAGES, ROUTINE_SHEETS_SHARE_EMAIL,
  extractRoutineProposal, invalidProposalNote, proposalKey, stripRoutineBlocks,
} from "@/lib/routines/compose-prompt";
import type { PreflightIssue, RoutineProposal } from "@/lib/routines/types";
import { ProposalCard } from "@/components/routines/proposal-card";
import { shiftProposalKeys, type ProposalState } from "@/components/routines/routine-model";

interface ChatMessage { role: "user" | "assistant"; content: string }

type Check =
  | { ok: true; proposal: RoutineProposal; writesPlatform: boolean; notices: string[] }
  | { ok: false; errors: string[] };

/** What an application attempt answered; kept for the session only. */
interface ApplyOutcome { applying?: boolean; errors?: string[]; issues?: PreflightIssue[] }

const NOTES_RE = /^\[Résultat des propositions précédentes[^\]]*\]\n\n/;

function readChecks(raw: unknown): Record<string, Check> {
  const out: Record<string, Check> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as { ok?: unknown; proposal?: unknown; errors?: unknown; writesPlatform?: unknown; notices?: unknown } | null;
    if (!v || typeof v !== "object") continue;
    if (v.ok === true && v.proposal && typeof v.proposal === "object") {
      out[key] = {
        ok: true, proposal: v.proposal as RoutineProposal, writesPlatform: v.writesPlatform === true,
        notices: Array.isArray(v.notices) ? v.notices.filter((n): n is string => typeof n === "string") : [],
      };
    } else if (v.ok === false) {
      out[key] = { ok: false, errors: Array.isArray(v.errors) ? v.errors.filter((e): e is string => typeof e === "string") : [] };
    }
  }
  return out;
}

function readStatuses(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) if (typeof value === "string") out[key] = value;
  return out;
}

export function RoutineChat({
  routineId, metaAccountId, timezone, initialInput, readOnly, onApplied,
}: {
  routineId: string;
  metaAccountId: string | null;
  timezone?: string | null;
  /** Example picked on /routines: put in the box of an empty conversation, never sent by itself. */
  initialInput?: string | null;
  /** Archived routine: the conversation is shown, nothing can be sent or applied. */
  readOnly?: boolean;
  /** A definition was stored: the page reloads the routine and shows the dry run. */
  onApplied: (issues: PreflightIssue[]) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [outcomes, setOutcomes] = useState<Record<string, ApplyOutcome>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState>(INITIAL_ACTIVITY);
  const [startedAt, setStartedAt] = useState(0);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayDown, setRelayDown] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Outcomes of the proposals, fed to the model with the next message.
  const pendingNotesRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const statusesRef = useRef<Record<string, string>>({});
  useEffect(() => { statusesRef.current = statuses; }, [statuses]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/routines/${routineId}/assistant`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Erreur ${r.status}`);
        return r.json();
      })
      .then((j) => {
        // Never clobber a conversation already in flight.
        if (cancelled || busyRef.current) return;
        const msgs: ChatMessage[] = Array.isArray(j.messages) ? j.messages : [];
        setMessages((current) => (current.length > 0 ? current : msgs));
        setStatuses(readStatuses(j.proposals));
        setChecks(readChecks(j.checks));
        if (msgs.length === 0 && initialInput) setInput((current) => current || initialInput);
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streamText, checks]);

  /**
   * Saves the conversation; the answer carries the server's validation of
   * every proposal. Null when the server could not be reached: proposals
   * without a check then stay without « Appliquer ».
   */
  const save = useCallback(async (msgs: ChatMessage[], sts: Record<string, string>): Promise<Record<string, Check> | null> => {
    setVerifying(true);
    try {
      const res = await fetch(`/api/routines/${routineId}/assistant`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: msgs, proposals: sts }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      const next = readChecks(j.checks);
      setChecks(next);
      setStatuses(readStatuses(j.proposals));
      return next;
    } catch {
      return null;
    } finally {
      setVerifying(false);
    }
  }, [routineId]);

  /** Keeps the thread under the cap; statuses follow their message. */
  function capThread(msgs: ChatMessage[], sts: Record<string, string>): { msgs: ChatMessage[]; sts: Record<string, string> } {
    const dropped = msgs.length - ROUTINE_CHAT_MAX_MESSAGES;
    if (dropped <= 0) return { msgs, sts };
    setOutcomes((o) => shiftProposalKeys(o, dropped));
    setChecks((c) => shiftProposalKeys(c, dropped));
    return { msgs: msgs.slice(dropped), sts: shiftProposalKeys(sts, dropped) };
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || readOnly) return;
    setInput("");
    setError(null);
    setRelayDown(false);
    setTruncated(false);
    setBusy(true);
    busyRef.current = true;
    setActivity(INITIAL_ACTIVITY);
    setStartedAt(Date.now());
    setRound(0);

    const notes = pendingNotesRef.current;
    pendingNotesRef.current = [];
    const content = notes.length ? `[Résultat des propositions précédentes : ${notes.join(" ; ")}]\n\n${text}` : text;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setStreamText("");

    let acc = "";
    let sawDone = false;
    try {
      // A turn cut by the time budget is relaunched on the same relay session.
      let turn: ChatMessage[] = next;
      for (let attempt = 0; ; attempt++) {
        let resumable = false;
        sawDone = false;
        const res = await fetch(`/api/routines/${routineId}/assistant`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: turn.slice(-ROUTINE_CHAT_MAX_MESSAGES) }),
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          if (res.status === 502) setRelayDown(true);
          throw new Error(body.error ?? `Erreur ${res.status}`);
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
            if (!trimmed.startsWith("data: ")) continue;
            let event: Record<string, unknown>;
            try { event = JSON.parse(trimmed.slice(6)); } catch { continue; }
            setActivity((a) => reduceActivity(a, event));
            if (event.type === "delta" && typeof event.text === "string") {
              acc += event.text;
              setStreamText(acc);
            } else if (event.type === "content" && typeof event.text === "string" && !acc) {
              acc = event.text;
              setStreamText(acc);
            } else if (event.type === "done") {
              sawDone = true;
            } else if (event.type === "error" && event.resumable === true) {
              resumable = true;
            } else if (event.type === "error") {
              // Partial text is kept, the error is shown next to it.
              if (!acc.trim()) throw new Error(String(event.message ?? "Erreur IA"));
              setError(String(event.message ?? "Erreur IA"));
            }
          }
        }
        if (!(resumable || !sawDone) || attempt >= MAX_AUTO_CONTINUES) break;
        setRound(attempt + 1);
        setActivity((a) => ({ ...a, phase: "starting", tool: null, pending: [] }));
        turn = [...next, ...(acc.trim() ? [{ role: "assistant" as const, content: acc }] : []), { role: "user" as const, content: AUTO_CONTINUE_PROMPT }];
        if (acc && !acc.endsWith("\n\n")) acc += "\n\n";
      }
      if (!acc.trim()) throw new Error("Réponse vide de l'IA — réessayez");
      if (!sawDone) setTruncated(true);

      const capped = capThread([...next, { role: "assistant", content: acc }], statusesRef.current);
      setMessages(capped.msgs);
      setStatuses(capped.sts);
      setStreamText(null);

      const key = proposalKey(capped.msgs.length - 1);
      const local = extractRoutineProposal(acc);
      const verdict = (await save(capped.msgs, capped.sts))?.[key];
      // A rejected proposal goes back to the AI, whoever rejected it.
      if (verdict && !verdict.ok) pendingNotesRef.current.push(invalidProposalNote(verdict.errors));
      else if (!verdict && local.kind === "malformed") pendingNotesRef.current.push(invalidProposalNote(local.errors));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages(messages); // the user message is rolled back
      setInput(text);
      pendingNotesRef.current = [...notes, ...pendingNotesRef.current];
    } finally {
      setBusy(false);
      busyRef.current = false;
      setStreamText(null);
    }
  }

  function setStatus(key: string, status: string) {
    const merged = { ...statusesRef.current, [key]: status };
    statusesRef.current = merged;
    setStatuses(merged);
    void save(messages, merged);
  }

  async function apply(key: string, proposal: RoutineProposal) {
    if (readOnly) return;
    setOutcomes((o) => ({ ...o, [key]: { applying: true } }));
    const label = `la proposition « ${proposal.name} »`;
    try {
      const res = await fetch(`/api/routines/${routineId}/definition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal }),
      });
      const body = await res.json().catch(() => ({}));
      const issues: PreflightIssue[] = Array.isArray(body.issues) ? body.issues : [];
      const blocking = issues.filter((i) => i.severity === "error");
      if (!res.ok || body.ok === false || blocking.length) {
        const errors: string[] = Array.isArray(body.errors) ? body.errors : body.error ? [String(body.error)] : blocking.length ? [] : [`Erreur ${res.status}`];
        setOutcomes((o) => ({ ...o, [key]: { errors, issues } }));
        pendingNotesRef.current.push(`${label} a été REFUSÉE par les contrôles du serveur, rien n'est enregistré : ${[...errors, ...blocking.map((i) => `${i.stepId} : ${i.message}`)].slice(0, 8).join(" | ")}`);
        setStatus(key, "failed");
        return;
      }
      setOutcomes((o) => ({ ...o, [key]: { issues } }));
      const warned = issues.filter((i) => i.severity === "warning").map((i) => `${i.stepId} : ${i.message}`);
      pendingNotesRef.current.push(`${label} a été appliquée${warned.length ? `, avec ces avertissements du serveur : ${warned.slice(0, 5).join(" | ")}` : ""} ; l'essai à blanc reste à lancer`);
      setStatus(key, "applied");
      onApplied(issues);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setOutcomes((o) => ({ ...o, [key]: { errors: [message] } }));
      setStatus(key, "failed");
    }
  }

  function refuse(key: string, proposal: RoutineProposal) {
    pendingNotesRef.current.push(`la proposition « ${proposal.name} » a été refusée par le consultant`);
    setStatus(key, "refused");
  }

  function renderProposal(content: string, index: number) {
    const local = extractRoutineProposal(content);
    if (local.kind === "none") return null;
    const key = proposalKey(index);
    const check = checks[key];
    const outcome = outcomes[key] ?? {};
    const draftName = local.kind === "candidate" && typeof local.raw.name === "string" ? local.raw.name : null;

    let state: ProposalState;
    let errors: string[] | undefined;
    if (local.kind === "malformed") { state = "invalid"; errors = local.errors; }
    else if (!check) state = verifying ? "checking" : "unverified";
    else if (!check.ok) { state = "invalid"; errors = check.errors; }
    else if (outcome.applying) state = "applying";
    else {
      const stored = statuses[key];
      state = stored === "applied" || stored === "refused" || stored === "failed" ? stored : "pending";
      if (state === "failed") errors = outcome.errors;
    }
    const proposal = check?.ok && local.kind === "candidate" ? check.proposal : null;
    // An archived routine keeps its cards, without any way to act.
    if (readOnly && (state === "pending" || state === "failed")) state = "refused";

    return (
      <ProposalCard
        state={state}
        proposal={proposal}
        draftName={draftName}
        errors={errors}
        issues={outcome.issues}
        notices={check?.ok && (state === "pending" || state === "failed" || state === "applying") ? check.notices : undefined}
        metaAccountId={metaAccountId}
        timezone={timezone}
        onApply={() => { if (proposal) void apply(key, proposal); }}
        onRefuse={() => { if (proposal) refuse(key, proposal); }}
        onRecheck={() => { void save(messages, statusesRef.current); }}
      />
    );
  }

  function renderMessage(m: ChatMessage, i: number) {
    if (m.role === "user") {
      if (m.content === AUTO_CONTINUE_PROMPT) return null;
      return (
        <div key={i} className="ml-6 sm:ml-16 bg-violet-950/50 border border-violet-900/40 rounded-xl px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap break-words">
          {m.content.replace(NOTES_RE, "")}
        </div>
      );
    }
    const clean = stripRoutineBlocks(m.content);
    return (
      <div key={i} className="sm:mr-10 space-y-2">
        {clean && (
          <AiMarkdown content={clean} filesBase={null} className="prose prose-invert prose-sm max-w-none text-gray-300 bg-gray-950/60 border border-gray-800 rounded-xl px-3 py-2 break-words" />
        )}
        {renderProposal(m.content, i)}
      </div>
    );
  }

  const writing = streamText !== null && /```routine\b/i.test(streamText);

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl flex flex-col min-w-0 min-h-[420px] max-h-[75vh]">
      <header className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
        <Bot className="w-4 h-4 text-violet-400 shrink-0" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white">Créer la routine avec l&apos;IA</h2>
          <p className="text-[11px] text-gray-500">Décrivez ce que vous voulez. L&apos;IA propose, vous appliquez : rien n&apos;est enregistré sans votre clic.</p>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-3 space-y-3">
        {!loaded && <div className="text-xs text-gray-500">Chargement de la conversation…</div>}
        {loadError && (
          <div className="text-xs text-red-400">La conversation n&apos;a pas pu être chargée ({loadError}). Rechargez la page avant d&apos;écrire : un nouveau message remplacerait l&apos;ancienne conversation.</div>
        )}
        {loaded && !loadError && messages.length === 0 && streamText === null && (
          <div className="text-xs text-gray-400 bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-3 space-y-1.5">
            <p>Dites ce que la routine doit faire, quand, et où va le résultat. L&apos;IA pose ses questions une par une, vérifie ce qu&apos;elle peut (en-tête du Sheet, campagne, ensemble de publicités), puis propose la routine.</p>
            <p>Un Google Sheet ? Partagez-le en Éditeur avec <span className="text-gray-200 font-mono">{ROUTINE_SHEETS_SHARE_EMAIL}</span>, puis collez son lien avec le nom de l&apos;onglet.</p>
            <p className="text-gray-500">Première version : publicités Meta créées en pause dans un ensemble existant, média par adresse https publique, message Slack dans un canal.</p>
          </div>
        )}
        {messages.map(renderMessage)}
        {streamText !== null && (
          <div className="sm:mr-10 bg-gray-950/60 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 whitespace-pre-wrap break-words">
            {stripRoutineBlocks(streamText)}
            {writing && <div className="text-xs text-violet-300 mt-2">Rédaction de la proposition de routine…</div>}
            <AiActivity state={activity} startedAt={startedAt} round={round} className={streamText ? "mt-2" : undefined} />
          </div>
        )}
        {truncated && (
          <div className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
            La réponse a peut-être été interrompue : si la proposition manque ou est incomplète, redemandez-la.
          </div>
        )}
        {relayDown ? (
          <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
            <WifiOff className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              L&apos;IA de création est injoignable pour le moment. Votre message est conservé dans la zone de saisie : réessayez dans quelques minutes.
              La routine, son essai à blanc et son historique restent utilisables.
              {error && <span className="block text-amber-400/70 mt-1">{error}</span>}
            </span>
          </div>
        ) : error ? (
          <div className="text-xs text-red-400 break-words">{error}</div>
        ) : null}
      </div>

      {readOnly ? (
        <div className="p-3 border-t border-gray-800 text-xs text-gray-500">Routine archivée : la conversation est en lecture seule.</div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="p-3 border-t border-gray-800 flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            rows={Math.min(6, Math.max(2, input.split("\n").length + Math.floor(input.length / 70)))}
            placeholder="Ex. : tous les lundis à 9 h, envoie dans #client le top 5 des campagnes…"
            disabled={busy || !loaded || !!loadError}
            aria-label="Message à l'IA"
            className="flex-1 min-w-0 resize-none px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white placeholder:text-gray-600 focus:border-violet-500 focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !loaded || !!loadError || !input.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
            <span className="hidden sm:inline">{busy ? "En cours…" : "Envoyer"}</span>
          </button>
        </form>
      )}
    </section>
  );
}
