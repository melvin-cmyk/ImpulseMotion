"use client";

/**
 * The account as the platform holds it: campaigns, their ad sets (ad groups on
 * Google Ads), and — on Meta — the ads of an ad set once opened. Each row offers the changes that make sense for it; a
 * change chosen goes to the panel, nothing is sent from here.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Pencil, Search } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { currencyOffset, dateText, money, objectLabel, statusText, type PilotKind } from "@/lib/pilot/ops";
import { changeKey, readJson, type PendingChange, type TreeRow } from "@/components/pilot/model";

type Editor = { row: TreeRow; kind: PilotKind; value: string } | null;

const ACTIVE_TONE: Record<string, "emerald" | "amber" | "default" | "red"> = { ACTIVE: "emerald", PAUSED: "amber" };

function statusPill(row: TreeRow) {
  const eff = row.effectiveStatus || row.status;
  const tone = ACTIVE_TONE[eff] ?? (eff.includes("PAUSED") ? "amber" : eff.includes("DISAPPROVED") || eff.includes("ISSUES") ? "red" : "default");
  const text = eff === row.status ? statusText(eff) : eff.toLowerCase().replace(/_/g, " ");
  return <Pill tone={tone} className="text-[10px] normal-case">{text}</Pill>;
}

/** The changes offered on a row, in the order of the menu. */
function choices(row: TreeRow): Array<{ kind: PilotKind; label: string; value: string }> {
  const out: Array<{ kind: PilotKind; label: string; value: string }> = [];
  if (row.status === "ACTIVE") out.push({ kind: "set_status", label: "Mettre en pause", value: "PAUSED" });
  if (row.status === "PAUSED") out.push({ kind: "set_status", label: "Activer", value: "ACTIVE" });
  if (row.dailyBudget && !row.budgetLock) out.push({ kind: "set_daily_budget", label: "Budget journalier", value: "" });
  if (row.lifetimeBudget && !row.budgetLock) out.push({ kind: "set_lifetime_budget", label: "Budget total", value: "" });
  if (row.type !== "ad" && !row.endTimeLock) out.push({ kind: "set_end_time", label: "Date de fin", value: "" });
  if (row.type === "adset" && row.bidAmount) out.push({ kind: "set_bid_amount", label: "Enchère", value: "" });
  out.push({ kind: "rename", label: "Renommer", value: "" });
  out.push({ kind: "set_status", label: "Supprimer", value: "DELETED" });
  return out;
}

function initialValue(row: TreeRow, kind: PilotKind, currency: string): string {
  const unit = currencyOffset(currency);
  switch (kind) {
    case "set_daily_budget": return row.dailyBudget ? String(row.dailyBudget / unit) : "";
    case "set_lifetime_budget": return row.lifetimeBudget ? String(row.lifetimeBudget / unit) : "";
    case "set_bid_amount": return row.bidAmount ? String(row.bidAmount / unit) : "";
    case "set_end_time": {
      const d = row.endTime ? new Date(row.endTime) : new Date(Date.now() + 7 * 86_400_000);
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
      return local.toISOString().slice(0, 16);
    }
    case "rename": return row.name;
    default: return "";
  }
}

function pendingLabel(platform: string, row: TreeRow, kind: PilotKind, value: string, currency: string): string {
  const object = `${objectLabel(platform, row.type)} « ${row.name} »`;
  const unit = currencyOffset(currency);
  switch (kind) {
    case "set_status": return `${object} : ${value === "DELETED" ? "supprimer" : value === "PAUSED" ? "mettre en pause" : "activer"}`;
    case "set_daily_budget": return `${object} : budget journalier ${money(row.dailyBudget, currency)} → ${money(Number(value.replace(",", ".")) * unit, currency)}`;
    case "set_lifetime_budget": return `${object} : budget total ${money(row.lifetimeBudget, currency)} → ${money(Number(value.replace(",", ".")) * unit, currency)}`;
    case "set_bid_amount": return `${object} : enchère ${money(row.bidAmount, currency)} → ${money(Number(value.replace(",", ".")) * unit, currency)}`;
    case "set_end_time": return `${object} : date de fin ${dateText(row.endTime)} → ${dateText(new Date(value).toISOString())}`;
    case "rename": return `${object} : renommer en « ${value} »`;
  }
}

