"use client";

/**
 * The changes chosen in the tree (or proposed by the AI), then their preview,
 * then what the platform (Meta or Google Ads) did.
 *
 *   1. list   — what will be asked, why, the goal, the HQ folder;
 *   2. preview — each change as the server read it on Meta now (before → after),
 *                with what asks for a second confirmation and what cannot be undone;
 *   3. result — each change applied, refused or unknown, and the HQ entry.
 *
 * Nothing reaches the platform before « Envoyer à … » on the preview, and a preview
 * that asks for it needs the second confirmation ticked first.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Send, Trash2, X, XCircle } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { GOAL_METRICS, GOAL_METRIC_FR, PLATFORM_FR, type GoalMetric } from "@/lib/pilot/ops";
import { readJson, type PendingChange, type PilotActionView } from "@/components/pilot/model";

const OP_STATUS: Record<string, { text: string; tone: "emerald" | "red" | "amber" | "default" }> = {
  done: { text: "appliqué", tone: "emerald" },
  unchanged: { text: "déjà en place", tone: "default" },
  failed: { text: "refusé", tone: "red" },
  uncertain: { text: "issue inconnue", tone: "amber" },
  conflict: { text: "non envoyé", tone: "amber" },
  skipped: { text: "non envoyé", tone: "default" },
  pending: { text: "à envoyer", tone: "default" },
};

export function OperationLines({ action, showStatus }: { action: PilotActionView; showStatus: boolean }) {
  return (
    <ul className="space-y-1.5">
      {action.operations.map((op) => {
        const s = OP_STATUS[op.status] ?? OP_STATUS.pending;
        return (
          <li key={op.id} className="text-sm text-gray-200">
            <div className="flex items-start gap-2">
              <span className="flex-1 min-w-0 break-words">{op.line}</span>
              {showStatus && <Pill tone={s.tone} className="text-[10px] shrink-0">{s.text}</Pill>}
            </div>
            {!showStatus && (op.double || op.irreversible) && (
              <div className="flex flex-wrap gap-1 mt-1">
                {op.double && <Pill tone="amber" className="text-[10px] normal-case">seconde confirmation : {op.double}</Pill>}
                {op.irreversible && <Pill tone="red" className="text-[10px] normal-case">ne peut pas être annulé</Pill>}
              </div>
            )}
            {showStatus && op.error && op.status !== "done" && <p className="text-xs text-gray-400 mt-0.5">{op.error}</p>}
          </li>
        );
      })}
    </ul>
  );
}

const words = (v: string) => new Set(v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));

/** The folder chosen does not look like the client's: said before anything is written in it. */
function folderMismatch(clientName: string, slug: string, name: string | undefined, known: string | null): boolean {
  if (!slug || slug === known) return false;
  const client = words(clientName);
  const folder = new Set([...words(slug), ...words(name ?? "")]);
  return ![...client].some((w) => folder.has(w));
}

