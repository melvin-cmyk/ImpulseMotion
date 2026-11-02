"use client";

/**
 * « Partager le rapport » (Motion's Share report → Snapshot): creates a public
 * read-only link with the numbers frozen now, copies it, lists the client's
 * live links (views) and revokes them; plus the internal link for the team.
 */

import { useEffect, useState } from "react";
import { Check, Copy, Eye, Link2, Loader2, Trash2 } from "lucide-react";
import { Popover } from "./pill";

interface Snap { id: string; title: string; emoji: string; createdAt: string; createdByName: string; views: number }

interface Props {
  accountKey: string | null;
  /** Body of POST /api/ads/snapshots (query + report presentation). */
  buildBody: () => Record<string, unknown> | null;
  internalUrl: () => string;
}

export function SharePopover({ accountKey, buildBody, internalUrl }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [list, setList] = useState<Snap[] | null>(null);

  useEffect(() => {
    if (!open || !accountKey) return;
    let cancelled = false;
    fetch(`/api/ads/snapshots?accountKey=${encodeURIComponent(accountKey)}`).then((r) => (r.ok ? r.json() : { snapshots: [] })).then((j: { snapshots: Snap[] }) => { if (!cancelled) setList(j.snapshots ?? []); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, accountKey, url]);

  const copy = async (text: string, tag: string) => { try { await navigator.clipboard.writeText(text); setCopied(tag); setTimeout(() => setCopied(null), 1500); } catch { /* refused */ } };
  async function create() {
    const body = buildBody();
    if (!body) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/ads/snapshots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error ?? `Erreur ${res.status}`);
      setUrl(j.url);
      void copy(j.url, "new");
    } catch (e) { setError(e instanceof Error ? e.message : "Impossible"); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    if (!confirm("Révoquer ce lien ? Les personnes qui l'ont ne pourront plus l'ouvrir.")) return;
    const res = await fetch(`/api/ads/snapshots/${id}`, { method: "DELETE" });
    if (res.ok) { setList((l) => (l ?? []).filter((s) => s.id !== id)); if (url?.endsWith(id)) setUrl(null); }
  }
  const linkOf = (id: string) => `${window.location.origin}/s/${id}`;

  return (
    <Popover width={380} align="right" open={open} onOpenChange={setOpen} trigger={({ toggle }) => (
      <button type="button" onClick={toggle} className="h-8 inline-flex items-center gap-1.5 rounded-[10px] bg-white px-3 text-sm font-medium text-gray-900 hover:bg-gray-200">Partager le rapport</button>
    )}>
      <div className="p-3 space-y-3">
        <div>
          <div className="text-sm font-semibold text-white">Snapshot public</div>
          <p className="mt-0.5 text-xs leading-relaxed text-gray-400">Un lien en lecture seule, ouvrable sans compte (client, équipe créa…). Les chiffres sont figés au moment du partage.</p>
        </div>
        {url ? (
          <div className="flex items-center gap-1.5">
            <input readOnly value={url} className="flex-1 min-w-0 h-8 rounded-lg border border-gray-800 bg-gray-900 px-2 text-xs text-gray-200" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={() => void copy(url, "new")} className="h-8 inline-flex items-center gap-1 rounded-lg bg-white px-2.5 text-xs font-medium text-gray-900">{copied === "new" ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied === "new" ? "Copié" : "Copier"}</button>
          </div>
        ) : (
          <button type="button" onClick={() => void create()} disabled={busy || !accountKey} className="w-full h-9 inline-flex items-center justify-center gap-1.5 rounded-[10px] bg-white text-sm font-medium text-gray-900 hover:bg-gray-200 disabled:opacity-40">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}{busy ? "Création du snapshot…" : "Créer le lien public"}</button>
        )}
        {error && <div className="text-xs text-red-300">{error}</div>}
        {list && list.length > 0 && (
          <div className="border-t border-gray-800 pt-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500 mb-1">Liens actifs de ce client</div>
            <ul className="max-h-48 overflow-y-auto space-y-0.5">
              {list.map((s) => (
                <li key={s.id} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-gray-900">
                  <span className="text-sm">{s.emoji}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-gray-200 truncate">{s.title}</span>
                    <span className="block text-[11px] text-gray-500">{new Date(s.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}{s.createdByName ? ` · ${s.createdByName}` : ""} · <Eye className="inline w-3 h-3" /> {s.views}</span>
                  </span>
                  <button type="button" onClick={() => void copy(linkOf(s.id), s.id)} title="Copier le lien" className="p-1 text-gray-500 hover:text-white">{copied === s.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}</button>
                  <button type="button" onClick={() => void revoke(s.id)} title="Révoquer" className="p-1 text-gray-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="border-t border-gray-800 pt-2">
          <button type="button" onClick={() => void copy(internalUrl(), "internal")} className="w-full h-8 flex items-center gap-2 rounded-lg px-1.5 text-xs text-gray-300 hover:bg-gray-900">{copied === "internal" ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}{copied === "internal" ? "Lien interne copié" : "Copier le lien interne (équipe connectée)"}</button>
        </div>
      </div>
    </Popover>
  );
}
