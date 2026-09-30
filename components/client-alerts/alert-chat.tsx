"use client";

/**
 * Conversation with the AI that writes the alert (its creator only).
 *
 * The AI streams a short reply and proposes the alert in one ```alert block,
 * shown as a card. The block is extracted here for display, then validated
 * and replayed over 30 days by the server when the conversation is saved:
 * « Valider » exists only for a proposal the server found valid, and the click
 * goes through POST /api/client-alerts/[id]/activate, which validates and
 * replays again. The AI itself never writes anything.
 *
 * What happened to a proposal (validated, rejected and why) is handed to the
 * AI with the consultant's next message, so that it corrects itself.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing, Loader2, Send, WifiOff, X } from "lucide-react";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { AiActivity } from "@/components/ai/activity";
import { Pill } from "@/components/ui/surface";
import { INITIAL_ACTIVITY, reduceActivity, type ActivityState } from "@/lib/ai-activity";
import {
  ALERT_CHAT_MAX_MESSAGES, extractAlertProposal, invalidProposalNote, proposalKey, stripAlertBlocks,
} from "@/lib/client-alerts/compose-prompt";
import type { AlertDefinition, Backtest } from "@/lib/client-alerts/types";
import { ProposalCard, type CardState } from "@/components/client-alerts/proposal-card";
import { PlatformBadges } from "@/components/client-alerts/client-picker";
import { ALERT_STATUS, dayLabel, exampleRequests, type AlertView, type ProposalCheck } from "@/components/client-alerts/alert-model";

interface ChatMessage { role: "user" | "assistant"; content: string }

/** What a validation attempt answered; kept for the visit only. */
interface Outcome { applying?: boolean; errors?: string[]; confirm?: number; notice?: string | null }

type Figures = { ok: true; until: string; unreadable: string[] } | { ok: false } | null;

const NOTES_RE = /^\[Résultat des propositions précédentes[^\]]*\]\n\n/;

function readChecks(raw: unknown): Record<string, ProposalCheck> {
  const out: Record<string, ProposalCheck> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as { ok?: unknown; proposal?: unknown; warnings?: unknown; backtest?: unknown; noisy?: unknown; errors?: unknown; retry?: unknown } | null;
    if (!v || typeof v !== "object") continue;
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : []);
    const replay = v.backtest as Partial<Backtest> | null | undefined;
    if (v.ok === true && v.proposal && typeof v.proposal === "object" && replay && typeof replay === "object" && Array.isArray(replay.messages)) {
      out[key] = { ok: true, proposal: v.proposal as AlertDefinition, warnings: strings(v.warnings), backtest: { ...(replay as Backtest), notes: strings(replay.notes) }, noisy: v.noisy === true };
    } else if (v.ok === false) {
      out[key] = { ok: false, errors: strings(v.errors), ...(v.retry === true ? { retry: true } : {}) };
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

function readFigures(raw: unknown): Figures {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as { ok?: unknown; until?: unknown; unreadable?: unknown };
  if (f.ok !== true) return { ok: false };
  return { ok: true, until: typeof f.until === "string" ? f.until : "", unreadable: Array.isArray(f.unreadable) ? f.unreadable.filter((n): n is string => typeof n === "string") : [] };
}

/** Proposal statuses follow their message when the thread is shortened from the top. */
function shiftKeys<T>(byKey: Record<string, T>, dropped: number): Record<string, T> {
  if (dropped <= 0) return byKey;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(byKey)) {
    const m = /^m(\d+)$/.exec(key);
    if (!m) continue;
    const index = Number(m[1]) - dropped;
    if (index >= 0) out[`m${index}`] = value;
  }
  return out;
}

