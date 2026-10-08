"use client";

/**
 * Admin — Rattachement HQ : quel dossier HQ (projects/{slug}) correspond à
 * chaque client de l'agence. Les suggestions viennent des identifiants de
 * comptes lus dans client.yaml puis des noms ; l'admin valide en un clic, ou
 * choisit à la main. Le rattachement alimente le brief lu avant les rapports,
 * le journal du pilotage et les personas.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Link2, Loader2, RefreshCw, Search } from "lucide-react";
import { Card, PageHeader, Pill } from "@/components/ui/surface";
import type { ClientMatchRow, HqProjectInfo, MatchLevel } from "@/lib/hq-matching";

type Payload = { projects: HqProjectInfo[]; rows: ClientMatchRow[]; counts: { clients: number; linked: number; suggested: number; ambiguous: number; none: number; projects: number; projectsLinked: number } };
type Filter = "todo" | "suggested" | "linked" | "all";

const LEVEL: Record<MatchLevel, { label: string; tone: "emerald" | "blue" | "amber" }> = {
  compte: { label: "même compte pub", tone: "emerald" },
  nom: { label: "même nom", tone: "blue" },
  partiel: { label: "nom proche", tone: "amber" },
};
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export default function AdminHqPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("todo");
  const [q, setQ] = useState("");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/admin/hq${refresh ? "?refresh=1" : ""}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => clearTimeout(t); }, [load]);

  const apply = async (assignments: Array<{ clientId: string; slug: string | null }>, label: string) => {
    if (!assignments.length || busy) return;
    setBusy(label);
    setError(null);
    try {
      const r = await fetch("/api/admin/hq", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignments }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      const dash = (j.done ?? []).reduce((n: number, d: { dashboards: number }) => n + d.dashboards, 0);
      setNotice(`${j.done?.length ?? 0} client${(j.done?.length ?? 0) > 1 ? "s" : ""} rattaché${(j.done?.length ?? 0) > 1 ? "s" : ""}${dash ? `, ${dash} dashboard${dash > 1 ? "s" : ""} mis à jour` : ""}.${j.errors?.length ? ` Erreurs : ${j.errors.join(" ; ")}` : ""}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = fold(q.trim());
    const list = data.rows.filter((r) => {
      if (filter === "linked" && !r.hqSlug) return false;
      if (filter === "suggested" && (r.hqSlug || !r.suggestion)) return false;
      if (filter === "todo" && r.hqSlug) return false;
      if (needle && !fold(`${r.name} ${r.hqSlug ?? ""} ${r.suggestion?.slug ?? ""}`).includes(needle)) return false;
      return true;
    });
    // What can be acted on first: suggestions, then ambiguous, then the rest; alphabetical inside.
    const rank = (r: ClientMatchRow) => (r.hqSlug ? 3 : r.suggestion ? 0 : r.ambiguous ? 1 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "fr"));
  }, [data, filter, q]);

  const sure = useMemo(() => (data?.rows ?? []).filter((r) => !r.hqSlug && r.suggestion && (r.suggestion.level === "compte" || r.suggestion.level === "nom")), [data]);

  const selectCls = "bg-gray-950 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-violet-500 max-w-[260px]";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rattachement HQ"
        subtitle="Quel dossier HQ (projects/{slug}) correspond à chaque client. Ce rattachement alimente le brief lu avant les rapports IA, le journal du pilotage, les bilans et les personas."
        action={
          <button type="button" onClick={() => void load(true)} disabled={loading} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-900 hover:bg-gray-800 border border-gray-800 text-gray-300 text-xs font-medium disabled:opacity-50">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Relire HQ
          </button>
        }
      />

      {data && (
        <Card padded>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="text-white font-semibold">{data.counts.linked} / {data.counts.clients} clients rattachés</span>
            <span className="text-xs text-gray-500">{data.counts.projects} dossiers HQ, {data.counts.projectsLinked} utilisés · {data.counts.suggested} suggestions, {data.counts.ambiguous} ambigus, {data.counts.none} sans piste</span>
            {sure.length > 0 && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  if (!window.confirm(`Rattacher ${sure.length} client${sure.length > 1 ? "s" : ""} aux dossiers HQ suggérés (même compte publicitaire ou même nom) ?`)) return;
                  void apply(sure.map((r) => ({ clientId: r.id, slug: r.suggestion!.slug })), "all");
                }}
                className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold disabled:opacity-50"
              >
                {busy === "all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Valider les {sure.length} correspondances sûres
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Sûr = même identifiant de compte publicitaire dans le client.yaml d&apos;HQ, ou nom identique au registre. « Nom proche » et les cas ambigus se valident un par un. Rien n&apos;est écrit dans HQ : on pointe seulement vers un dossier qui existe.
          </p>
        </Card>
      )}

      {error && <div className="text-sm text-red-300 bg-red-950/40 border border-red-900/50 rounded-xl px-4 py-3">{error}</div>}
      {notice && <div className="text-sm text-emerald-200 bg-emerald-950/30 border border-emerald-900/50 rounded-xl px-4 py-3 flex justify-between gap-3"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} className="text-gray-500 hover:text-white">✕</button></div>}

      <div className="flex flex-wrap items-center gap-2">
        {([["todo", "À rattacher"], ["suggested", "Avec suggestion"], ["linked", "Rattachés"], ["all", "Tous"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${filter === k ? "bg-violet-600 border-violet-500 text-white" : "bg-gray-950 border-gray-800 text-gray-400 hover:text-white"}`}>{label}</button>
        ))}
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 text-gray-600 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher un client ou un slug" className="bg-gray-950 border border-gray-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-violet-500 w-64" />
        </div>
      </div>

      {!data && !error ? (
        <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture des dossiers HQ (registre et client.yaml de chaque projet)…</p>
      ) : data && rows.length === 0 ? (
        <p className="text-sm text-gray-500">Rien dans ce filtre.</p>
      ) : data ? (
        <div className="space-y-2">
          {rows.map((r) => {
            const selected = choice[r.id] ?? r.hqSlug ?? r.suggestion?.slug ?? "";
            const changed = selected !== (r.hqSlug ?? "");
            return (
              <Card key={r.id} padded className="lg:grid lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_auto] lg:gap-4 lg:items-center space-y-2 lg:space-y-0">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">{r.name}{r.dormant && <span className="text-gray-600 font-normal text-xs"> · dormant</span>}</div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {r.accounts.map((a) => `${a.platform === "meta" ? "Meta" : a.platform === "google" ? "Google" : a.platform} ${a.accountId}`).join(" · ")}
                    {r.dashboards.length ? ` · ${r.dashboards.length} dashboard${r.dashboards.length > 1 ? "s" : ""}` : ""}
                  </div>
                </div>
                <div className="min-w-0 flex flex-wrap items-center gap-2">
                  {r.hqSlug ? (
                    <Pill tone="emerald"><Link2 className="w-3 h-3 inline mr-1" />projects/{r.hqSlug}</Pill>
                  ) : r.suggestion ? (
                    <>
                      <Pill tone={LEVEL[r.suggestion.level].tone}>{LEVEL[r.suggestion.level].label}</Pill>
                      <span className="text-xs text-gray-300">projects/{r.suggestion.slug}</span>
                      <span className="text-[11px] text-gray-600">({r.suggestion.evidence})</span>
                    </>
                  ) : r.ambiguous ? (
                    <>
                      <Pill tone="amber">ambigu</Pill>
                      <span className="text-[11px] text-gray-500">{r.candidates.map((c) => c.slug).join(", ")}</span>
                    </>
                  ) : (
                    <span className="text-xs text-gray-600">aucun dossier HQ repéré</span>
                  )}
                </div>
                <div className="flex items-center gap-2 justify-end">
                  <select value={selected} onChange={(e) => setChoice((c) => ({ ...c, [r.id]: e.target.value }))} className={selectCls} disabled={!!busy}>
                    <option value="">— aucun dossier —</option>
                    {r.candidates.filter((c) => !data.projects.some((p) => p.slug === c.slug)).map((c) => <option key={c.slug} value={c.slug}>{c.slug}</option>)}
                    {data.projects.map((p) => <option key={p.slug} value={p.slug}>{p.slug}{p.registryName && p.registryName !== p.slug ? ` — ${p.registryName}` : ""}{p.hasClientYaml ? "" : " (sans client.yaml)"}</option>)}
                  </select>
                  <button
                    type="button"
                    disabled={!!busy || !changed}
                    onClick={() => void apply([{ clientId: r.id, slug: selected || null }], r.id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 inline-flex items-center gap-1 whitespace-nowrap"
                  >
                    {busy === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    {r.hqSlug ? (selected ? "Changer" : "Détacher") : "Rattacher"}
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
