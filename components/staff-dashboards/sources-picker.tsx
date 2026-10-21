"use client";

/**
 * Sélecteur des sources d'un dashboard du staff : le consultant coche les
 * plateformes (Google Ads, Meta, TikTok, GA4, Sheets…) puis, pour les
 * plateformes publicitaires et l'entrepôt, les comptes du client parmi ceux
 * de son périmètre (GET /api/staff-dashboards/sources) ou un identifiant saisi
 * à la main. Le résultat (StaffSource[]) est gardé sur le dashboard et donné
 * au copilote à chaque tour.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Search, X } from "lucide-react";
import { FIELD } from "@/components/staff-dashboards/model";
import {
  MAX_SOURCE_ACCOUNTS, SOURCE_KINDS, normalizeSourceAccountId, sourceKindInfo,
  type SourceAccount, type SourceKind, type StaffSource,
} from "@/lib/staff-dashboards/sources";

interface ClientRow { id: string; name: string; accounts: Array<{ platform: string; accountId: string; name: string; currency: string | null }> }
interface WarehouseRow { clientKey: string; name: string; tools: string[] }
interface Catalogue { clients: ClientRow[]; warehouses: WarehouseRow[] }

/** Un compte proposé au choix, avec le client qui le porte. */
interface Choice { id: string; name: string; client: string; extra?: string }

const LIST_LIMIT = 40;

function choicesFor(kind: SourceKind, cat: Catalogue | null): Choice[] {
  if (!cat) return [];
  const info = sourceKindInfo(kind);
  if (info.accountPlatform === "warehouse") {
    return cat.warehouses.map((w) => ({ id: w.clientKey, name: w.name, client: w.name, extra: w.tools.includes("datasets") ? "commandes + fichiers" : "commandes" }));
  }
  if (!info.accountPlatform) return [];
  const out: Choice[] = [];
  for (const c of cat.clients) {
    for (const a of c.accounts) {
      if (a.platform !== info.accountPlatform) continue;
      out.push({ id: normalizeSourceAccountId(kind, a.accountId), name: a.name || a.accountId, client: c.name, extra: a.currency ?? undefined });
    }
  }
  return out;
}