export function StructureTree({ clientId, accountId, platform, currency, campaigns, adsets, pending, onAdd }: {
  clientId: string;
  accountId: string;
  platform: "meta" | "google";
  currency: string;
  campaigns: TreeRow[];
  adsets: TreeRow[];
  pending: PendingChange[];
  onAdd: (change: PendingChange) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [ads, setAds] = useState<Record<string, TreeRow[] | "loading" | { error: string }>>({});
  const [editor, setEditor] = useState<Editor>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hidePaused, setHidePaused] = useState(false);

  const pendingKeys = useMemo(() => new Set(pending.map(changeKey)), [pending]);
  const pendingIds = useMemo(() => new Set(pending.map((p) => p.objectId)), [pending]);
  const q = query.trim().toLowerCase();

  const adsetsOf = useMemo(() => {
    const map = new Map<string, TreeRow[]>();
    for (const a of adsets) map.set(a.parentId ?? "", [...(map.get(a.parentId ?? "") ?? []), a]);
    return map;
  }, [adsets]);

  const visible = (r: TreeRow) => !hidePaused || r.effectiveStatus === "ACTIVE" || pendingIds.has(r.id);
  const shownCampaigns = campaigns.filter((c) => visible(c) && (!q || c.name.toLowerCase().includes(q) || (adsetsOf.get(c.id) ?? []).some((a) => a.name.toLowerCase().includes(q))));

  async function toggleAdset(id: string) {
    const next = !open[id];
    setOpen((o) => ({ ...o, [id]: next }));
    if (!next || Array.isArray(ads[id])) return;
    setAds((a) => ({ ...a, [id]: "loading" }));
    try {
      const res = await fetch(`/api/pilot/structure?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(accountId)}&platform=${platform}&adsetId=${encodeURIComponent(id)}`);
      const j = await readJson<{ ads?: TreeRow[] }>(res);
      setAds((a) => ({ ...a, [id]: res.ok && j.ads ? j.ads : { error: j.error ?? `Erreur ${res.status}` } }));
    } catch (e) {
      setAds((a) => ({ ...a, [id]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  }

  function choose(row: TreeRow, kind: PilotKind, value: string) {
    setMenu(null);
    if (kind === "set_status") {
      onAdd({ kind, objectType: row.type, objectId: row.id, value, label: pendingLabel(platform, row, kind, value, currency) });
      return;
    }
    setEditor({ row, kind, value: initialValue(row, kind, currency) });
  }

  function submitEditor() {
    if (!editor || !editor.value.trim()) return;
    const { row, kind } = editor;
    const value = kind === "set_end_time" ? new Date(editor.value).toISOString() : editor.value.trim();
    onAdd({ kind, objectType: row.type, objectId: row.id, value: kind === "rename" || kind === "set_end_time" ? value : Number(value.replace(",", ".")), label: pendingLabel(platform, row, kind, editor.value, currency) });
    setEditor(null);
  }

  function renderRow(row: TreeRow, depth: number, expandable: boolean) {
    const hasPending = pendingIds.has(row.id);
    const budget = row.dailyBudget ? `${money(row.dailyBudget, currency)}/j` : row.lifetimeBudget ? `${money(row.lifetimeBudget, currency)} total` : "";
    return (
      <div key={row.id}>
        <div className={`group flex items-center gap-2 py-1.5 pr-2 rounded-lg hover:bg-gray-800/40 ${hasPending ? "bg-violet-500/5" : ""}`} style={{ paddingLeft: 8 + depth * 18 }}>
          {expandable ? (
            <button type="button" onClick={() => (row.type === "campaign" ? setOpen((o) => ({ ...o, [row.id]: !o[row.id] })) : void toggleAdset(row.id))} className="text-gray-500 hover:text-white" aria-label={open[row.id] ? "Replier" : "Déplier"}>
              {open[row.id] ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          ) : <span className="w-4" />}
          <span className="text-[10px] uppercase tracking-wide text-gray-500 w-14 shrink-0">{row.type === "campaign" ? "Camp." : row.type === "adset" ? (platform === "google" ? "Groupe" : "Ens.") : "Annonce"}</span>
          <span className="text-sm text-gray-200 truncate flex-1 min-w-0" title={row.name}>{row.name}</span>
          {hasPending && <Pill tone="violet" className="text-[10px]">à envoyer</Pill>}
          {statusPill(row)}
          <span className="text-xs text-gray-400 w-24 text-right hidden sm:inline" title={row.budgetLock ?? undefined}>{budget}{budget && row.budgetLock ? " · partagé" : ""}</span>
          <span className="text-xs text-gray-500 w-20 text-right hidden md:inline" title="Dépense des 7 derniers jours">{money(Math.round(row.spend7d * (currencyOffset(currency))), currency)}</span>
          <div className="relative">
            <button type="button" onClick={() => setMenu(menu === row.id ? null : row.id)} className="text-xs flex items-center gap-1 px-2 py-1 rounded-md text-gray-300 hover:text-white hover:bg-gray-800">
              <Pencil className="w-3 h-3" /> Modifier
            </button>
            {menu === row.id && (
              <div className="absolute right-0 top-full mt-1 z-20 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1">
                {choices(row).map((c) => {
                  const taken = pendingKeys.has(changeKey({ objectId: row.id, kind: c.kind }));
                  return (
                    <button key={`${c.kind}-${c.value}`} type="button" disabled={taken} onClick={() => choose(row, c.kind, c.value)}
                      className={`w-full text-left text-xs px-3 py-1.5 hover:bg-gray-800 disabled:opacity-40 ${c.value === "DELETED" ? "text-red-300" : "text-gray-200"}`}>
                      {c.label}{taken ? " (déjà prévu)" : ""}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {editor && editor.row.id === row.id && (
          <form onSubmit={(e) => { e.preventDefault(); submitEditor(); }} className="flex flex-wrap items-center gap-2 py-2 pr-2 text-xs" style={{ paddingLeft: 30 + depth * 18 }}>
            <span className="text-gray-400">{choices(row).find((c) => c.kind === editor.kind)?.label} :</span>
            <input
              autoFocus
              type={editor.kind === "set_end_time" ? "datetime-local" : editor.kind === "rename" ? "text" : "number"}
              step={editor.kind === "set_end_time" || editor.kind === "rename" ? undefined : "0.01"}
              min={editor.kind === "set_end_time" || editor.kind === "rename" ? undefined : "1"}
              value={editor.value}
              onChange={(e) => setEditor({ ...editor, value: e.target.value })}
              className={`bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-white ${editor.kind === "rename" ? "flex-1 min-w-[12rem]" : "w-40"}`}
            />
            {editor.kind !== "rename" && editor.kind !== "set_end_time" && <span className="text-gray-500">{currency}{editor.kind === "set_daily_budget" ? " / jour" : ""}</span>}
            <button type="submit" className="px-2.5 py-1 rounded-md bg-violet-600 hover:bg-violet-500 text-white">Ajouter</button>
            <button type="button" onClick={() => setEditor(null)} className="px-2 py-1 text-gray-400 hover:text-white">Annuler</button>
          </form>
        )}
        {expandable && open[row.id] && row.type === "campaign" && (adsetsOf.get(row.id) ?? []).filter(visible).map((a) => renderRow(a, depth + 1, platform === "meta"))}
        {expandable && open[row.id] && row.type === "adset" && (() => {
          const list = ads[row.id];
          if (list === "loading" || list === undefined) return <p className="text-xs text-gray-500 py-1 flex items-center gap-1" style={{ paddingLeft: 30 + (depth + 1) * 18 }}><Loader2 className="w-3 h-3 animate-spin" /> Lecture des annonces…</p>;
          if (!Array.isArray(list)) return <p className="text-xs text-red-300 py-1" style={{ paddingLeft: 30 + (depth + 1) * 18 }}>{list.error}</p>;
          if (!list.length) return <p className="text-xs text-gray-500 py-1" style={{ paddingLeft: 30 + (depth + 1) * 18 }}>Aucune annonce.</p>;
          return list.filter(visible).map((ad) => renderRow(ad, depth + 1, false));
        })()}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <label className="flex items-center gap-2 flex-1 min-w-[12rem] bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5">
          <Search className="w-3.5 h-3.5 text-gray-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={platform === "google" ? "Chercher une campagne ou un groupe d'annonces" : "Chercher une campagne ou un ensemble"} className="bg-transparent text-sm text-white outline-none flex-1" />
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={hidePaused} onChange={(e) => setHidePaused(e.target.checked)} /> Actifs seulement
        </label>
      </div>
      <div className="flex items-center gap-2 px-2 pb-1 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
        <span className="flex-1 pl-20">Nom</span>
        <span className="w-24 text-right hidden sm:inline">Budget</span>
        <span className="w-20 text-right hidden md:inline">Dépense 7 j</span>
        <span className="w-20" />
      </div>
      {shownCampaigns.length ? shownCampaigns.map((c) => renderRow(c, 0, true)) : <p className="text-sm text-gray-500 py-6 text-center">Aucune campagne à afficher.</p>}
    </div>
  );
}
