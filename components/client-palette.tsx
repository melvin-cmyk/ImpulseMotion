"use client";

/**
 * ⌘K — the global client picker. Two groups:
 *   - Clients: every client the viewer may see (GET /api/clients), found by
 *     name, Meta account id, Google Ads customer id or TikTok advertiser id.
 *     ↵ opens the client's cockpit (/portfolio/[id]).
 *   - Comptes Meta: the ad accounts of the business manager (analysis pages).
 *     ↵ analyses that account (Analyse Ads); → opens its client when it has one.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Briefcase, CornerDownLeft, FileText, Search, Sparkles, Sun, Zap } from "lucide-react";
import { normalizeAct, type PreviewAccount } from "@/lib/use-account-list";

export interface ClientRow {
  id: string;
  clientId: string;
  name: string;
  dashboardId: string | null;
  accounts: Array<{ platform: "meta" | "google" | "tiktok"; id: string; name: string }>;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  tiktokAdvertiserIds: string[];
}

export type PaletteAction = "analyse" | "client";

/** An extra row a caller adds (Mo's palette: actions, pages): found by its label and keywords, ↵ runs it. */
export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  /** Section header the row is listed under (« Actions », « Pages »). */
  group: string;
  icon?: "action" | "page" | "home" | "client";
  keywords?: string;
  onPick: () => void;
}

type Row = { kind: "client"; client: ClientRow } | { kind: "account"; account: PreviewAccount } | { kind: "command"; command: PaletteCommand };