function matches(c: Choice, q: string): boolean {
  if (!q) return true;
  const hay = `${c.client} ${c.name} ${c.id}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function SourcesPicker({ value, onChange, disabled }: { value: StaffSource[]; onChange: (next: StaffSource[]) => void; disabled?: boolean }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [queries, setQueries] = useState<Partial<Record<SourceKind, string>>>({});
  const [manual, setManual] = useState<Partial<Record<SourceKind, string>>>({});

  const requested = useRef(false);

  // La liste des clients n'est lue qu'une fois, et seulement quand une plateforme à comptes est cochée.
  const ensureCatalogue = useCallback(() => {
    if (requested.current) return;
    requested.current = true;
    setLoading(true);
    fetch("/api/staff-dashboards/sources")
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof body.error === "string" ? body.error : `Erreur ${r.status}`);
        return body as Catalogue;
      })
      .then((c) => { setCatalogue({ clients: Array.isArray(c.clients) ? c.clients : [], warehouses: Array.isArray(c.warehouses) ? c.warehouses : [] }); setLoadError(null); })
      .catch((e) => { setLoadError(e instanceof Error ? e.message : String(e)); requested.current = false; })
      .finally(() => setLoading(false));
  }, []);

  // Éditeur d'un dashboard existant : des plateformes à comptes sont déjà cochées à l'ouverture.
  const needsCatalogue = value.some((s) => sourceKindInfo(s.kind).accountPlatform);
  useEffect(() => {
    if (!needsCatalogue) return;
    const t = setTimeout(ensureCatalogue, 0);
    return () => clearTimeout(t);
  }, [needsCatalogue, ensureCatalogue]);

  const selected = useMemo(() => new Map(value.map((s) => [s.kind, s])), [value]);

  function setSource(kind: SourceKind, patch: Partial<StaffSource> | null) {
    if (patch === null) { onChange(value.filter((s) => s.kind !== kind)); return; }
    const existing = selected.get(kind);
    if (existing) { onChange(value.map((s) => (s.kind === kind ? { ...s, ...patch } : s))); return; }
    // Ordre d'affichage = ordre des types, pas ordre de clic.
    const next = [...value, { kind, accounts: [], detail: "", ...patch }];
    const rank = (k: SourceKind) => SOURCE_KINDS.findIndex((i) => i.kind === k);
    onChange(next.sort((a, b) => rank(a.kind) - rank(b.kind)));
  }

  function toggleKind(kind: SourceKind) {
    if (selected.has(kind)) { setSource(kind, null); return; }
    if (sourceKindInfo(kind).accountPlatform) ensureCatalogue();
    setSource(kind, {});
  }

  function toggleAccount(kind: SourceKind, account: SourceAccount) {
    const s = selected.get(kind);
    if (!s) return;
    const has = s.accounts.some((a) => a.id === account.id);
    if (has) { setSource(kind, { accounts: s.accounts.filter((a) => a.id !== account.id) }); return; }
    if (s.accounts.length >= MAX_SOURCE_ACCOUNTS) return;
    setSource(kind, { accounts: [...s.accounts, account] });
  }

  function addManual(kind: SourceKind) {
    const raw = (manual[kind] ?? "").trim();
    if (!raw) return;
    const id = normalizeSourceAccountId(kind, raw);
    const known = choicesFor(kind, catalogue).find((c) => c.id === id);
    toggleAccount(kind, { id, name: known?.name ?? id });
    setManual((m) => ({ ...m, [kind]: "" }));
  }

  const chip = (active: boolean) => `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors disabled:opacity-50 ${active ? "bg-violet-600 border-violet-500 text-white" : "bg-gray-950 border-gray-800 text-gray-300 hover:border-gray-600 hover:text-white"}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Sources du dashboard">
        {SOURCE_KINDS.map((k) => (
          <button key={k.kind} type="button" disabled={disabled} aria-pressed={selected.has(k.kind)} onClick={() => toggleKind(k.kind)} className={chip(selected.has(k.kind))} title={k.hint}>
            {k.label}
            {selected.get(k.kind)?.accounts.length ? <span className="text-[10px] bg-white/20 rounded-full px-1.5">{selected.get(k.kind)!.accounts.length}</span> : null}
          </button>
        ))}
      </div>

      {value.map((s) => {
        const info = sourceKindInfo(s.kind);
        const query = queries[s.kind] ?? "";
        const choices = info.accountPlatform ? choicesFor(s.kind, catalogue) : [];
        const chosen = new Set(s.accounts.map((a) => a.id));
        const filtered = choices.filter((c) => matches(c, query));
        const shown = filtered.slice(0, LIST_LIMIT);
        return (
          <div key={s.kind} className="rounded-lg border border-gray-800 bg-gray-950/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white">{info.label}</p>
                <p className="text-[11px] text-gray-500">{info.hint}</p>
              </div>
              <button type="button" disabled={disabled} onClick={() => setSource(s.kind, null)} className="text-gray-500 hover:text-red-300 shrink-0" title={`Retirer ${info.label}`} aria-label={`Retirer ${info.label}`}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {info.accountPlatform && (
              <>
                {s.accounts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {s.accounts.map((a) => (
                      <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-100 text-[11px] px-2 py-0.5 max-w-full">
                        <span className="truncate">{a.name}{a.name !== a.id ? <span className="text-violet-300/70"> · {a.id}</span> : null}</span>
                        <button type="button" disabled={disabled} onClick={() => toggleAccount(s.kind, a)} className="text-violet-300 hover:text-white" aria-label={`Retirer ${a.name}`}><X className="w-3 h-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
                {loading && !catalogue && <p className="text-[11px] text-gray-500 inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Lecture des comptes de votre périmètre…</p>}
                {loadError && <p className="text-[11px] text-amber-300">Comptes non listés ({loadError}) : saisissez l&apos;identifiant à la main.</p>}
                {catalogue && choices.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="relative block">
                      <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        value={query}
                        disabled={disabled}
                        onChange={(e) => setQueries((q) => ({ ...q, [s.kind]: e.target.value }))}
                        placeholder={`Chercher un client ou un compte ${info.label}…`}
                        className={`${FIELD} pl-8 py-1.5 text-xs`}
                      />
                    </label>
                    <ul className="max-h-44 overflow-y-auto divide-y divide-gray-900 rounded-md border border-gray-800">
                      {shown.map((c) => (
                        <li key={c.id}>
                          <label className="flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer hover:bg-gray-900">
                            <input type="checkbox" disabled={disabled} checked={chosen.has(c.id)} onChange={() => toggleAccount(s.kind, { id: c.id, name: c.name })} className="accent-violet-600" />
                            <span className="min-w-0 flex-1 truncate">
                              <span className="text-gray-200">{c.client}</span>
                              {c.name !== c.client && <span className="text-gray-400"> › {c.name}</span>}
                            </span>
                            <span className="text-[10px] text-gray-500 font-mono shrink-0">{c.id}{c.extra ? ` · ${c.extra}` : ""}</span>
                          </label>
                        </li>
                      ))}
                      {shown.length === 0 && <li className="px-2.5 py-2 text-[11px] text-gray-500">Aucun compte ne correspond.</li>}
                      {filtered.length > shown.length && <li className="px-2.5 py-1.5 text-[11px] text-gray-500">… et {filtered.length - shown.length} autres : affinez la recherche.</li>}
                    </ul>
                  </div>
                )}
                {catalogue && choices.length === 0 && !loadError && (
                  <p className="text-[11px] text-gray-500">Aucun compte {info.label} dans votre périmètre : saisissez l&apos;identifiant à la main.</p>
                )}
                {info.idPlaceholder && (
                  <div className="flex items-center gap-2">
                    <input
                      value={manual[s.kind] ?? ""}
                      disabled={disabled}
                      onChange={(e) => setManual((m) => ({ ...m, [s.kind]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManual(s.kind); } }}
                      placeholder={`Autre identifiant (${info.idPlaceholder})`}
                      className={`${FIELD} py-1.5 text-xs font-mono`}
                    />
                    <button type="button" disabled={disabled || !(manual[s.kind] ?? "").trim()} onClick={() => addManual(s.kind)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs disabled:opacity-40 shrink-0">
                      <Plus className="w-3.5 h-3.5" /> Ajouter
                    </button>
                  </div>
                )}
              </>
            )}

            {info.detailLabel && (
              <label className="block">
                <span className="text-[11px] text-gray-400">{info.detailLabel}</span>
                <input value={s.detail} disabled={disabled} maxLength={600} onChange={(e) => setSource(s.kind, { detail: e.target.value })} className={`${FIELD} mt-1 py-1.5 text-xs`} />
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
