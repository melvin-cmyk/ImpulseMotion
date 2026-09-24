"use client";

/**
 * Consultant copilot panel on /d/[id] (staff only).
 *
 * The AI streams a reply and proposes dashboard changes as ```action blocks;
 * each proposal renders as a card with Appliquer / Refuser. Applying goes
 * through the regular widget CRUD APIs (validation + ACL server-side) — the
 * AI itself never writes anything.
 *
 * Reliability contract (hardened after the multi-agent review):
 * - proposals are validated client-side BEFORE showing an Appliquer button
 * - block extraction tolerates ```action, ```json and untagged fences
 * - proposal statuses persist with the thread (survive reloads)
 * - a stream that ends without a `done` event is flagged as truncated
 * - apply successes/failures are fed back to the model on the next message
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { validateWidgetConfig, validateWidgetWidth, type ResolvedWidget } from "@/lib/dashboard-types";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { AttachButton, MessageAttachments, PendingAttachments, useAttachments } from "@/components/ai/attachments";
import { ModelPicker } from "@/components/ai/model-picker";
import { FILES_NOTE_RE, filesNote, loadPrefs, savePrefs, DEFAULT_PREFS, type AiPrefs, type ChatFile, type ChatImage } from "@/lib/ai-chat-shared";

interface ChatMessage { role: "user" | "assistant"; content: string; images?: ChatImage[]; files?: ChatFile[] }

type ProposalStatus = "pending" | "applying" | "applied" | "refused" | "failed" | "invalid";

interface Proposal {
  key: string;
  action: Record<string, unknown>;
  status: ProposalStatus;
  error?: string;
}

const MAX_THREAD_MESSAGES = 40;

const PREFS_KEY = "copilot:prefs";

// Tolerant fence matcher: ```action, ```json, or bare ``` — the JSON content
// decides whether it's really a proposal.
const FENCE_RE = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g;

function parseActionBlock(inner: string): Record<string, unknown> | null {
  const text = inner.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") return parsed;
  } catch { /* not a proposal */ }
  return null;
}

