"use client";

/**
 * Copilote IA d'un dashboard du staff (/dashboards/[id], propriétaire ou admin).
 *
 * L'IA répond en flux et propose des changements en blocs ```action
 * (lib/staff-dashboards/proposals.ts) : titre, jeux de données, paramètres,
 * retouche de la page (edit_html) ou page entière (set_html). Chaque
 * proposition est une carte Appliquer / Refuser ; appliquer = relire le
 * dashboard, calculer le nouvel état, l'envoyer à PUT /api/staff-dashboards/[id]
 * (qui revalide), puis recharger le cadre. L'IA n'écrit jamais rien elle-même.
 *
 * Fil, statuts des propositions et empreinte de la page vue par l'IA sont
 * persistés (GET/PUT …/assistant) : ils survivent aux rechargements.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { AttachButton, MessageAttachments, PendingAttachments, useAttachments } from "@/components/ai/attachments";
import { ModelPicker } from "@/components/ai/model-picker";
import { AiActivity } from "@/components/ai/activity";
import { StaleBuildBanner } from "@/components/ai/stale-build";
import { AUTO_CONTINUE_PROMPT, INITIAL_ACTIVITY, MAX_AUTO_CONTINUES, reduceActivity, type ActivityState } from "@/lib/ai-activity";
import { FILES_NOTE_RE, filesNote, loadPrefs, savePrefs, DEFAULT_PREFS, type AiPrefs, type ChatFile, type ChatImage } from "@/lib/ai-chat-shared";
import {
  applyProposal, extractProposals, htmlHash, proposalLabel, stateDiff, stripProposalBlocks,
  type StaffDashboardState, type StaffProposal,
} from "@/lib/staff-dashboards/proposals";
import { apiErrorText, type DashboardDetail } from "./model";

interface ChatMessage { role: "user" | "assistant"; content: string; images?: ChatImage[]; files?: ChatFile[] }

type ProposalStatus = "pending" | "applying" | "applied" | "refused" | "failed" | "invalid";

interface Proposal {
  key: string;
  proposal: StaffProposal;
  status: ProposalStatus;
  error?: string;
}

const MAX_THREAD_MESSAGES = 40;
const PREFS_KEY = "staff-copilot:prefs";
const NOTES_RE = /^\[Résultat des propositions précédentes[^\]]*\]\n\n/;

export function toState(d: DashboardDetail): StaffDashboardState {
  return { title: d.title, description: d.description ?? "", datasets: d.datasets, params: d.params, html: d.html };
}

/** Les propositions d'un message, validées EN SÉQUENCE sur l'état donné (une retouche peut s'appuyer sur la précédente). */
function proposalsOf(content: string, msgIndex: number, state: StaffDashboardState, stored?: Record<string, string>): Record<string, Proposal> {
  const out: Record<string, Proposal> = {};
  let current = state;
  for (const { index, proposal } of extractProposals(content)) {
    const key = `${msgIndex}-${index}`;
    const storedStatus = stored?.[key] as ProposalStatus | undefined;
    if (stored) {
      // Un fil rechargé : les propositions sans statut sont périmées (le dashboard a bougé depuis).
      out[key] = { key, proposal, status: storedStatus ?? "refused" };
      continue;
    }
    try {
      current = applyProposal(current, proposal);
      out[key] = { key, proposal, status: "pending" };
    } catch (e) {
      out[key] = { key, proposal, status: "invalid", error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

function proposalPreview(p: StaffProposal): string {
  switch (p.action) {
    case "set_html": return p.html.length > 1500 ? `${p.html.slice(0, 1500)}\n… [+${(p.html.length - 1500).toLocaleString("fr-FR")} caractères]` : p.html;
    case "edit_html": return `− ${p.find.length > 600 ? `${p.find.slice(0, 600)}…` : p.find}\n+ ${p.replace.length > 600 ? `${p.replace.slice(0, 600)}…` : p.replace}`;
    default: return JSON.stringify(p, null, 1);
  }
}

export function StaffCopilotPanel({
  dashboard, onApplied, onClose, initialPrompt, sheetsShareEmail, flush, driveFolderUrl,
}: {
  dashboard: DashboardDetail;
  /** Après une proposition appliquée : le parent relit le dashboard et recharge le cadre. */
  onApplied: () => Promise<void> | void;
  onClose: () => void;
  /** Brief envoyé tout seul à l'ouverture si le fil est vide (création « Décrire à l'IA »). */
  initialPrompt?: string | null;
  sheetsShareEmail: string;
  /** Plein écran : plus d'en-tête d'application au-dessus, le panneau part du haut. */
  flush?: boolean;
  /** Dossier Drive de dépôt des fichiers pour les dashboards (lien), s'il est configuré. */
  driveFolderUrl?: string | null;
}) {
  const dashboardId = dashboard.id;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [prefs, setPrefs] = useState<AiPrefs>(DEFAULT_PREFS);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState>(INITIAL_ACTIVITY);
  const [startedAt, setStartedAt] = useState(0);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pendingNotesRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  const seenHashRef = useRef<string | null>(null);
  const dashboardRef = useRef(dashboard);
  dashboardRef.current = dashboard;
  const initialSentRef = useRef(false);

  const persist = useCallback((msgs: ChatMessage[], props: Record<string, Proposal>) => {
    const statuses: Record<string, string> = {};
    for (const [key, p] of Object.entries(props)) statuses[key] = p.status === "applying" ? "pending" : p.status;
    fetch(`/api/staff-dashboards/${encodeURIComponent(dashboardId)}/assistant`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: msgs.slice(-MAX_THREAD_MESSAGES), proposals: statuses, seenHtmlHash: seenHashRef.current }),
    }).catch(() => {});
  }, [dashboardId]);

  useEffect(() => {
    fetch(`/api/staff-dashboards/${encodeURIComponent(dashboardId)}/assistant`)
      .then((r) => (r.ok ? r.json() : { messages: [], proposals: {}, seenHtmlHash: null }))
      .then((j) => {
        if (busyRef.current) return;
        const msgs: ChatMessage[] = Array.isArray(j.messages) ? j.messages : [];
        const stored: Record<string, string> = j.proposals && typeof j.proposals === "object" ? j.proposals : {};
        seenHashRef.current = typeof j.seenHtmlHash === "string" ? j.seenHtmlHash : null;
        setMessages((current) => (current.length > 0 ? current : msgs));
        const all: Record<string, Proposal> = {};
        msgs.forEach((m, i) => { if (m.role === "assistant") Object.assign(all, proposalsOf(m.content, i, toState(dashboardRef.current), stored)); });
        setProposals((current) => (Object.keys(current).length > 0 ? current : all));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [dashboardId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streamText]);
  useEffect(() => { setPrefs(loadPrefs(PREFS_KEY)); }, []);

  function updatePrefs(patch: Partial<AiPrefs>) {
    setPrefs((prev) => { const next = { ...prev, ...patch }; savePrefs(PREFS_KEY, next); return next; });
  }

  const att = useAttachments({ uploadUrl: `/api/staff-dashboards/${encodeURIComponent(dashboardId)}/assistant/files`, disabled: busy });

  const send = useCallback(async (override?: string) => {
    const text = (override ?? input).trim();
    if ((!text && !att.hasPending) || busyRef.current || att.busy) return;
    const { images, files } = att.take();
    setInput("");
    setError(null);
    setTruncated(false);
    setBusy(true);
    busyRef.current = true;
    setActivity(INITIAL_ACTIVITY);
    setStartedAt(Date.now());
    setRound(0);

    const notes = pendingNotesRef.current;
    pendingNotesRef.current = [];
    const body = text || (files.length ? "Voici le(s) fichier(s), regarde-les." : images.length > 1 ? "Voici des images." : "Voici une image.");
    const content = (notes.length ? `[Résultat des propositions précédentes : ${notes.join(" ; ")}]\n\n${body}` : body) + filesNote(files);
    const previous = messages;
    const next: ChatMessage[] = [...previous, { role: "user", content, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }];
    setMessages(next);
    setStreamText("");

    let acc = "";
    let sawDone = false;
    try {
      let turn: ChatMessage[] = next;
      for (let attempt = 0; ; attempt++) {
        let resumable = false;
        sawDone = false;
        const res = await fetch(`/api/staff-dashboards/${encodeURIComponent(dashboardId)}/assistant`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: turn.slice(-MAX_THREAD_MESSAGES), model: prefs.model, effort: prefs.effort, account: prefs.account }),
        });
        if (!res.ok || !res.body) {
          const b = await res.json().catch(() => ({}));
          throw new Error(apiErrorText(b, res.status));
        }
        const pageHash = res.headers.get("X-Page-Hash");
        if (pageHash) seenHashRef.current = pageHash;
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
            else if (event.type === "done") sawDone = true;
            else if (event.type === "error" && event.resumable === true) resumable = true;
            else if (event.type === "error") {
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
      if (!acc.trim()) throw new Error("Réponse vide du copilote — réessayez");
      if (!sawDone) setTruncated(true);

      const finalMsgs: ChatMessage[] = [...next, { role: "assistant", content: acc }];
      setMessages(finalMsgs);
      const fresh = proposalsOf(acc, finalMsgs.length - 1, toState(dashboardRef.current));
      setProposals((prev) => {
        const merged = { ...prev, ...fresh };
        persist(finalMsgs, merged);
        return merged;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages(previous);
      setInput(text);
      att.restore(images, files);
    } finally {
      setBusy(false);
      busyRef.current = false;
      setStreamText(null);
    }
  }, [att, dashboardId, input, messages, persist, prefs]);

  // Création « Décrire à l'IA » : le brief part tout seul, une fois, sur un fil vide.
  useEffect(() => {
    if (!loaded || initialSentRef.current || !initialPrompt || messages.length > 0 || busyRef.current) return;
    initialSentRef.current = true;
    void send(initialPrompt);
  }, [loaded, initialPrompt, messages.length, send]);

  function updateProposal(key: string, patch: Partial<Proposal>) {
    setProposals((prev) => {
      const merged = { ...prev, [key]: { ...prev[key], ...patch } };
      persist(messages, merged);
      return merged;
    });
  }

  /** Applique une proposition sur l'état COURANT du serveur (pas celui affiché), puis recharge. */
  async function apply(p: Proposal): Promise<boolean> {
    updateProposal(p.key, { status: "applying" });
    const label = proposalLabel(p.proposal);
    try {
      const got = await fetch(`/api/staff-dashboards/${encodeURIComponent(dashboardId)}`);
      const body = await got.json().catch(() => ({}));
      if (!got.ok || !body.dashboard) throw new Error(apiErrorText(body, got.status));
      const before = toState(body.dashboard as DashboardDetail);
      const after = applyProposal(before, p.proposal);
      const diff = stateDiff(before, after);
      if (Object.keys(diff).length) {
        const res = await fetch(`/api/staff-dashboards/${encodeURIComponent(dashboardId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(diff),
        });
        const rb = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(apiErrorText(rb, res.status));
      }
      // La page appliquée est celle que l'IA a écrite : inutile de la lui renvoyer.
      if (diff.html !== undefined) seenHashRef.current = htmlHash(after.html);
      pendingNotesRef.current.push(`« ${label} » appliquée`);
      updateProposal(p.key, { status: "applied" });
      await onApplied();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      pendingNotesRef.current.push(`« ${label} » a ÉCHOUÉ : ${message}`);
      updateProposal(p.key, { status: "failed", error: message });
      return false;
    }
  }

  async function applyAll(keys: string[]) {
    for (const key of keys) {
      const p = proposals[key];
      if (!p || p.status !== "pending") continue;
      if (!(await apply(p))) break;
    }
  }

  function refuse(p: Proposal) {
    pendingNotesRef.current.push(`« ${proposalLabel(p.proposal)} » refusée par le consultant`);
    updateProposal(p.key, { status: "refused" });
  }

  const filesBase = `/api/staff-dashboards/${encodeURIComponent(dashboardId)}/assistant/files`;

  function renderMessage(m: ChatMessage, i: number) {
    if (m.role === "user") {
      return (
        <div key={i} className="ml-8 bg-violet-950/50 border border-violet-900/40 rounded-xl px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap">
          <MessageAttachments images={m.images} files={m.files} />
          {m.content.replace(NOTES_RE, "").replace(FILES_NOTE_RE, "")}
        </div>
      );
    }
    const clean = stripProposalBlocks(m.content);
    const mine = Object.values(proposals).filter((p) => p.key.startsWith(`${i}-`)).sort((a, b) => Number(a.key.split("-")[1]) - Number(b.key.split("-")[1]));
    const pendingKeys = mine.filter((p) => p.status === "pending").map((p) => p.key);
    return (
      <div key={i} className="mr-4 space-y-2">
        {clean && (
          <AiMarkdown content={clean} filesBase={filesBase} className="prose prose-invert prose-sm max-w-none text-gray-300 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2" />
        )}
        {mine.map((p) => (
          <div key={p.key} className={`bg-gray-900 border rounded-xl px-3 py-2 ${p.status === "invalid" ? "border-amber-800/60" : "border-violet-800/50"}`}>
            <div className="text-xs font-semibold text-violet-300">{proposalLabel(p.proposal)}</div>
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-gray-500 hover:text-gray-300">Détail</summary>
              <pre className="text-[10px] text-gray-400 mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">{proposalPreview(p.proposal)}</pre>
            </details>
            {p.status === "invalid" ? (
              <div className="text-[11px] mt-1 text-amber-400">Proposition inapplicable : {p.error} — reformulez votre demande.</div>
            ) : p.status === "pending" || p.status === "applying" ? (
              <div className="flex gap-2 mt-2">
                <button type="button" disabled={p.status === "applying"} onClick={() => void apply(p)} className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50">
                  {p.status === "applying" ? "Application…" : "Appliquer"}
                </button>
                <button type="button" disabled={p.status === "applying"} onClick={() => refuse(p)} className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50">
                  Refuser
                </button>
              </div>
            ) : (
              <div className={`text-[11px] mt-1 ${p.status === "applied" ? "text-emerald-400" : p.status === "failed" ? "text-red-400" : "text-gray-500"}`}>
                {p.status === "applied" ? "✓ Appliqué — la page a été rechargée" : p.status === "failed" ? `Échec : ${p.error}` : "Refusé"}
              </div>
            )}
          </div>
        ))}
        {pendingKeys.length > 1 && (
          <button type="button" onClick={() => void applyAll(pendingKeys)} className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-violet-700 hover:bg-violet-600 text-white">
            Tout appliquer ({pendingKeys.length}) dans l&apos;ordre
          </button>
        )}
      </div>
    );
  }

  return (
    <aside className={`fixed right-0 ${flush ? "top-0" : "top-12"} bottom-0 w-full sm:w-[440px] bg-gray-950 border-l border-gray-800 flex flex-col z-40 shadow-2xl`}>
      <div className="px-4 py-3 border-b border-gray-800 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-white">Copilote IA</h2>
            <p className="text-[11px] text-gray-500">Construit et modifie la page — rien n&apos;est appliqué sans validation</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-white text-sm">✕</button>
        </div>
        <ModelPicker prefs={prefs} onChange={updatePrefs} disabled={busy} idPrefix="staff-copilot" />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        <StaleBuildBanner />
        {messages.length === 0 && !streamText && (
          <div className="text-xs text-gray-500 bg-gray-900 border border-gray-800 rounded-xl px-3 py-3 space-y-1.5">
            <p>
              Exemples : « Ajoute un tableau des 10 campagnes les plus dépensières », « Passe les montants en euros », « Ajoute une source Meta sur le compte act_… et une courbe de dépense par jour », « Construis une page de pacing budget pour ce client ».
            </p>
            <p>
              L&apos;IA lit la page et les sources, teste les requêtes sur les vrais comptes, puis propose des modifications que vous appliquez. Joignez une capture d&apos;écran d&apos;un dashboard à reproduire avec le trombone.
              Un Google Sheet comme source ? Partagez-le avec <span className="text-gray-300">{sheetsShareEmail}</span> puis donnez le lien et l&apos;onglet.
            </p>
            {driveFolderUrl && (
              <p>
                Fichiers de l&apos;équipe (CSV, Excel, Sheets) : déposez-les dans le{" "}
                <a href={driveFolderUrl} target="_blank" rel="noreferrer" className="text-violet-300 underline decoration-dotted hover:text-white">dossier Drive des dashboards</a>
                {" "}puis dites à l&apos;IA lequel utiliser : elle le lit, et le convertit en Google Sheet pour en faire une source de la page.
              </p>
            )}
          </div>
        )}
        {messages.map(renderMessage)}
        {streamText !== null && (
          <div className="mr-4 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 whitespace-pre-wrap break-words">
            {streamText.length > 4000 ? `${streamText.slice(0, 1500)}\n\n… [rédaction en cours : ${streamText.length.toLocaleString("fr-FR")} caractères]` : streamText}
            <AiActivity state={activity} startedAt={startedAt} round={round} className={streamText ? "mt-2" : undefined} />
          </div>
        )}
        {truncated && (
          <div className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
            La réponse a peut-être été interrompue — si une proposition manque, redemandez-la.
          </div>
        )}
        {error && <div className="text-xs text-red-400 break-words">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void send(); }} onDragOver={att.onDragOver} onDrop={att.onDrop} className="p-3 border-t border-gray-800 space-y-2">
        <PendingAttachments att={att} />
        {att.error && <div className="text-[11px] text-amber-400">{att.error}</div>}
        <div className="flex gap-2">
          <AttachButton att={att} disabled={busy} />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={att.onPaste}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={att.hasPending ? "Que faire de ces fichiers ?" : "Décrivez la modification ou la page à construire…"}
            disabled={busy}
            rows={2}
            className="flex-1 min-w-0 px-3 py-2 rounded-lg text-sm bg-gray-900 border border-gray-800 text-white focus:border-violet-500 focus:outline-none disabled:opacity-60 resize-y"
          />
          <button type="submit" disabled={busy || att.busy || (!input.trim() && !att.hasPending)} className="px-3 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50 self-end">
            {busy ? "…" : "Envoyer"}
          </button>
        </div>
      </form>
    </aside>
  );
}