export function AlertChat({ alert, fresh, onActivated, onClose }: {
  alert: AlertView;
  /** The draft was created a moment ago: nothing to load, the box is ready at once. */
  fresh?: boolean;
  /** An alert was put in service: the page updates its list. */
  onActivated: (alert: AlertView) => void;
  onClose: () => void;
}) {
  const alertId = alert.id;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, ProposalCheck>>({});
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [figures, setFigures] = useState<Figures>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState>(INITIAL_ACTIVITY);
  const [streaming, setStreaming] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayDown, setRelayDown] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Outcomes of the proposals, fed to the model with the next message.
  const pendingNotesRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const statusesRef = useRef<Record<string, string>>({});
  useEffect(() => { statusesRef.current = statuses; }, [statuses]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/client-alerts/${alertId}/assistant`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Erreur ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        setFigures(readFigures(j.figures));
        // Never clobber a conversation already in flight.
        if (busyRef.current) return;
        const msgs: ChatMessage[] = Array.isArray(j.messages) ? j.messages : [];
        setMessages((current) => (current.length > 0 ? current : msgs));
        setStatuses((current) => (Object.keys(current).length ? current : readStatuses(j.proposals)));
        setChecks((current) => (Object.keys(current).length ? current : readChecks(j.checks)));
      })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [alertId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, streamText, checks, outcomes]);

  const ready = (loaded || !!fresh) && !loadError;

  // The box is disabled while the AI answers: it takes the focus back as soon as it can be typed in.
  useEffect(() => { if (!busy && ready) inputRef.current?.focus(); }, [busy, ready]);

  /**
   * Saves the conversation; the answer carries the server's validation and
   * replay of every proposal. Null when the server could not be reached:
   * proposals without a check then stay without « Valider ».
   */
  const save = useCallback(async (msgs: ChatMessage[], sts: Record<string, string>): Promise<Record<string, ProposalCheck> | null> => {
    setVerifying(true);
    try {
      const res = await fetch(`/api/client-alerts/${alertId}/assistant`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: msgs, proposals: sts }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      const next = readChecks(j.checks);
      setChecks(next);
      setStatuses(readStatuses(j.proposals));
      setFigures(readFigures(j.figures));
      return next;
    } catch {
      return null;
    } finally {
      setVerifying(false);
    }
  }, [alertId]);

  /** Keeps the thread under the cap; statuses follow their message. */
  function capThread(msgs: ChatMessage[], sts: Record<string, string>): { msgs: ChatMessage[]; sts: Record<string, string> } {
    const dropped = msgs.length - ALERT_CHAT_MAX_MESSAGES;
    if (dropped <= 0) return { msgs, sts };
    setOutcomes((o) => shiftKeys(o, dropped));
    setChecks((c) => shiftKeys(c, dropped));
    return { msgs: msgs.slice(dropped), sts: shiftKeys(sts, dropped) };
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !ready) return;
    setInput("");
    setError(null);
    setRelayDown(false);
    setTruncated(false);
    setBusy(true);
    busyRef.current = true;
    setActivity(INITIAL_ACTIVITY);
    setStreaming(false);
    setStartedAt(Date.now());

    const notes = pendingNotesRef.current;
    pendingNotesRef.current = [];
    const content = notes.length ? `[Résultat des propositions précédentes : ${notes.join(" ; ")}]\n\n${text}` : text;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setStreamText("");

    let acc = "";
    let sawDone = false;
    try {
      const res = await fetch(`/api/client-alerts/${alertId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(-ALERT_CHAT_MAX_MESSAGES) }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 502) setRelayDown(true);
        throw new Error(body.error ?? `Erreur ${res.status}`);
      }
      setStreaming(true);
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
          } else if (event.type === "error") {
            // Partial text is kept, the error is shown next to it.
            if (!acc.trim()) throw new Error(String(event.message ?? "Erreur de l'IA"));
            setError(String(event.message ?? "Erreur de l'IA"));
          }
        }
      }
      if (!acc.trim()) throw new Error("Réponse vide de l'IA — réessayez.");
      if (!sawDone) setTruncated(true);

      const capped = capThread([...next, { role: "assistant", content: acc }], statusesRef.current);
      setMessages(capped.msgs);
      setStatuses(capped.sts);
      setStreamText(null);

      const key = proposalKey(capped.msgs.length - 1);
      const local = extractAlertProposal(acc);
      const verdict = (await save(capped.msgs, capped.sts))?.[key];
      // A rejected proposal goes back to the AI; one that merely could not be checked does not.
      if (verdict && !verdict.ok && !verdict.retry) pendingNotesRef.current.push(invalidProposalNote(verdict.errors));
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
      setStreaming(false);
    }
  }

  function setStatus(key: string, status: string) {
    const merged = { ...statusesRef.current, [key]: status };
    statusesRef.current = merged;
    setStatuses(merged);
    void save(messages, merged);
  }

  async function activate(key: string, proposal: AlertDefinition, confirmNoisy: boolean) {
    setOutcomes((o) => ({ ...o, [key]: { applying: true } }));
    const label = `la proposition « ${proposal.label} »`;
    try {
      const res = await fetch(`/api/client-alerts/${alertId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal, ...(confirmNoisy ? { confirmNoisy: true } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.needsConfirm) {
        const count = Array.isArray(body.backtest?.messages) ? body.backtest.messages.length : undefined;
        setOutcomes((o) => ({ ...o, [key]: { confirm: count ?? 0 } }));
        return;
      }
      if (!res.ok || !body.alert) {
        const errors: string[] = Array.isArray(body.errors) && body.errors.length ? body.errors : [String(body.error ?? `Erreur ${res.status}`)];
        setOutcomes((o) => ({ ...o, [key]: { errors } }));
        if (res.status === 422) pendingNotesRef.current.push(`${label} a été REFUSÉE par le serveur au moment de la valider, rien n'est enregistré : ${errors.slice(0, 8).join(" | ")}`);
        return;
      }
      setOutcomes((o) => ({ ...o, [key]: { notice: typeof body.notice === "string" ? body.notice : null } }));
      pendingNotesRef.current.push(`${label} a été validée par le consultant : c'est maintenant l'alerte en service`);
      setStatus(key, "applied");
      onActivated(body.alert as AlertView);
    } catch (e) {
      setOutcomes((o) => ({ ...o, [key]: { errors: [e instanceof Error ? e.message : String(e)] } }));
    }
  }

  function renderProposal(content: string, index: number) {
    const local = extractAlertProposal(content);
    if (local.kind === "none") return null;
    const key = proposalKey(index);
    const check = checks[key];
    const outcome = outcomes[key] ?? {};
    const draftLabel = local.kind === "candidate" && typeof local.raw.label === "string" ? local.raw.label : null;

    let state: CardState;
    let errors: string[] | undefined;
    if (local.kind === "malformed") { state = "invalid"; errors = local.errors; }
    else if (!check) state = verifying ? "checking" : "unverified";
    else if (!check.ok) { state = check.retry ? (verifying ? "checking" : "unverified") : "invalid"; errors = check.errors; }
    else if (outcome.applying) state = "applying";
    else {
      // The server's word on which proposal is the alert: the hash of what was replayed.
      const isTheAlert = !!alert.definitionHash && check.backtest.hash === alert.definitionHash;
      if (isTheAlert && alert.status === "active") state = "inService";
      else if (isTheAlert && alert.status === "paused") state = "paused";
      else if (outcome.confirm !== undefined) state = "confirming";
      else if (outcome.errors) { state = "failed"; errors = outcome.errors; }
      else if (!isTheAlert && statuses[key] === "applied") state = "replaced";
      else state = "pending";
    }
    const valid = check?.ok ? check : null;

    return (
      <ProposalCard
        state={state}
        proposal={valid?.proposal ?? null}
        draftLabel={draftLabel}
        backtest={valid?.backtest ?? null}
        warnings={valid?.warnings}
        errors={errors}
        notice={outcome.notice}
        confirmCount={outcome.confirm || valid?.backtest.messages.length}
        replaces={alert.status === "active" && !!alert.definition}
        onValidate={() => {
          if (!valid) return;
          // Known to be noisy: the question comes before any request.
          if (valid.noisy && state !== "failed") setOutcomes((o) => ({ ...o, [key]: { confirm: valid.backtest.messages.length } }));
          else void activate(key, valid.proposal, false);
        }}
        onConfirm={() => { if (valid) void activate(key, valid.proposal, true); }}
        onCancel={() => setOutcomes((o) => ({ ...o, [key]: {} }))}
        onRecheck={() => { void save(messages, statusesRef.current); }}
      />
    );
  }

  function renderMessage(m: ChatMessage, i: number) {
    if (m.role === "user") {
      return (
        <div key={i} className="ml-6 sm:ml-16 bg-violet-950/50 border border-violet-900/40 rounded-xl px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap break-words">
          {m.content.replace(NOTES_RE, "")}
        </div>
      );
    }
    const clean = stripAlertBlocks(m.content);
    return (
      <div key={i} className="sm:mr-10 space-y-2">
        {clean && (
          <AiMarkdown content={clean} filesBase={null} className="prose prose-invert prose-sm max-w-none text-gray-300 bg-gray-950/60 border border-gray-800 rounded-xl px-3 py-2 break-words" />
        )}
        {renderProposal(m.content, i)}
      </div>
    );
  }

  const writing = streamText !== null && /```alert\b/i.test(streamText);
  const status = ALERT_STATUS[alert.status];
  const examples = exampleRequests(alert.accounts);

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl flex flex-col min-w-0 h-[calc(100vh-13rem)] min-h-[460px]">
      <header className="px-4 py-3 border-b border-gray-800 flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-2">
          <BellRing className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white flex flex-wrap items-center gap-2">
              <span className="truncate">{alert.clientName}</span>
              <PlatformBadges accounts={alert.accounts} />
              {alert.status !== "draft" && <Pill tone={status.tone} className="text-[10px]">{status.label}</Pill>}
            </h2>
            <p className="text-[11px] text-gray-500 break-words">
              {alert.label ? `${alert.label} — pour la modifier, dites simplement ce qui doit changer.` : "Dites de quoi vous voulez être prévenu. L'IA propose, vous validez : rien n'est enregistré sans votre clic."}
            </p>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Fermer la conversation" title="Fermer la conversation" className="shrink-0 p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-800">
          <X className="w-4 h-4" />
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-3 space-y-3">
        {!loaded && !fresh && <div className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" />Chargement de la conversation…</div>}
        {loadError && (
          <div className="text-xs text-red-400">La conversation n&apos;a pas pu être chargée ({loadError}). Rechargez la page avant d&apos;écrire : un nouveau message remplacerait l&apos;ancienne conversation.</div>
        )}
        {ready && messages.length === 0 && streamText === null && (
          <div className="text-xs text-gray-400 bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-3 space-y-2">
            <p>Écrivez votre demande en une phrase, comme vous la diriez à un collègue. L&apos;IA lit les chiffres du client, propose l&apos;alerte et vous montre ce qu&apos;elle aurait donné sur les 30 derniers jours.</p>
            <div className="flex flex-wrap gap-1.5">
              {examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => { setInput(ex); inputRef.current?.focus(); }}
                  className="text-left px-2.5 py-1.5 rounded-lg text-xs bg-violet-500/10 hover:bg-violet-500/20 text-violet-200 border border-violet-500/30 transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
            <p className="text-gray-500">Un exemple se place dans la zone de saisie : ajustez-le, puis Entrée.</p>
          </div>
        )}
        {figures?.ok === false && (
          <div className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
            Les chiffres du client n&apos;ont pas pu être lus pour le moment. L&apos;IA peut proposer une alerte, mais sans s&apos;appuyer sur eux, et la vérification sur 30 jours attendra.
          </div>
        )}
        {figures?.ok && figures.unreadable.length > 0 && (
          <div className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
            {figures.unreadable.length > 1 ? "Comptes illisibles" : "Compte illisible"} pour le moment : {figures.unreadable.join(", ")}.
          </div>
        )}
        {messages.map(renderMessage)}
        {streamText !== null && (
          <div className="sm:mr-10 min-h-[3.5rem] bg-gray-950/60 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 whitespace-pre-wrap break-words">
            {stripAlertBlocks(streamText)}
            {writing && <div className="text-xs text-violet-300 mt-2">Préparation de la proposition…</div>}
            {streaming ? (
              <AiActivity state={activity} startedAt={startedAt} className={streamText ? "mt-2" : undefined} />
            ) : (
              <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-violet-300">
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />Lecture des chiffres du client…
              </div>
            )}
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
              L&apos;IA est injoignable pour le moment. Votre message est conservé dans la zone de saisie : réessayez dans quelques minutes.
              Vos alertes déjà en service continuent d&apos;être vérifiées.
              {error && <span className="block text-amber-400/70 mt-1">{error}</span>}
            </span>
          </div>
        ) : error ? (
          <div role="alert" className="text-xs text-red-400 break-words">{error}</div>
        ) : null}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="p-3 border-t border-gray-800">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            rows={Math.min(5, Math.max(2, input.split("\n").length + Math.floor(input.length / 80)))}
            placeholder={messages.length ? "Ex. : plutôt 70 €, et seulement du lundi au vendredi" : "Ex. : préviens-moi si le CPA dépasse 60 € sur 3 jours"}
            disabled={busy || !ready}
            aria-label="Votre demande à l'IA"
            className="flex-1 min-w-0 resize-none px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white placeholder:text-gray-600 focus:border-violet-500 focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !ready || !input.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
            <span className="hidden sm:inline">{busy ? "En cours…" : "Envoyer"}</span>
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-gray-600">
          Entrée pour envoyer, Maj + Entrée pour aller à la ligne.
          {figures?.ok && figures.until ? ` Chiffres du client lus jusqu'au ${dayLabel(figures.until)}.` : ""}
        </p>
      </form>
    </section>
  );
}
