"use client";

/**
 * The account as the platform holds it: campaigns, their ad sets (ad groups on
 * Google Ads), and — on Meta — the ads of an ad set once opened. Each row offers the changes that make sense for it; a
 * change chosen goes to the panel, nothing is sent from here.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CheckSquare, Loader2, Pencil, Search, Square } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { KEYWORD_MATCH_TYPES, MATCH_FR, copyName, currencyOffset, dateText, money, newAdName, newKeywordText, objectLabel, statusText, strategyText, type KeywordMatchType, type PilotKind } from "@/lib/pilot/ops";
import { changeKey, readJson, type PendingChange, type TreeRow } from "@/components/pilot/model";
import { NewAdForm, type StudioPick } from "@/components/pilot/new-ad-form";
import { TargetingForm } from "@/components/pilot/targeting-form";
import { MetaAdTextsForm, RsaTextsForm } from "@/components/pilot/ad-texts-form";
import type { RsaSpec } from "@/lib/pilot/creative";

type Editor = { row: TreeRow; kind: PilotKind; value: string; matchType?: KeywordMatchType } | null;

const ACTIVE_TONE: Record<string, "emerald" | "amber" | "default" | "red"> = { ACTIVE: "emerald", PAUSED: "amber" };

function statusPill(row: TreeRow) {
  if (row.negative) return <Pill tone="red" className="text-[10px] normal-case">négatif</Pill>;
  const eff = row.effectiveStatus || row.status;
  const tone = ACTIVE_TONE[eff] ?? (eff.includes("PAUSED") ? "amber" : eff.includes("DISAPPROVED") || eff.includes("ISSUES") ? "red" : "default");
  const text = eff === row.status ? statusText(eff) : eff.toLowerCase().replace(/_/g, " ");
  return <Pill tone={tone} className="text-[10px] normal-case">{text}</Pill>;
}

/** The changes offered on a row, in the order of the menu. */
function choices(row: TreeRow, platform: string = "meta"): Array<{ kind: PilotKind; label: string; value: string }> {
  const out: Array<{ kind: PilotKind; label: string; value: string }> = [];
  if (row.type === "keyword") {
    if (row.negative) return [{ kind: "set_status", label: "Supprimer ce mot-clé négatif", value: "DELETED" }];
    if (row.status === "ACTIVE") out.push({ kind: "set_status", label: "Mettre en pause", value: "PAUSED" });
    if (row.status === "PAUSED") out.push({ kind: "set_status", label: "Activer", value: "ACTIVE" });
    if (!row.strategyLock) out.push({ kind: "set_bid_amount", label: "Enchère (CPC max)", value: "" });
    out.push({ kind: "set_status", label: "Supprimer", value: "DELETED" });
    return out;
  }
  if (row.type === "adset" && platform === "meta") { out.push({ kind: "create_ad", label: "Nouvelle publicité", value: "" }); out.push({ kind: "set_targeting", label: "Ciblage (âge, pays, audiences, placements)", value: "" }); }
  if (row.type === "adset" && platform === "google") out.push({ kind: "add_keyword", label: "Ajouter un mot-clé", value: "" });
  if (row.type === "campaign" && platform === "google") out.push({ kind: "add_negative_keyword", label: "Ajouter un mot-clé négatif", value: "" });
  if (row.status === "ACTIVE") out.push({ kind: "set_status", label: "Mettre en pause", value: "PAUSED" });
  if (row.status === "PAUSED") out.push({ kind: "set_status", label: "Activer", value: "ACTIVE" });
  if (row.dailyBudget && !row.budgetLock) out.push({ kind: "set_daily_budget", label: "Budget journalier", value: "" });
  if (row.lifetimeBudget && !row.budgetLock) out.push({ kind: "set_lifetime_budget", label: "Budget total", value: "" });
  if (row.type === "ad") {
    if (platform === "meta") { out.push({ kind: "set_ad_texts", label: "Textes (nouvelle créa, même visuel)", value: "" }); out.push({ kind: "rename", label: "Renommer", value: "" }); out.push({ kind: "duplicate", label: "Dupliquer (en pause)", value: "" }); }
    if (platform === "google" && row.rsa) out.push({ kind: "set_rsa_texts", label: "Textes (nouvelle version)", value: "" });
    out.push({ kind: "set_status", label: "Supprimer", value: "DELETED" });
    return out;
  }
  if (!row.endTimeLock) out.push({ kind: "set_end_time", label: "Date de fin", value: "" });
  if (!(platform === "google" && row.type === "adset") && platform !== "tiktok") out.push({ kind: "set_start_time", label: "Date de début", value: "" });
  if (row.type === "campaign" && platform === "meta") out.push({ kind: "set_spend_cap", label: "Plafond de dépense", value: "" });
  if (row.type === "adset" && row.bidAmount) out.push({ kind: "set_bid_amount", label: "Enchère", value: "" });
  const carriesStrategy = platform !== "tiktok" && !row.strategyLock && (platform === "google" ? row.type === "campaign" : !!row.bidStrategy);
  if (carriesStrategy) {
    out.push({ kind: "set_target_cpa", label: platform === "google" ? "CPA cible" : "Coût cible (cost cap)", value: "" });
    out.push({ kind: "set_target_roas", label: platform === "google" ? "ROAS cible" : "ROAS minimum", value: "" });
    if (platform === "meta" && row.bidStrategy !== "LOWEST_COST_WITHOUT_CAP") out.push({ kind: "set_bid_strategy", label: "Enchère automatique (sans plafond)", value: "AUTO" });
  }
  out.push({ kind: "rename", label: "Renommer", value: "" });
  if (platform === "meta") out.push({ kind: "duplicate", label: "Dupliquer (en pause)", value: "" });
  out.push({ kind: "set_status", label: "Supprimer", value: "DELETED" });
  return out;
}

