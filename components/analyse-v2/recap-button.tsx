"use client";

/**
 * « Envoyer le récap sur Slack » (Leaderboard): previews the client's weekly
 * creative recap exactly as it will be posted in its #c_ channel, then posts
 * it on demand.
 */

import { useState } from "react";
import { Check, Loader2, Send, X } from "lucide-react";
import { PILL } from "./pill";

/** Slack mrkdwn → readable preview (links become their label, *bold*). */
function SlackPreview({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed text-gray-200">
      {text.split("\n").map((line, i) => (
        <div key={i}>
          {line.split(/(<[^>|]+\|[^>]+>|\*[^*]+\*)/g).map((part, j) => {
            const l = part.match(/^<([^>|]+)\|([^>]+)>$/);
            if (l) return <a key={j} href={l[1]} className="text-sky-300 hover:underline">{l[2]}</a>;
            const b = part.match(/^\*([^*]+)\*$/);
            if (b) return <strong key={j} className="text-white">{b[1]}</strong>;
            return <span key={j}>{part}</span>;
          })}
          {line === "" && <br />}
        </div>
      ))}
    </div>
  );
}

export function RecapButton({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ text: string | null; reason: string | null; channel: string | null; canSend: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function preview() {
    setOpen(true); setData(null); setSent(false); setError(null);
    const res = await fetch("/api/ads/weekly-recap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(j.error ?? `Erreur ${res.status}`); else setData(j);
  }
  async function send() {
    setBusy(true); setError(null);
    const res = await fetch("/api/ads/weekly-recap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, send: true }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) setError(j.error ?? `Erreur ${res.status}`); else setSent(true);
  }

  return (
    <>
      <button type="button" onClick={() => void preview()} className={PILL}><Send className="w-4 h-4 text-gray-400" />Récap Slack de la semaine</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="Récap de la semaine">
          <div className="absolute inset-0 bg-black/70" onClick={() => setOpen(false)} />
          <div className="relative w-[640px] max-w-full max-h-[85vh] rounded-2xl border border-gray-800 bg-gray-950 flex flex-col">
            <div className="flex items-center justify-between px-5 h-14 border-b border-gray-800 shrink-0">
              <h2 className="text-base font-semibold text-white">Récap créas de la semaine{data?.channel ? <span className="ml-2 text-sm font-normal text-gray-400">→ {data.channel}</span> : null}</h2>
              <button type="button" onClick={() => setOpen(false)} className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Fermer"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5">
              {!data && !error && <div className="py-10 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Préparation du récap…</div>}
              {data?.text && <div className="rounded-xl border border-gray-800 bg-gray-900 p-4"><SlackPreview text={data.text} /></div>}
              {data && !data.text && <div className="py-6 text-center text-sm text-gray-400">Rien à envoyer : {data.reason}</div>}
              {data?.text && !data.channel && <p className="mt-3 text-xs text-amber-300">Aucun salon Slack n&apos;est rattaché à ce client : un admin le choisit dans Admin › Alertes (rapprochement automatique par le nom c_…).</p>}
              {error && <div className="mt-3 text-sm text-red-300">{error}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-800 shrink-0">
              <span className="mr-auto text-xs text-gray-500">Envoi automatique chaque lundi matin une fois activé.</span>
              {sent ? <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300"><Check className="w-4 h-4" />Envoyé dans {data?.channel}</span> : (
                <button type="button" onClick={() => void send()} disabled={busy || !data?.canSend} className="h-9 inline-flex items-center gap-1.5 rounded-[10px] bg-white px-4 text-sm font-medium text-gray-900 hover:bg-gray-200 disabled:opacity-40">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}Envoyer{data?.channel ? ` dans ${data.channel}` : ""}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
