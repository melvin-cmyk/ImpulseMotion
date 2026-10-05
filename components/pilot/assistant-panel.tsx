"use client";

/**
 * Pilotage — talk to the AI about the client, then use its proposals.
 *
 * The AI reads every Meta and Google Ads account of the client (server side,
 * POST /api/pilot/assistant) and proposes changes in ```pilot blocks. Each
 * block is a card here; « Préparer l'aperçu » sends it to POST
 * /api/pilot/actions, the same preview as a change chosen by hand: read again
 * on the platform, then confirmed by the consultant in the panel « Modifier ».
 * Nothing is sent to a platform from this component.
 *
 * The conversation lives in the page (one per client), not in the database.
 */

import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, RotateCcw, Send, Sparkles } from "lucide-react";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { AiActivity } from "@/components/ai/activity";
import { Pill } from "@/components/ui/surface";
import { INITIAL_ACTIVITY, reduceActivity, type ActivityState } from "@/lib/ai-activity";
import { PLATFORM_FR, objectLabel } from "@/lib/pilot/ops";
import {
  PILOT_CHAT_MAX_MESSAGES, extractPilotProposals, stripPilotBlocks, validatePilotProposal, type PilotProposal,
} from "@/lib/pilot/assistant";
import { readJson, type PilotActionView, type PilotClient } from "@/components/pilot/model";

type Message = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "Fais-moi le point sur les 7 derniers jours, Meta et Google ensemble.",
  "Quelles campagnes dépensent sans convertir ?",
  "Propose une répartition du budget pour la semaine.",
];

const digits = (platform: string, id: string) => (platform === "meta" ? id.replace(/^act_/, "").trim() : id.replace(/-/g, "").replace(/^0+/, "").trim());
const sameAccount = (platform: string, a: string, b: string) => digits(platform, a) === digits(platform, b);

const newThread = () => Math.random().toString(36).slice(2, 10);