const localDateTime = (iso: string | null | undefined, fallbackDays: number) => {
  const d = iso ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T09:00:00` : iso) : new Date(Date.now() + fallbackDays * 86_400_000);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};
const DATE_KINDS = new Set<PilotKind>(["set_end_time", "set_start_time"]);
const TEXT_KINDS = new Set<PilotKind>(["rename", "duplicate", "add_keyword", "add_negative_keyword"]);
const KEYWORD_KINDS = new Set<PilotKind>(["add_keyword", "add_negative_keyword"]);

function initialValue(row: TreeRow, kind: PilotKind, currency: string): string {
  const unit = currencyOffset(currency);
  switch (kind) {
    case "set_daily_budget": return row.dailyBudget ? String(row.dailyBudget / unit) : "";
    case "set_lifetime_budget": return row.lifetimeBudget ? String(row.lifetimeBudget / unit) : "";
    case "set_bid_amount": return row.bidAmount ? String(row.bidAmount / unit) : "";
    case "set_target_cpa": return row.targetCpa ? String(row.targetCpa / unit) : "";
    case "set_target_roas": return row.targetRoas ? String(row.targetRoas) : "";
    case "set_spend_cap": return row.spendCap ? String(row.spendCap / unit) : "";
    case "set_end_time": return localDateTime(row.endTime, 7);
    case "set_start_time": return localDateTime(row.startTime, 1);
    case "rename": return row.name;
    case "duplicate": return `${row.name} — copie`;
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
    case "set_bid_amount": return `${object} : ${row.type === "keyword" ? "CPC max" : "enchère"} ${money(row.bidAmount, currency)} → ${money(Number(value.replace(",", ".")) * unit, currency)}`;
    case "set_end_time": return `${object} : date de fin ${dateText(row.endTime)} → ${dateText(new Date(value).toISOString())}`;
    case "set_start_time": return `${object} : date de début ${dateText(row.startTime)} → ${dateText(new Date(value).toISOString())}`;
    case "set_target_cpa": return `${object} : ${platform === "google" ? "CPA cible" : "coût cible"} ${money(row.targetCpa ?? null, currency)} → ${money(Number(value.replace(",", ".")) * unit, currency)}`;
    case "set_target_roas": return `${object} : ${platform === "google" ? "ROAS cible" : "ROAS minimum"} ${row.targetRoas ? `${row.targetRoas}×` : "—"} → ${value.replace(",", ".")}×`;
    case "set_bid_strategy": return `${object} : ${row.bidStrategy ? strategyText(row.bidStrategy) : "enchère"} → enchère automatique`;
    case "set_spend_cap": return `${object} : plafond de dépense ${money(row.spendCap ?? null, currency)} → ${money(Number(value.replace(",", ".")) * unit, currency)}`;
    case "rename": return `${object} : renommer en « ${value} »`;
    case "create_ad": return `${object} : nouvelle publicité « ${newAdName(value)} » (créée en pause)`;
    case "duplicate": return `${object} : dupliquer en « ${copyName(value)} » (créée en pause)`;
    case "add_keyword": return `${object} : ajouter le mot-clé ${newKeywordText(value)}`;
    case "add_negative_keyword": return `${object} : ajouter le mot-clé négatif ${newKeywordText(value)}`;
    case "set_targeting": return `${object} : ciblage modifié`;
    case "set_ad_texts": return `${object} : nouveaux textes`;
    case "set_ad_creative": return `${object} : créa ${value}`;
    case "set_rsa_texts": return `${object} : nouvelle version`;
  }
}

export function StructureTree({ clientId, accountId, platform, currency, campaigns, adsets, negatives = [], pending, onAdd, studioPick = null }: {
  clientId: string;
  accountId: string;
  platform: "meta" | "google" | "tiktok";
  currency: string;
  campaigns: TreeRow[];
  adsets: TreeRow[];
  /** Google Ads: negative keywords, under their campaign. */
  negatives?: TreeRow[];
  pending: PendingChange[];
  onAdd: (change: PendingChange) => void;
  /** A Studio visual to place (« Pousser sur Meta »): preselected in « Nouvelle publicité ». */
  studioPick?: StudioPick | null;
}) {
  const [newAdFor, setNewAdFor] = useState<TreeRow | null>(null);
  const [targetingFor, setTargetingFor] = useState<TreeRow | null>(null);
  const [textsFor, setTextsFor] = useState<TreeRow | null>(null);
  // Rows ticked for a grouped change (pause, budget ±x %, end date, delete): the same change on each.
  const [selected, setSelected] = useState<Map<string, TreeRow>>(new Map());
  const [bulk, setBulk] = useState<{ kind: "budget_pct" | "budget_set" | "set_end_time"; value: string } | null>(null);
  const toggleSelect = (row: TreeRow) => setSelected((m) => { const n = new Map(m); if (n.has(row.id)) n.delete(row.id); else n.set(row.id, row); return n; });

  /** The same change on every ticked row that can take it; the rows that cannot are said. */
  function applyBulk(kind: PilotKind, valueOf: (row: TreeRow) => string | number | null, label: (row: TreeRow, value: string | number) => string) {
    const skipped: string[] = [];
    let added = 0;
    for (const row of selected.values()) {
      const value = valueOf(row);
      if (value === null) { skipped.push(row.name); continue; }
      onAdd({ kind, objectType: row.type, objectId: row.id, value, label: label(row, value) });
      added++;
    }
    setBulk(null);
    if (added) setSelected(new Map());
    if (skipped.length) window.alert(`${added} modification(s) ajoutée(s). Sans effet sur : ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? "…" : ""} (pas de budget à ce niveau, verrouillé, ou déjà dans cet état).`);
  }

  function bulkStatus(status: "ACTIVE" | "PAUSED" | "DELETED") {
    applyBulk("set_status", (row) => (row.status === status || (row.negative && status !== "DELETED") ? null : status), (row) => pendingLabel(platform, row, "set_status", status, currency));
  }

  function bulkBudget(mode: "budget_pct" | "budget_set", raw: string) {
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n) || (mode === "budget_set" && n <= 0)) return;
    const unit = currencyOffset(currency);
    for (const kind of ["set_daily_budget", "set_lifetime_budget"] as const) {
      const field = kind === "set_daily_budget" ? "dailyBudget" : "lifetimeBudget";
      const rows = [...selected.values()].filter((r) => r[field] && !r.budgetLock);
      if (!rows.length) continue;
      const only = new Map(rows.map((r) => [r.id, r]));
      const valueOf = (row: TreeRow) => {
        const current = row[field]!;
        const next = mode === "budget_pct" ? Math.round(current * (1 + n / 100)) : Math.round(n * unit);
        if (next < unit || next === current) return null;
        return Math.round((next / unit) * 100) / 100;
      };
      for (const row of only.values()) {
        const value = valueOf(row);
        if (value !== null) onAdd({ kind, objectType: row.type, objectId: row.id, value, label: pendingLabel(platform, row, kind, String(value), currency) });
      }
    }
    setBulk(null);
    setSelected(new Map());
  }
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

  const negativesOf = useMemo(() => {
    const m = new Map<string, TreeRow[]>();
    for (const n of negatives) if (n.parentId) m.set(n.parentId, [...(m.get(n.parentId) ?? []), n]);
    return m;
  }, [negatives]);
  const visible = (r: TreeRow) => !hidePaused || r.effectiveStatus === "ACTIVE" || pendingIds.has(r.id);
  const shownCampaigns = campaigns.filter((c) => visible(c) && (!q || c.name.toLowerCase().includes(q) || (adsetsOf.get(c.id) ?? []).some((a) => a.name.toLowerCase().includes(q))));

  async function toggleAdset(id: string) {
    const next = !open[id];
    setOpen((o) => ({ ...o, [id]: next }));
    if (!next || Array.isArray(ads[id])) return;
    setAds((a) => ({ ...a, [id]: "loading" }));
    try {
      const res = await fetch(`/api/pilot/structure?clientId=${encodeURIComponent(clientId)}&accountId=${encodeURIComponent(accountId)}&platform=${platform}&adsetId=${encodeURIComponent(id)}&currency=${encodeURIComponent(currency)}`);
      const j = await readJson<{ ads?: TreeRow[] }>(res);
      setAds((a) => ({ ...a, [id]: res.ok && j.ads ? j.ads : { error: j.error ?? `Erreur ${res.status}` } }));
    } catch (e) {
      setAds((a) => ({ ...a, [id]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  }

  function choose(row: TreeRow, kind: PilotKind, value: string) {
    setMenu(null);
    if (kind === "create_ad") { setNewAdFor(row); return; }
    if (kind === "set_targeting") { setTargetingFor(row); return; }
    if (kind === "set_ad_texts" || kind === "set_rsa_texts") { setTextsFor(row); return; }
    if (kind === "set_status" || kind === "set_bid_strategy") {
      onAdd({ kind, objectType: row.type, objectId: row.id, value, label: pendingLabel(platform, row, kind, value, currency) });
      return;
    }
    setEditor({ row, kind, value: initialValue(row, kind, currency), matchType: KEYWORD_KINDS.has(kind) ? "PHRASE" : undefined });
  }

  function submitEditor() {
    if (!editor || !editor.value.trim()) return;
    const { row, kind } = editor;
    const text = editor.value.trim();
    const value = DATE_KINDS.has(kind) ? new Date(text).toISOString() : kind === "duplicate" ? JSON.stringify({ name: text }) : KEYWORD_KINDS.has(kind) ? JSON.stringify({ text, matchType: editor.matchType ?? "PHRASE" }) : text;
    onAdd({ kind, objectType: row.type, objectId: row.id, value: TEXT_KINDS.has(kind) || DATE_KINDS.has(kind) ? value : Number(value.replace(",", ".")), label: pendingLabel(platform, row, kind, kind === "duplicate" || KEYWORD_KINDS.has(kind) ? value : editor.value, currency) });
    setEditor(null);
  }

  function renderRow(row: TreeRow, depth: number, expandable: boolean) {
    const hasPending = pendingIds.has(row.id);
    const budget = row.dailyBudget ? `${money(row.dailyBudget, currency)}/j` : row.lifetimeBudget ? `${money(row.lifetimeBudget, currency)} total` : "";
    return (
      <div key={row.id} id={`pilot-object-${row.id}`}>
        <div className={`group flex items-center gap-2 py-1.5 pr-2 rounded-lg hover:bg-gray-800/40 ${hasPending ? "bg-violet-500/5" : ""}`} style={{ paddingLeft: 8 + depth * 18 }}>
          <button type="button" onClick={() => toggleSelect(row)} className={`shrink-0 ${selected.has(row.id) ? "text-violet-300" : "text-gray-600 hover:text-gray-300"}`} aria-label={selected.has(row.id) ? "Retirer de la sélection" : "Sélectionner"} title="Sélectionner pour une modification groupée">
            {selected.has(row.id) ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
          </button>
          {expandable ? (
            <button type="button" onClick={() => (row.type === "campaign" ? setOpen((o) => ({ ...o, [row.id]: !o[row.id] })) : void toggleAdset(row.id))} className="text-gray-500 hover:text-white" aria-label={open[row.id] ? "Replier" : "Déplier"}>
              {open[row.id] ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          ) : <span className="w-4" />}
          <span className="text-[10px] uppercase tracking-wide text-gray-500 w-14 shrink-0">{row.type === "campaign" ? "Camp." : row.type === "adset" ? (platform === "meta" ? "Ens." : "Groupe") : row.type === "keyword" ? (row.negative ? "Négatif" : "Mot-clé") : "Annonce"}</span>
          <span className="text-sm text-gray-200 truncate flex-1 min-w-0" title={row.name}>{row.name}</span>
          {hasPending && <Pill tone="violet" className="text-[10px]">à envoyer</Pill>}
          {statusPill(row)}
          <span className="text-xs text-gray-400 w-24 text-right hidden sm:inline" title={row.budgetLock ?? undefined}>{row.type === "keyword" && row.bidAmount ? `CPC ${money(row.bidAmount, currency)}` : budget}{budget && row.budgetLock ? " · partagé" : ""}</span>
          <span className="text-xs text-gray-500 w-20 text-right hidden md:inline" title="Dépense des 7 derniers jours">{money(Math.round(row.spend7d * (currencyOffset(currency))), currency)}</span>
          <div className="relative">
            <button type="button" onClick={() => setMenu(menu === row.id ? null : row.id)} className="text-xs flex items-center gap-1 px-2 py-1 rounded-md text-gray-300 hover:text-white hover:bg-gray-800">
              <Pencil className="w-3 h-3" /> Modifier
            </button>
            {menu === row.id && (
              <div className="absolute right-0 top-full mt-1 z-20 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1">
                {choices(row, platform).map((c) => {
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
            <span className="text-gray-400">{choices(row, platform).find((c) => c.kind === editor.kind)?.label} :</span>
            <input
              autoFocus
              type={DATE_KINDS.has(editor.kind) ? "datetime-local" : TEXT_KINDS.has(editor.kind) ? "text" : "number"}
              step={DATE_KINDS.has(editor.kind) || TEXT_KINDS.has(editor.kind) ? undefined : "0.01"}
              min={DATE_KINDS.has(editor.kind) || TEXT_KINDS.has(editor.kind) ? undefined : editor.kind === "set_target_roas" ? "0.1" : "1"}
              value={editor.value}
              onChange={(e) => setEditor({ ...editor, value: e.target.value })}
              className={`bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-white ${TEXT_KINDS.has(editor.kind) ? "flex-1 min-w-[12rem]" : "w-40"}`}
            />
            {!TEXT_KINDS.has(editor.kind) && !DATE_KINDS.has(editor.kind) && (
              <span className="text-gray-500">{editor.kind === "set_target_roas" ? "× (3 = 300 %)" : `${currency}${editor.kind === "set_daily_budget" ? " / jour" : ""}`}</span>
            )}
            {editor.kind === "duplicate" && <span className="text-gray-500">copie en pause{row.type === "ad" ? "" : ", avec tout ce qu'elle contient"}</span>}
            {KEYWORD_KINDS.has(editor.kind) && (
              <select value={editor.matchType ?? "PHRASE"} onChange={(e) => setEditor({ ...editor, matchType: e.target.value as KeywordMatchType })} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-white">
                {KEYWORD_MATCH_TYPES.map((m) => <option key={m} value={m}>{MATCH_FR[m]}</option>)}
              </select>
            )}
            <button type="submit" className="px-2.5 py-1 rounded-md bg-violet-600 hover:bg-violet-500 text-white">Ajouter</button>
            <button type="button" onClick={() => setEditor(null)} className="px-2 py-1 text-gray-400 hover:text-white">Annuler</button>
          </form>
        )}
        {expandable && open[row.id] && row.type === "campaign" && (adsetsOf.get(row.id) ?? []).filter(visible).map((a) => renderRow(a, depth + 1, true))}
        {expandable && open[row.id] && row.type === "campaign" && (negativesOf.get(row.id) ?? []).filter((n) => !hidePaused || pendingIds.has(n.id)).map((n) => renderRow(n, depth + 1, false))}
        {expandable && open[row.id] && row.type === "adset" && (() => {
          const list = ads[row.id];
          const what = platform === "google" ? "mots-clés et annonces" : "annonces";
          if (list === "loading" || list === undefined) return <p className="text-xs text-gray-500 py-1 flex items-center gap-1" style={{ paddingLeft: 30 + (depth + 1) * 18 }}><Loader2 className="w-3 h-3 animate-spin" /> Lecture des {what}…</p>;
          if (!Array.isArray(list)) return <p className="text-xs text-red-300 py-1" style={{ paddingLeft: 30 + (depth + 1) * 18 }}>{list.error}</p>;
          if (!list.length) return <p className="text-xs text-gray-500 py-1" style={{ paddingLeft: 30 + (depth + 1) * 18 }}>{platform === "google" ? "Aucun mot-clé." : "Aucune annonce."}</p>;
          return list.filter(visible).map((ad) => renderRow(ad, depth + 1, false));
        })()}
      </div>
    );
  }

  return (
    <div>
      {newAdFor && (
        <NewAdForm
          clientId={clientId}
          accountId={accountId}
          adsetName={newAdFor.name}
          preset={studioPick}
          onCancel={() => setNewAdFor(null)}
          onDone={(spec, label) => { onAdd({ kind: "create_ad", objectType: "adset", objectId: newAdFor.id, value: JSON.stringify(spec), label }); setNewAdFor(null); }}
        />
      )}
      {textsFor && platform === "meta" && (
        <MetaAdTextsForm clientId={clientId} accountId={accountId} adId={textsFor.id} adName={textsFor.name} onCancel={() => setTextsFor(null)}
          onDone={(json, label) => { onAdd({ kind: "set_ad_texts", objectType: "ad", objectId: textsFor.id, value: json, label }); setTextsFor(null); }} />
      )}
      {textsFor && platform === "google" && textsFor.rsa && (
        <RsaTextsForm adName={textsFor.name} current={JSON.parse(textsFor.rsa) as RsaSpec} onCancel={() => setTextsFor(null)}
          onDone={(json, label) => { onAdd({ kind: "set_rsa_texts", objectType: "ad", objectId: textsFor.id, value: json, label }); setTextsFor(null); }} />
      )}
      {targetingFor && (
        <TargetingForm
          clientId={clientId}
          accountId={accountId}
          adsetId={targetingFor.id}
          adsetName={targetingFor.name}
          onCancel={() => setTargetingFor(null)}
          onDone={(json, label) => { onAdd({ kind: "set_targeting", objectType: "adset", objectId: targetingFor.id, value: json, label }); setTargetingFor(null); }}
        />
      )}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <label className="flex items-center gap-2 flex-1 min-w-[12rem] bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5">
          <Search className="w-3.5 h-3.5 text-gray-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={platform === "meta" ? "Chercher une campagne ou un ensemble" : "Chercher une campagne ou un groupe d'annonces"} className="bg-transparent text-sm text-white outline-none flex-1" />
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={hidePaused} onChange={(e) => setHidePaused(e.target.checked)} /> Actifs seulement
        </label>
      </div>
      {selected.size > 0 && (
        <div className="mb-3 rounded-xl border border-violet-500/40 bg-violet-500/5 px-3 py-2 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-white font-semibold">{selected.size} sélectionné{selected.size > 1 ? "s" : ""}</span>
            <span className="text-gray-500">— appliquer à tous :</span>
            <button type="button" onClick={() => bulkStatus("PAUSED")} className="px-2 py-1 rounded-md border border-gray-700 text-gray-200 hover:border-violet-500">Mettre en pause</button>
            <button type="button" onClick={() => bulkStatus("ACTIVE")} className="px-2 py-1 rounded-md border border-gray-700 text-gray-200 hover:border-violet-500">Activer</button>
            <button type="button" onClick={() => setBulk({ kind: "budget_pct", value: "-20" })} className="px-2 py-1 rounded-md border border-gray-700 text-gray-200 hover:border-violet-500">Budget ± %</button>
            <button type="button" onClick={() => setBulk({ kind: "budget_set", value: "" })} className="px-2 py-1 rounded-md border border-gray-700 text-gray-200 hover:border-violet-500">Budget =</button>
            {platform !== "google" && <button type="button" onClick={() => setBulk({ kind: "set_end_time", value: localDateTime(null, 7) })} className="px-2 py-1 rounded-md border border-gray-700 text-gray-200 hover:border-violet-500">Date de fin</button>}
            <button type="button" onClick={() => { if (window.confirm(`Supprimer ${selected.size} objet(s) ? Chaque suppression demandera une seconde confirmation à l'envoi.`)) bulkStatus("DELETED"); }} className="px-2 py-1 rounded-md border border-red-900 text-red-300 hover:border-red-500">Supprimer</button>
            <button type="button" onClick={() => setSelected(new Map())} className="ml-auto text-gray-400 hover:text-white">Tout désélectionner</button>
          </div>
          {bulk && (
            <form onSubmit={(e) => { e.preventDefault(); if (bulk.kind === "set_end_time") applyBulk("set_end_time", (row) => (row.type === "ad" || row.endTimeLock ? null : new Date(bulk.value).toISOString()), (row, v) => pendingLabel(platform, row, "set_end_time", String(v), currency)); else bulkBudget(bulk.kind, bulk.value); }} className="flex flex-wrap items-center gap-2">
              <span className="text-gray-400">{bulk.kind === "budget_pct" ? "Budget : variation en % (−20 = baisse de 20 %)" : bulk.kind === "budget_set" ? `Budget : nouveau montant en ${currency}` : "Date de fin"}</span>
              <input autoFocus type={bulk.kind === "set_end_time" ? "datetime-local" : "number"} step={bulk.kind === "set_end_time" ? undefined : "0.01"} value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1 text-white w-44" />
              <button type="submit" className="px-2.5 py-1 rounded-md bg-violet-600 hover:bg-violet-500 text-white">Appliquer à la sélection</button>
              <button type="button" onClick={() => setBulk(null)} className="text-gray-400 hover:text-white">Annuler</button>
              <span className="text-gray-500">Les budgets journaliers et totaux sont traités chacun à leur niveau ; les objets sans budget sont ignorés.</span>
            </form>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-2 pb-1 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
        <span className="flex-1 pl-24">Nom</span>
        <span className="w-24 text-right hidden sm:inline">Budget</span>
        <span className="w-20 text-right hidden md:inline">Dépense 7 j</span>
        <span className="w-20" />
      </div>
      {shownCampaigns.length ? shownCampaigns.map((c) => renderRow(c, 0, true)) : <p className="text-sm text-gray-500 py-6 text-center">Aucune campagne à afficher.</p>}
    </div>
  );
}