function norm(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
function digits(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

/** A client matches on its name or on any of its ids (digits compared without act_ or dashes). */
function clientMatches(c: ClientRow, q: string, qd: string): boolean {
  if (norm(c.name).includes(q)) return true;
  if (!qd) return false;
  const ids = c.accounts.map((a) => a.id);
  return ids.some((id) => digits(id).includes(qd));
}

export function ClientPalette({ open, onClose, clients, accounts, loading, currentAccountId, primary, onPickClient, onPickAccount, title, commands = [], clientHint = "cockpit", clientSubtitle }: {
  open: boolean;
  onClose: () => void;
  clients: ClientRow[];
  accounts: PreviewAccount[];
  loading: boolean;
  currentAccountId?: string | null;
  /** What ↵ does on a Meta account row (clients always open their cockpit). */
  primary: PaletteAction;
  onPickClient: (client: ClientRow) => void;
  onPickAccount: (account: PreviewAccount, action: PaletteAction) => void;
  title?: string;
  /** Extra rows (actions, pages): first when nothing is typed, after the clients once a search narrows them. */
  commands?: PaletteCommand[];
  /** What ↵ does on a client row, shown on the right (« cockpit », « cadre »…). */
  clientHint?: string;
  /** Second line of a client row (default: its accounts). */
  clientSubtitle?: (client: ClientRow) => string;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Fresh search each time the palette opens (after the paint, never during it).
    const t = setTimeout(() => { setQuery(""); setHighlight(0); inputRef.current?.focus(); }, 10);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const rows = useMemo<Row[]>(() => {
    const q = norm(query.trim());
    const qd = digits(query);
    const clientRows: Row[] = (q ? clients.filter((c) => clientMatches(c, q, qd)) : clients).map((client) => ({ kind: "client", client }));
    // Meta accounts not already represented by a client row (same account), unless the viewer searches an id.
    const clientMeta = new Set(clients.map((c) => c.metaAccountId && normalizeAct(c.metaAccountId)).filter(Boolean));
    const accountRows: Row[] = accounts
      .filter((a) => !clientMeta.has(normalizeAct(a.id)) || primary === "analyse")
      .filter((a) => !q || norm(a.name).includes(q) || norm(a.clientName ?? "").includes(q) || (qd && digits(a.id).includes(qd)))
      .map((account) => ({ kind: "account", account }));
    const commandRows: Row[] = commands.filter((c) => !q || norm(`${c.label} ${c.keywords ?? ""} ${c.group}`).includes(q)).map((command) => ({ kind: "command", command }));
    const main = primary === "analyse" ? [...accountRows, ...clientRows] : [...clientRows, ...accountRows];
    return q ? [...main, ...commandRows] : [...commandRows, ...main];
  }, [clients, accounts, query, primary, commands]);

  useEffect(() => {
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function activate(row: Row, alt = false) {
    if (row.kind === "command") { row.command.onPick(); return; }
    if (row.kind === "client") { onPickClient(row.client); return; }
    const a = row.account;
    if (a.outOfScope) return;
    const action: PaletteAction = alt ? (primary === "analyse" ? "client" : "analyse") : primary;
    if (action === "client" && !a.clientId) { onPickAccount(a, "analyse"); return; }
    onPickAccount(a, action);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && rows[highlight]) { e.preventDefault(); activate(rows[highlight]); }
    else if (e.key === "ArrowRight" && rows[highlight]?.kind === "account") { e.preventDefault(); activate(rows[highlight], true); }
  }

  if (!open) return null;
  const nClients = rows.filter((r) => r.kind === "client").length;
  const nAccounts = rows.filter((r) => r.kind === "account").length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-2xl bg-gray-950 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
          <Search className="w-4 h-4 text-gray-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
            onKeyDown={handleKey}
            placeholder={title ?? "Client, compte Meta (act_…), Google Ads (123-456-7890), TikTok…"}
            className="flex-1 bg-transparent outline-none text-sm text-white placeholder:text-gray-500"
          />
          <span className="text-xs text-gray-600 shrink-0">{nClients} client{nClients > 1 ? "s" : ""}{nAccounts ? ` · ${nAccounts} compte${nAccounts > 1 ? "s" : ""}` : ""}</span>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {loading && rows.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500">Chargement…</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500">
              {clients.length === 0 && accounts.length === 0 ? "Aucun client ni compte ne vous est attribué. Demandez à un admin." : `Rien ne correspond à « ${query} ».`}
            </div>
          ) : (
            <ul ref={listRef}>
              {rows.map((row, i) => {
                const active = i === highlight;
                const prev = rows[i - 1];
                const groupOf = (r: Row) => (r.kind === "client" ? "Clients" : r.kind === "account" ? "Comptes Meta (analyse)" : r.command.group);
                const header = !prev || groupOf(prev) !== groupOf(row);
                return (
                  <li key={row.kind === "client" ? `c:${row.client.id}` : row.kind === "account" ? `a:${row.account.id}` : `k:${row.command.id}`}>
                    {header && (
                      <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide text-gray-600">{groupOf(row)}</div>
                    )}
                    {row.kind === "command" ? (
                      <div onMouseEnter={() => setHighlight(i)} data-palette-command={row.command.id} className={`group w-full px-4 py-2.5 flex items-center gap-3 transition-colors ${active ? "bg-violet-500/10" : ""}`}>
                        {row.command.icon === "page" ? <FileText className="w-4 h-4 text-gray-400 shrink-0" /> : row.command.icon === "home" ? <Sun className="w-4 h-4 text-violet-300 shrink-0" /> : row.command.icon === "client" ? <Briefcase className="w-4 h-4 text-violet-400 shrink-0" /> : <Zap className="w-4 h-4 text-fuchsia-300 shrink-0" />}
                        <button type="button" onClick={() => activate(row)} className="flex-1 min-w-0 text-left">
                          <div className="text-sm font-medium text-white truncate">{row.command.label}</div>
                          {row.command.hint && <div className="text-xs text-gray-500 mt-0.5 truncate">{row.command.hint}</div>}
                        </button>
                        <span className={`text-[10px] text-gray-500 inline-flex items-center gap-1 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}><CornerDownLeft className="w-3 h-3" /></span>
                      </div>
                    ) : row.kind === "client" ? (
                      <div onMouseEnter={() => setHighlight(i)} data-palette-client={row.client.id} className={`group w-full px-4 py-2.5 flex items-center gap-3 transition-colors ${active ? "bg-violet-500/10" : ""}`}>
                        <Briefcase className="w-4 h-4 text-violet-400 shrink-0" />
                        <button type="button" onClick={() => activate(row)} className="flex-1 min-w-0 text-left">
                          <div className="text-sm font-medium text-white truncate">{row.client.name}</div>
                          <div className="text-xs text-gray-500 mt-0.5 truncate">
                            {clientSubtitle ? clientSubtitle(row.client) : <>{row.client.accounts.map((a) => `${a.platform === "meta" ? "Meta" : a.platform === "google" ? "Google" : "TikTok"} ${a.id}`).join(" · ") || "aucun compte rattaché"}{row.client.dashboardId ? "" : " · sans dashboard"}</>}
                          </div>
                        </button>
                        <span className={`text-[10px] text-gray-500 inline-flex items-center gap-1 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}><CornerDownLeft className="w-3 h-3" /> {clientHint}</span>
                      </div>
                    ) : (
                      <AccountRow account={row.account} active={active} current={!!currentAccountId && normalizeAct(row.account.id) === normalizeAct(currentAccountId)} primary={primary} onHover={() => setHighlight(i)} onPick={(alt) => activate(row, alt)} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="px-4 py-2 border-t border-gray-800 text-[10px] text-gray-600 flex items-center gap-3">
          <span>↑↓ naviguer</span><span>↵ ouvrir</span><span>→ autre action</span><span>esc fermer</span>
        </div>
      </div>
    </div>
  );
}

function AccountRow({ account: a, active, current, primary, onHover, onPick }: { account: PreviewAccount; active: boolean; current: boolean; primary: PaletteAction; onHover: () => void; onPick: (alt: boolean) => void }) {
  const altLabel = primary === "analyse" ? (a.clientId ? "cockpit" : null) : "analyser";
  return (
    <div onMouseEnter={onHover} className={`group w-full px-4 py-2.5 flex items-center gap-3 transition-colors ${a.outOfScope ? "opacity-50" : ""} ${active ? "bg-violet-500/10" : ""}`}>
      <Sparkles className="w-4 h-4 text-gray-500 shrink-0" />
      <button type="button" onClick={() => onPick(false)} disabled={a.outOfScope} className="flex-1 min-w-0 text-left disabled:cursor-not-allowed">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium truncate ${current ? "text-violet-300" : "text-white"}`}>{a.clientName ?? a.name}</span>
          {current && <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" title="Compte analysé actuellement" />}
          {a.outOfScope && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 shrink-0">hors BM</span>}
          {a.alertCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 shrink-0"><AlertCircle className="w-2.5 h-2.5" />{a.alertCount}</span>
          )}
        </div>
        <div className="text-xs text-gray-500 mt-0.5 truncate">{a.clientName && a.clientName !== a.name ? `${a.name} · ` : ""}{a.id}</div>
      </button>
      {altLabel && !a.outOfScope && (
        <button type="button" onClick={() => onPick(true)} className={`text-[10px] text-gray-400 hover:text-white inline-flex items-center gap-1 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
          <ArrowRight className="w-3 h-3" /> {altLabel}
        </button>
      )}
    </div>
  );
}