function ProposalCard({ proposal, client, onPrepared }: { proposal: PilotProposal; client: PilotClient; onPrepared: (action: PilotActionView) => void }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const check = validatePilotProposal(proposal, client.accounts, sameAccount);
  const account = client.accounts.find((a) => a.platform === proposal.platform && sameAccount(a.platform, a.accountId, proposal.accountId));

  async function prepare() {
    setBusy(true);
    setErrors([]);
    try {
      const res = await fetch("/api/pilot/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: client.id, accountId: proposal.accountId, platform: proposal.platform, requests: proposal.requests, why: proposal.why }),
      });
      const j = await readJson<{ action?: PilotActionView }>(res);
      if (!res.ok || !j.action) { setErrors(j.errors?.length ? j.errors : [j.error ?? `Erreur ${res.status}`]); return; }
      onPrepared(j.action);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-violet-500/40 bg-violet-500/5 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Sparkles className="w-3.5 h-3.5 text-violet-300" />
        <span className="font-semibold text-white">Proposition</span>
        <Pill tone="violet" className="text-[10px]">{PLATFORM_FR[proposal.platform]}</Pill>
        <span className="text-gray-400 truncate">« {account?.name ?? proposal.accountId} »</span>
      </div>
      <ul className="space-y-1 text-sm text-gray-200">
        {proposal.requests.map((r, i) => (
          <li key={`${r.objectId}-${r.kind}-${i}`} className="break-words">
            • {proposal.labels[i] || `${objectLabel(proposal.platform, r.objectType)} ${r.objectId} : ${r.kind} → ${r.value}`}
          </li>
        ))}
      </ul>
      {proposal.why && <p className="text-xs text-gray-400"><span className="text-gray-500">Pourquoi :</span> {proposal.why}</p>}
      {!check.ok && <p className="text-xs text-red-300">{check.error}</p>}
      {errors.length > 0 && <ul className="text-xs text-red-300 space-y-0.5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      <button type="button" onClick={() => void prepare()} disabled={busy || !check.ok}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs text-white font-medium">
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        Préparer l&apos;aperçu
      </button>
      <p className="text-[11px] text-gray-500">Rien n&apos;est envoyé ici : l&apos;aperçu relit les valeurs sur la plateforme, puis vous confirmez dans « Modifier ».</p>
    </div>
  );
}

export function PilotAssistant({ client, focus, onPrepared }: {
  client: PilotClient;
  /** The account open on the page: read first by the AI. */
  focus: { platform: string; accountId: string } | null;
  onPrepared: (action: PilotActionView) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState>(INITIAL_ACTIVITY);
  const [startedAt, setStartedAt] = useState(0);
  const [thread, setThread] = useState(newThread);
  const endRef = useRef<HTMLDivElement>(null);

  // One conversation per client.
  useEffect(() => { setMessages([]); setStreamText(null); setError(null); setThread(newThread()); }, [client.id]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages, streamText]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: Message[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setError(null);
    setBusy(true);
    setActivity(INITIAL_ACTIVITY);
    setStartedAt(Date.now());
    setStreamText("");
    let acc = "";
    try {
      const res = await fetch("/api/pilot/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: client.id, thread, focus, messages: next.slice(-PILOT_CHAT_MAX_MESSAGES) }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Erreur ${res.status}`);
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
          if (event.type === "delta" && typeof event.text === "string") { acc += event.text; setStreamText(acc); }
          else if (event.type === "content" && typeof event.text === "string" && !acc) { acc = event.text; setStreamText(acc); }
          else if (event.type === "error") {
            if (!acc.trim()) throw new Error(String(event.message ?? "Erreur de l'IA"));
            setError(String(event.message ?? "Erreur de l'IA"));
          }
        }
      }
      if (!acc.trim()) throw new Error("Réponse vide de l'IA — réessayez.");
      setMessages([...next, { role: "assistant", content: acc }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreamText(null);
      setBusy(false);
    }
  }

  const platforms = [...new Set(client.accounts.map((a) => PLATFORM_FR[a.platform]))].join(" + ");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-400">
          L&apos;IA lit les comptes {platforms} de {client.name} ({client.accounts.length}) et propose des modifications ; vous les vérifiez dans l&apos;aperçu avant tout envoi.
        </p>
        {messages.length > 0 && (
          <button type="button" onClick={() => { setMessages([]); setThread(newThread()); setError(null); }} disabled={busy}
            className="shrink-0 text-xs text-gray-500 hover:text-white flex items-center gap-1">
            <RotateCcw className="w-3.5 h-3.5" /> Nouvelle conversation
          </button>
        )}
      </div>

      <div className="max-h-[32rem] overflow-y-auto space-y-3 pr-1">
        {messages.length === 0 && !busy && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => void send(s)} className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-800 text-gray-300 hover:border-violet-500/60 hover:text-white">
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            {m.role === "user" ? (
              <div className="max-w-[85%] rounded-xl bg-violet-600/20 border border-violet-500/30 px-3 py-2 text-sm text-white whitespace-pre-wrap">{m.content}</div>
            ) : (
              <div className="flex gap-2">
                <Bot className="w-4 h-4 text-violet-300 shrink-0 mt-1" />
                <div className="min-w-0 flex-1">
                  <AiMarkdown content={stripPilotBlocks(m.content)} filesBase={null} className="prose prose-invert prose-sm max-w-none" />
                  {extractPilotProposals(m.content).map((p, j) => p.ok
                    ? <ProposalCard key={j} proposal={p.proposal} client={client} onPrepared={onPrepared} />
                    : <p key={j} className="mt-2 text-xs text-red-300">{p.error} Demandez à l&apos;IA de la reformuler.</p>)}
                </div>
              </div>
            )}
          </div>
        ))}
        {streamText !== null && (
          <div className="flex gap-2">
            <Bot className="w-4 h-4 text-violet-300 shrink-0 mt-1" />
            <div className="min-w-0 flex-1">
              {streamText && <AiMarkdown content={stripPilotBlocks(streamText)} filesBase={null} className="prose prose-invert prose-sm max-w-none" />}
              <AiActivity state={activity} startedAt={startedAt} className={streamText ? "mt-2" : undefined} />
            </div>
          </div>
        )}
        {error && <p className="text-sm text-red-300">{error}</p>}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
          rows={2}
          placeholder="Ex. : baisse de 20 % le budget des campagnes Meta dont le CPA dépasse 40 €"
          className="flex-1 resize-none bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-violet-500"
        />
        <button type="submit" disabled={busy || !input.trim()} className="p-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white" aria-label="Envoyer">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
    </div>
  );
}