export function ChangePanel({ clientId, clientName, accountId, platform, writesOpen, hqDefault, pending, onRemove, onClear, preview, onPreview, onSent }: {
  clientId: string;
  clientName: string;
  accountId: string;
  platform: "meta" | "google" | "tiktok";
  /** PILOT_WRITES: closed during the trial, the preview still works. */
  writesOpen: boolean;
  hqDefault: string | null;
  pending: PendingChange[];
  onRemove: (index: number) => void;
  onClear: () => void;
  /** A preview prepared here, or by « Annuler cette modification » in the journal. */
  preview: PilotActionView | null;
  onPreview: (action: PilotActionView | null) => void;
  onSent: (action: PilotActionView) => void;
}) {
  const [why, setWhy] = useState("");
  const [metric, setMetric] = useState<GoalMetric | "">("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [hqProject, setHqProject] = useState(hqDefault ?? "");
  const [projects, setProjects] = useState<Array<{ slug: string; name: string }> | null>(null);
  const [confirmDouble, setConfirmDouble] = useState(false);
  const [busy, setBusy] = useState<"prepare" | "send" | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<PilotActionView | null>(null);

  useEffect(() => { setHqProject(hqDefault ?? ""); }, [hqDefault]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/relay/hq-projects")
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((j) => { if (!cancelled) setProjects(Array.isArray(j.projects) ? j.projects : []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);
  // A preview from the journal (an undo) brings its own reason.
  useEffect(() => {
    if (!preview) return;
    setConfirmDouble(false);
    setErrors([]);
    setResult(null);
    // An undo or a proposal of the AI brings its own reason.
    if (preview.why) setWhy(preview.why);
    if (preview.hqProject) setHqProject(preview.hqProject);
  }, [preview]);

  const goal = { metric: metric || null, target: target.trim() ? Number(target.replace(",", ".")) : null, note: note.trim() };

  async function prepare() {
    setBusy("prepare");
    setErrors([]);
    setResult(null);
    try {
      const res = await fetch("/api/pilot/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, accountId, platform, requests: pending.map(({ kind, objectType, objectId, value }) => ({ kind, objectType, objectId, value })), why, goal }),
      });
      const j = await readJson<{ action?: PilotActionView }>(res);
      if (!res.ok || !j.action) { setErrors(j.errors?.length ? j.errors : [j.error ?? `Erreur ${res.status}`]); return; }
      setConfirmDouble(false);
      onPreview(j.action);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!preview) return;
    setBusy("send");
    setErrors([]);
    try {
      const res = await fetch(`/api/pilot/actions/${preview.id}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ why, goal: preview.undoOfId ? preview.goal : goal, hqProject, confirmDouble }),
      });
      const j = await readJson<{ action?: PilotActionView }>(res);
      if (!res.ok || !j.action) { setErrors([j.error ?? `Erreur ${res.status}`]); return; }
      setResult(j.action);
      onPreview(null);
      if (!preview.undoOfId) onClear();
      setWhy(""); setMetric(""); setTarget(""); setNote("");
      onSent(j.action);
    } catch (e) {
      setErrors([`La réponse n'est pas arrivée (${e instanceof Error ? e.message : String(e)}) : rechargez la page et regardez le journal avant de recommencer.`]);
    } finally {
      setBusy(null);
    }
  }

  async function dropPreview() {
    if (!preview) return;
    await fetch(`/api/pilot/actions/${preview.id}`, { method: "DELETE" }).catch(() => {});
    onPreview(null);
  }

  const whyOk = why.trim().length >= 3;
  const hqOk = !!hqProject;

  const reasonFields = (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs text-gray-400">Pourquoi ? <span className="text-gray-600">(écrit dans HQ)</span></span>
        <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={2} placeholder="Ex. créas fatiguées, CPA en hausse depuis 5 jours"
          className="mt-1 w-full bg-gray-950 border border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-white" />
      </label>
      {!preview?.undoOfId && (
        <div>
          <span className="text-xs text-gray-400">Objectif <span className="text-gray-600">(facultatif)</span></span>
          <div className="mt-1 flex flex-wrap gap-2">
            <select value={metric} onChange={(e) => setMetric(e.target.value as GoalMetric | "")} className="bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white">
              <option value="">Indicateur…</option>
              {GOAL_METRICS.map((m) => <option key={m} value={m}>{GOAL_METRIC_FR[m]}</option>)}
            </select>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Cible (ex. 45)" inputMode="decimal" className="w-28 bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Précision" className="flex-1 min-w-[8rem] bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white" />
          </div>
        </div>
      )}
      <label className="block">
        <span className="text-xs text-gray-400">Dossier HQ du client</span>
        <select value={hqProject} onChange={(e) => setHqProject(e.target.value)} className="mt-1 w-full bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white">
          <option value="">{projects === null ? "Chargement…" : "Choisir le dossier…"}</option>
          {hqProject && !(projects ?? []).some((p) => p.slug === hqProject) && <option value={hqProject}>projects/{hqProject}</option>}
          {(projects ?? []).map((p) => <option key={p.slug} value={p.slug}>{p.name} (projects/{p.slug})</option>)}
        </select>
        {folderMismatch(clientName, hqProject, (projects ?? []).find((p) => p.slug === hqProject)?.name, hqDefault) && (
          <span className="mt-1 block text-xs text-amber-300">Ce dossier ne semble pas être celui de {clientName} : vérifiez avant d&apos;envoyer.</span>
        )}
      </label>
    </div>
  );

  if (preview) {
    const expires = preview.expiresAt ? new Date(preview.expiresAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : null;
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">{preview.undoOfId ? "Aperçu de l'annulation" : "Aperçu"} — rien n&apos;est encore envoyé</h3>
          {expires && <span className="text-[11px] text-gray-500">valable jusqu&apos;à {expires}</span>}
        </div>
        <p className="text-xs text-gray-400">Valeurs lues sur {PLATFORM_FR[preview.platform] ?? preview.platform} à l&apos;instant, compte « {preview.accountName || preview.accountId} » de {preview.clientName}.</p>
        <OperationLines action={preview} showStatus={false} />
        {reasonFields}
        {preview.needsDouble && (
          <label className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
            <input type="checkbox" checked={confirmDouble} onChange={(e) => setConfirmDouble(e.target.checked)} className="mt-0.5" />
            <span>
              <AlertTriangle className="w-4 h-4 inline mr-1 -mt-0.5" />
              Je confirme une seconde fois : {preview.doubleReasons.join(", ")}.
              {preview.operations.some((o) => o.irreversible) && " Une suppression ne peut pas être annulée."}
            </span>
          </label>
        )}
        {errors.length > 0 && <ul className="text-sm text-red-300 space-y-1">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void send()} disabled={!writesOpen || busy !== null || !whyOk || !hqOk || (preview.needsDouble && !confirmDouble)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-sm text-white font-medium">
            {busy === "send" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Envoyer à {PLATFORM_FR[preview.platform] ?? preview.platform} ({preview.operations.length})
          </button>
          <button type="button" onClick={() => void dropPreview()} disabled={busy !== null} className="px-3 py-2 rounded-lg text-sm text-gray-300 hover:text-white">Revenir</button>
        </div>
        {!writesOpen && <p className="text-xs text-amber-300">L&apos;aperçu fonctionne, mais l&apos;envoi vers {PLATFORM_FR[preview.platform] ?? preview.platform} n&apos;est pas encore ouvert.</p>}
        {(!whyOk || !hqOk) && <p className="text-xs text-gray-500">{!whyOk ? "Dites pourquoi en quelques mots. " : ""}{!hqOk ? "Choisissez le dossier HQ." : ""}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {result && (
        <div className="rounded-lg border border-gray-700 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white flex items-center gap-1.5">
              {result.status === "done" ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-amber-400" />}
              {result.status === "done" ? `Envoyé à ${PLATFORM_FR[result.platform] ?? result.platform}` : result.status === "failed" ? "Rien n'a été appliqué" : "Envoyé en partie"}
            </p>
            <button type="button" onClick={() => setResult(null)} className="text-gray-500 hover:text-white" aria-label="Fermer"><X className="w-4 h-4" /></button>
          </div>
          <OperationLines action={result} showStatus />
          <p className="text-xs text-gray-400">
            {result.hqWrittenAt ? `Consigné dans HQ (projects/${result.hqProject}).` : result.hqError ? `HQ : ${result.hqError} — réessayez depuis le journal.` : "Rien à consigner dans HQ."}
          </p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Modifications prévues</h3>
        {pending.length > 0 && <button type="button" onClick={onClear} className="text-xs text-gray-500 hover:text-white">Tout retirer</button>}
      </div>
      {pending.length === 0 ? (
        <p className="text-sm text-gray-500">Choisissez « Modifier » sur une campagne, un ensemble ou une annonce, ou demandez à l&apos;IA. Rien n&apos;est envoyé avant l&apos;aperçu et votre confirmation.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {pending.map((p, i) => (
              <li key={`${p.objectId}-${p.kind}`} className="flex items-start gap-2 text-sm text-gray-200">
                <span className="flex-1 min-w-0 break-words">{p.label}</span>
                <button type="button" onClick={() => onRemove(i)} className="text-gray-500 hover:text-red-300" aria-label="Retirer"><Trash2 className="w-3.5 h-3.5" /></button>
              </li>
            ))}
          </ul>
          {reasonFields}
          {errors.length > 0 && <ul className="text-sm text-red-300 space-y-1">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          <button type="button" onClick={() => void prepare()} disabled={busy !== null}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-sm text-white font-medium">
            {busy === "prepare" && <Loader2 className="w-4 h-4 animate-spin" />}
            Préparer l&apos;aperçu
          </button>
        </>
      )}
    </div>
  );
}