/** Validate a proposal locally so a doomed Appliquer click never renders. */
function validateProposal(
  action: Record<string, unknown>,
  widgets: ResolvedWidget[],
): string | null {
  try {
    switch (action.action) {
      case "add_widget":
        validateWidgetConfig(String(action.type ?? ""), action.config ?? {});
        if (action.width !== undefined) validateWidgetWidth(action.width);
        return null;
      case "update_widget": {
        const target = widgets.find((w) => w.id === action.widgetId);
        if (!target) return `Widget introuvable: ${String(action.widgetId ?? "?")} — demandez à l'IA de relister les widgets`;
        if (action.config !== undefined) {
          validateWidgetConfig(target.type, { ...target.config, ...(action.config as Record<string, unknown>) });
        }
        return null;
      }
      case "remove_widget":
        return widgets.some((w) => w.id === action.widgetId)
          ? null
          : `Widget introuvable: ${String(action.widgetId ?? "?")}`;
      case "reorder": {
        if (!Array.isArray(action.order)) return "reorder: 'order' doit être une liste d'ids";
        const known = new Set(widgets.map((w) => w.id));
        const stale = (action.order as string[]).filter((id) => !known.has(id));
        return stale.length ? `Ids inconnus dans l'ordre: ${stale.join(", ")}` : null;
      }
      default:
        return `Action inconnue: ${String(action.action)}`;
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function extractProposals(content: string, msgIndex: number): Array<{ key: string; action: Record<string, unknown> }> {
  const out: Array<{ key: string; action: Record<string, unknown> }> = [];
  let m: RegExpExecArray | null;
  let i = 0;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(content))) {
    const action = parseActionBlock(m[1]);
    if (action) out.push({ key: `${msgIndex}-${i}`, action });
    i++;
  }
  return out;
}

/** Strip only the fences that parsed as proposals — malformed blocks stay
 *  visible as text instead of vanishing. */
function stripProposalBlocks(content: string): string {
  return content.replace(FENCE_RE, (full, inner) => (parseActionBlock(inner) ? "" : full)).trim();
}

function proposalLabel(action: Record<string, unknown>, widgets: ResolvedWidget[]): string {
  const widgetName = (id: unknown) => {
    const w = widgets.find((x) => x.id === id);
    return w ? `« ${w.title ?? w.type} »` : String(id ?? "").slice(0, 8) + "…";
  };
  switch (action.action) {
    case "add_widget":
      return `Ajouter un widget ${action.type}${action.title ? ` « ${action.title} »` : ""}`;
    case "update_widget":
      return `Modifier le widget ${widgetName(action.widgetId)}`;
    case "remove_widget":
      return `Supprimer le widget ${widgetName(action.widgetId)}`;
    case "reorder":
      return "Réorganiser les widgets";
    default:
      return `Action inconnue : ${String(action.action)}`;
  }
}

export function CopilotPanel({
  dashboardId, widgets, onApplied, onClose, sheetsShareEmail,
}: {
  dashboardId: string;
  widgets: ResolvedWidget[];
  onApplied: () => void;
  onClose: () => void;
  /** Google account the consultant must share a Sheet with (editor) so the copilot can read it. */
  sheetsShareEmail: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [input, setInput] = useState("");
  const [prefs, setPrefs] = useState<AiPrefs>(DEFAULT_PREFS);
  const [showSheetHelp, setShowSheetHelp] = useState(false);
  const [memorizing, setMemorizing] = useState(false);
  const [memoNote, setMemoNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Results of applied/refused/failed proposals, fed to the model next turn.
  const pendingNotesRef = useRef<string[]>([]);
  const busyRef = useRef(false);

  useEffect(() => {
    fetch(`/api/dashboards/${dashboardId}/assistant`)
      .then((r) => (r.ok ? r.json() : { messages: [], proposals: {} }))
      .then((j) => {
        // Never clobber a conversation already in flight in this panel.
        if (busyRef.current) return;
        const msgs: ChatMessage[] = Array.isArray(j.messages) ? j.messages : [];
        const stored: Record<string, string> = j.proposals && typeof j.proposals === "object" ? j.proposals : {};
        setMessages((current) => (current.length > 0 ? current : msgs));
        const all: Record<string, Proposal> = {};
        msgs.forEach((m, i) => {
          if (m.role !== "assistant") return;
          for (const p of extractProposals(m.content, i)) {
            const storedStatus = stored[p.key] as ProposalStatus | undefined;
            // Historic proposals without a stored status are stale — the
            // dashboard has moved on; mark them expired-as-refused.
            all[p.key] = { ...p, status: storedStatus ?? "refused" };
          }
        });
        setProposals((current) => (Object.keys(current).length > 0 ? current : all));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  useEffect(() => { setPrefs(loadPrefs(PREFS_KEY)); }, []);

  function updatePrefs(patch: Partial<AiPrefs>) {
    setPrefs((prev) => { const next = { ...prev, ...patch }; savePrefs(PREFS_KEY, next); return next; });
  }

  const att = useAttachments({ uploadUrl: `/api/dashboards/${dashboardId}/assistant/files`, disabled: busy });

  const persist = useCallback((msgs: ChatMessage[], props: Record<string, Proposal>) => {
    const statuses: Record<string, string> = {};
    for (const [key, p] of Object.entries(props)) statuses[key] = p.status === "applying" ? "pending" : p.status;
    fetch(`/api/dashboards/${dashboardId}/assistant`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: msgs.slice(-MAX_THREAD_MESSAGES), proposals: statuses }),
    }).catch(() => {});
  }, [dashboardId]);

  /** Summarise the thread into a dated note in the client's HQ project journal. */
  async function memorize() {
    if (memorizing || busy || messages.length < 2) return;
    setMemorizing(true);
    setMemoNote(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/assistant/memorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messages.slice(-MAX_THREAD_MESSAGES).map((m) => ({ role: m.role, content: m.content })) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
      setMemoNote({ ok: true, text: `Note ajoutée au journal HQ du projet « ${body.project} ».` });
      pendingNotesRef.current.push("les conclusions de la conversation ont été consignées dans le journal HQ du client");
    } catch (e) {
      setMemoNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setMemorizing(false);
    }
  }

  function copyShareEmail() {
    navigator.clipboard?.writeText(sheetsShareEmail).then(() => {
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 1500);
    }).catch(() => {});
  }

  async function send() {
    const text = input.trim();
    if ((!text && !att.hasPending) || busy || att.busy) return;
    const { images, files } = att.take();
    setInput("");
    setError(null);
    setTruncated(false);
    setBusy(true);
    busyRef.current = true;
    setToolNote(null);

    // Feed apply outcomes back so the model can correct itself.
    const notes = pendingNotesRef.current;
    pendingNotesRef.current = [];
    const body = text || (files.length ? "Voici le(s) fichier(s), analyse-les." : images.length > 1 ? "Voici des images." : "Voici une image.");
    // Uploaded documents live in the sandbox workspace: tell the model where.
    const content = (notes.length
      ? `[Résultat des propositions précédentes : ${notes.join(" ; ")}]\n\n${body}`
      : body) + filesNote(files);

    const next: ChatMessage[] = [...messages, { role: "user" as const, content, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }];
    setMessages(next);
    setStreamText("");

    let acc = "";
    let sawDone = false;
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(-MAX_THREAD_MESSAGES), model: prefs.model, effort: prefs.effort }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
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
          if (event.type === "delta" && typeof event.text === "string") {
            acc += event.text;
            setStreamText(acc);
          } else if (event.type === "content" && typeof event.text === "string" && !acc) {
            acc = event.text;
            setStreamText(acc);
          } else if (event.type === "tool_call") {
            setToolNote(`Outil : ${String(event.name ?? "…")}`);
          } else if (event.type === "done") {
            sawDone = true;
          } else if (event.type === "error") {
            // Keep partial text if any — surface the error alongside.
            if (!acc.trim()) throw new Error(String(event.message ?? "Erreur IA"));
            setError(String(event.message ?? "Erreur IA"));
          }
        }
      }
      if (!acc.trim()) throw new Error("Réponse vide du copilote — réessayez");
      if (!sawDone) setTruncated(true);

      const finalMsgs: ChatMessage[] = [...next, { role: "assistant" as const, content: acc }];
      setMessages(finalMsgs);
      const newProposals: Record<string, Proposal> = {};
      for (const p of extractProposals(acc, finalMsgs.length - 1)) {
        const invalid = validateProposal(p.action, widgets);
        newProposals[p.key] = invalid
          ? { ...p, status: "invalid", error: invalid }
          : { ...p, status: "pending" };
      }
      setProposals((prev) => {
        const merged = { ...prev, ...newProposals };
        persist(finalMsgs, merged);
        return merged;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages(messages); // roll back the user message on failure
      setInput(text);
      att.restore(images, files);
    } finally {
      setBusy(false);
      busyRef.current = false;
      setStreamText(null);
      setToolNote(null);
    }
  }

  function updateProposal(key: string, patch: Partial<Proposal>) {
    setProposals((prev) => {
      const merged = { ...prev, [key]: { ...prev[key], ...patch } };
      persist(messages, merged);
      return merged;
    });
  }

  async function applyProposal(p: Proposal) {
    updateProposal(p.key, { status: "applying" });
    const a = p.action;
    let res: Response;
    try {
      switch (a.action) {
        case "add_widget":
          res = await fetch(`/api/dashboards/${dashboardId}/widgets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: a.type, title: a.title ?? null, width: a.width ?? "half", config: a.config ?? {}, pageId: typeof a.pageId === "string" ? a.pageId : null }),
          });
          break;
        case "update_widget": {
          const patch: Record<string, unknown> = {};
          if (a.title !== undefined) patch.title = a.title;
          if (a.width !== undefined) patch.width = a.width;
          if (a.config !== undefined) patch.config = a.config;
          res = await fetch(`/api/dashboards/${dashboardId}/widgets/${a.widgetId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          break;
        }
        case "remove_widget":
          res = await fetch(`/api/dashboards/${dashboardId}/widgets/${a.widgetId}`, { method: "DELETE" });
          break;
        case "reorder":
          res = await fetch(`/api/dashboards/${dashboardId}/widgets`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: a.order }),
          });
          break;
        default:
          throw new Error(`Action non supportée : ${String(a.action)}`);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Erreur ${res.status}`);
      }
      pendingNotesRef.current.push(`"${proposalLabel(a, widgets)}" appliquée avec succès`);
      updateProposal(p.key, { status: "applied" });
      onApplied();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      pendingNotesRef.current.push(`"${proposalLabel(a, widgets)}" a ÉCHOUÉ : ${message}`);
      updateProposal(p.key, { status: "failed", error: message });
    }
  }

  function refuseProposal(p: Proposal) {
    pendingNotesRef.current.push(`"${proposalLabel(p.action, widgets)}" refusée par le consultant`);
    updateProposal(p.key, { status: "refused" });
  }

  const filesBase = `/api/dashboards/${dashboardId}/assistant/files`;

  function renderMessage(m: ChatMessage, i: number) {
    if (m.role === "user") {
      return (
        <div key={i} className="ml-8 bg-violet-950/50 border border-violet-900/40 rounded-xl px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap">
          <MessageAttachments images={m.images} files={m.files} />
          {m.content.replace(/^\[Résultat des propositions précédentes[^\]]*\]\n\n/, "").replace(FILES_NOTE_RE, "")}
        </div>
      );
    }
    const clean = stripProposalBlocks(m.content);
    const msgProposals = Object.values(proposals).filter((p) => p.key.startsWith(`${i}-`));
    return (
      <div key={i} className="mr-4 space-y-2">
        {clean && (
          <AiMarkdown content={clean} filesBase={filesBase} className="prose prose-invert prose-sm max-w-none text-gray-300 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2" />
        )}
        {msgProposals.map((p) => (
          <div key={p.key} className={`bg-gray-900 border rounded-xl px-3 py-2 ${p.status === "invalid" ? "border-amber-800/60" : "border-violet-800/50"}`}>
            <div className="text-xs font-semibold text-violet-300">{proposalLabel(p.action, widgets)}</div>
            <pre className="text-[10px] text-gray-500 mt-1 overflow-x-auto">{JSON.stringify(p.action, null, 1)}</pre>
            {p.status === "invalid" ? (
              <div className="text-[11px] mt-1 text-amber-400">
                Proposition invalide : {p.error} — reformulez votre demande.
              </div>
            ) : p.status === "pending" || p.status === "applying" ? (
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  disabled={p.status === "applying"}
                  onClick={() => applyProposal(p)}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
                >
                  {p.status === "applying" ? "Application…" : "Appliquer"}
                </button>
                <button
                  type="button"
                  onClick={() => refuseProposal(p)}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300"
                >
                  Refuser
                </button>
              </div>
            ) : (
              <div className={`text-[11px] mt-1 ${p.status === "applied" ? "text-emerald-400" : p.status === "failed" ? "text-red-400" : "text-gray-500"}`}>
                {p.status === "applied" ? "✓ Appliqué — le dashboard est à jour" : p.status === "failed" ? `Échec : ${p.error}` : "Refusé"}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <aside className="fixed right-0 top-12 bottom-0 w-full sm:w-[420px] bg-gray-950 border-l border-gray-800 flex flex-col z-40 shadow-2xl">
      <div className="px-4 py-3 border-b border-gray-800 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-white">Copilote IA</h2>
            <p className="text-[11px] text-gray-500">Propose des widgets — rien n&apos;est appliqué sans validation</p>
          </div>
          <div className="flex items-center gap-2">
            {messages.length >= 2 && (
              <button
                type="button"
                onClick={memorize}
                disabled={memorizing || busy}
                title="Résume les conclusions de cette conversation dans le journal HQ du client"
                className="px-2 py-1 rounded-md text-[11px] font-semibold bg-gray-900 border border-gray-800 text-gray-300 hover:text-white hover:border-violet-700 disabled:opacity-50"
              >
                {memorizing ? "Mémorisation…" : "Mémoriser dans HQ"}
              </button>
            )}
            <button type="button" onClick={onClose} className="text-gray-500 hover:text-white text-sm">✕</button>
          </div>
        </div>
        {memoNote && (
          <div className={`text-[11px] rounded-md px-2 py-1 border ${memoNote.ok ? "text-emerald-300 bg-emerald-950/30 border-emerald-900/50" : "text-amber-300 bg-amber-950/30 border-amber-900/50"}`}>
            {memoNote.text}
          </div>
        )}
        <ModelPicker prefs={prefs} onChange={updatePrefs} disabled={busy} idPrefix="copilot" />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && !streamText && (
          <div className="text-xs text-gray-500 bg-gray-900 border border-gray-800 rounded-xl px-3 py-3 space-y-1.5">
            <p>
              Exemples : « Ajoute une courbe du ROAS sur 90 jours », « Passe le tableau
              Google en pleine largeur », « Que dire des perfs de ce compte ? »
            </p>
            <p>
              Joignez des images, Excel, CSV, PDF ou Word avec le trombone, en les collant ou en les déposant :
              l&apos;IA les analyse avec Python et peut produire graphiques et exports.
              Un Google Sheet vivant ? Partagez-le avec <span className="text-gray-300">{sheetsShareEmail}</span> puis collez le lien.
            </p>
          </div>
        )}
        {messages.map(renderMessage)}
        {streamText !== null && (
          <div className="mr-4 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 whitespace-pre-wrap">
            {streamText || "…"}
            {toolNote && <div className="text-[11px] text-violet-400 mt-1">{toolNote}</div>}
          </div>
        )}
        {truncated && (
          <div className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
            La réponse a peut-être été interrompue — si une proposition manque, redemandez-la.
          </div>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        onDragOver={att.onDragOver}
        onDrop={att.onDrop}
        className="p-3 border-t border-gray-800 space-y-2"
      >
        {showSheetHelp && (
          <div className="text-[11px] text-gray-300 bg-gray-900 border border-violet-900/50 rounded-lg px-3 py-2 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div className="font-semibold text-violet-300">Partager un Excel ou un CSV</div>
              <button type="button" onClick={() => setShowSheetHelp(false)} className="text-gray-500 hover:text-white">✕</button>
            </div>
            <ol className="list-decimal pl-4 space-y-0.5 text-gray-400">
              <li>Importez le fichier dans Google Sheets (Fichier → Importer).</li>
              <li>
                Partagez la feuille avec{" "}
                <button type="button" onClick={copyShareEmail} title="Copier l'adresse" className="font-mono text-gray-200 hover:text-white underline decoration-dotted">
                  {sheetsShareEmail}
                </button>{" "}
                en <span className="text-gray-200">Éditeur</span>.{copiedEmail && <span className="text-emerald-400"> Copié</span>}
              </li>
              <li>Collez le lien de la feuille ici, avec le nom de l&apos;onglet à lire.</li>
            </ol>
          </div>
        )}
        <PendingAttachments att={att} />
        {att.error && <div className="text-[11px] text-amber-400">{att.error}</div>}
        <div className="flex gap-2">
          <AttachButton att={att} disabled={busy} />
          <button
            type="button"
            onClick={() => setShowSheetHelp((v) => !v)}
            title="Partager un Google Sheet vivant avec le copilote"
            aria-label="Aide Google Sheets"
            className="px-2.5 py-2 rounded-lg text-sm bg-gray-900 border border-gray-800 text-gray-400 hover:text-white hover:border-gray-600"
          >
            ▦
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={att.onPaste}
            placeholder={att.hasPending ? "Que faire de ces fichiers ?" : "Demandez un ajout, une analyse…"}
            disabled={busy}
            className="flex-1 min-w-0 px-3 py-2 rounded-lg text-sm bg-gray-900 border border-gray-800 text-white focus:border-violet-500 focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || att.busy || (!input.trim() && !att.hasPending)}
            className="px-3 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
          >
            {busy ? "…" : "Envoyer"}
          </button>
        </div>
      </form>
    </aside>
  );
}
