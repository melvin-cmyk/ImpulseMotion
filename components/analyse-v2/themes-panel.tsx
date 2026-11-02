"use client";

/**
 * « Thèmes de message » — Motion's Messaging themes page: one full-width card
 * per theme (110 px visual, name, description, Dépenses / Actives / Taux de
 * réussite, badge Prouvé or En test), sort pill, « Analyser les messages »
 * the first time and « Réanalyser » afterwards. A card opens the client's
 * creatives filtered on that theme.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, Check, FlaskConical, Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import type { ThemeStat } from "@/lib/ads-warehouse/themes";
import { adImageSrc, colorFor } from "./shared";
import { MenuItem, PILL, Popover } from "./pill";

type Sort = "proven" | "spend" | "hit" | "active";
const SORTS: Array<{ id: Sort; label: string }> = [
  { id: "proven", label: "Prouvés" },
  { id: "spend", label: "Dépenses" },
  { id: "hit", label: "Taux de réussite" },
  { id: "active", label: "Créas actives" },
];

function compactMoney(v: number, currency: string | null): string {
  try { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency ?? "EUR", notation: v >= 1000 ? "compact" : "standard", maximumFractionDigits: v >= 1000 ? 1 : 0 }).format(v); } catch { return `${Math.round(v)}`; }
}

interface Props { query: AdsQuery; accountKey: string; onOpenTheme: (name: string) => void }

export function ThemesPanel({ query, accountKey, onOpenTheme }: Props) {
  const body = useMemo(() => ({ platforms: query.platforms, accounts: query.accounts, accountIds: query.accountIds, range: query.range, accountKey }), [query.platforms, query.accounts, query.accountIds, query.range, accountKey]);
  const key = JSON.stringify(body);
  const [state, setState] = useState<{ key: string; themes: ThemeStat[]; analyzedAt: string | null; currency: string | null; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<Sort>("proven");
  const current = state && state.key === key ? state : null;

  async function run(action: "list" | "analyze") {
    if (action === "analyze") setBusy(true);
    try {
      const res = await fetch("/api/ads/themes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, action }) });
      const j = (await res.json().catch(() => ({}))) as { themes?: ThemeStat[]; analyzedAt?: string | null; currency?: string | null; error?: string };
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      setState({ key, themes: j.themes ?? [], analyzedAt: j.analyzedAt ?? null, currency: j.currency ?? null, error: null });
    } catch (e) {
      setState((s) => ({ key, themes: s?.key === key ? s.themes : [], analyzedAt: s?.key === key ? s.analyzedAt : null, currency: s?.key === key ? s.currency : null, error: e instanceof Error ? e.message : "Erreur" }));
    } finally { setBusy(false); }
  }
  useEffect(() => { queueMicrotask(() => { void run("list"); }); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const themes = useMemo(() => {
    const list = [...(current?.themes ?? [])];
    const rank = (t: ThemeStat) => (t.status === "proven" ? 2 : t.status === "testing" ? 1 : 0);
    list.sort((a, b) => sort === "spend" ? b.spend - a.spend : sort === "hit" ? b.hitRate - a.hitRate || b.spend - a.spend : sort === "active" ? b.active - a.active || b.spend - a.spend : rank(b) - rank(a) || b.spend - a.spend);
    return list;
  }, [current, sort]);

  return (
    <div className="px-6 pb-10">
      <div className="flex items-center justify-end gap-2 mb-4">
        {current?.analyzedAt && <span className="mr-auto text-xs text-gray-500">Analysés le {new Date(current.analyzedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} · sur la période sélectionnée</span>}
        {current?.analyzedAt && <button type="button" onClick={() => void run("analyze")} disabled={busy} className={PILL}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4 text-gray-400" />}Réanalyser</button>}
        <Popover width={200} align="right" trigger={({ toggle }) => <button type="button" onClick={toggle} className={PILL}>{SORTS.find((s) => s.id === sort)?.label}<ArrowUpDown className="w-3.5 h-3.5 text-gray-500" /></button>}>
          {(close) => SORTS.map((s) => <MenuItem key={s.id} active={sort === s.id} onClick={() => { setSort(s.id); close(); }}>{s.label}</MenuItem>)}
        </Popover>
      </div>

      {!current ? <div className="py-16 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Chargement des thèmes…</div>
        : current.themes.length === 0 ? (
          <div className="py-16 text-center max-w-md mx-auto">
            <Sparkles className="w-6 h-6 mx-auto text-violet-300" />
            <div className="mt-2 text-base font-semibold text-white">Découvre les thèmes de message de ce client</div>
            <p className="mt-1 text-sm text-gray-400">L&apos;IA lit les textes des créas qui ont dépensé ces 90 derniers jours, dégage les promesses propres au client et range chaque créa dans un thème. Ensuite : dépenses, créas actives et taux de réussite par thème.</p>
            <button type="button" onClick={() => void run("analyze")} disabled={busy} className="mt-4 h-9 inline-flex items-center gap-2 rounded-[10px] bg-white px-4 text-sm font-medium text-gray-900 hover:bg-gray-200 disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}{busy ? "Analyse en cours (≈ 1 min)…" : "Analyser les messages"}</button>
            {current.error && <div className="mt-3 text-sm text-red-300">{current.error}</div>}
          </div>
        ) : (
          <div className="space-y-3">
            {current.error && <div className="text-sm text-red-300">{current.error}</div>}
            {themes.map((t) => {
              const img = adImageSrc(t.sample);
              return (
                <button key={t.name} type="button" onClick={() => onOpenTheme(t.name)} className="w-full text-left rounded-xl border border-gray-800 bg-gray-900 hover:border-gray-700 p-4 flex items-center gap-5">
                  {/* eslint-disable-next-line @next/next/no-img-element -- platform CDNs */}
                  {img ? <img src={img} alt="" className="w-[110px] h-[110px] rounded-lg object-cover bg-gray-800 shrink-0" /> : <span className={`w-[110px] h-[110px] rounded-lg bg-gradient-to-br ${colorFor(t.name)} opacity-40 shrink-0`} />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold text-white">{t.name}</span>
                    <span className="mt-0.5 block text-sm text-gray-400 line-clamp-2">{t.description}</span>
                    <span className="mt-3 flex gap-8">
                      <span><span className="block text-xs text-gray-500">Dépenses</span><span className="text-sm font-semibold text-white tabular-nums">{compactMoney(t.spend, current.currency)}</span></span>
                      <span><span className="block text-xs text-gray-500">Actives</span><span className="text-sm font-semibold text-white tabular-nums">{t.active}<span className="font-normal text-gray-500"> / {t.creatives}</span></span></span>
                      <span><span className="block text-xs text-gray-500">Taux de réussite</span><span className="text-sm font-semibold text-white tabular-nums">{Math.round(t.hitRate * 100)} %</span></span>
                    </span>
                  </span>
                  {t.status === "proven" && <span className="self-start inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300" title="Au moins une créa gagnante et 15 % de réussite ou plus, avec une dépense significative"><Check className="w-3.5 h-3.5" />Prouvé</span>}
                  {t.status === "testing" && <span className="self-start inline-flex items-center gap-1 rounded-full bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-300" title="Créas récentes ou dépense encore faible"><FlaskConical className="w-3.5 h-3.5" />En test</span>}
                </button>
              );
            })}
          </div>
        )}
    </div>
  );
}
