"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, AlertCircle, TrendingUp, TrendingDown, Sparkles, Briefcase, CornerDownLeft, ArrowRight } from "lucide-react";
import { normalizeAct, type PreviewAccount } from "@/lib/use-account-list";

export type PaletteAction = "analyse" | "client";

interface AccountPaletteProps {
  open: boolean;
  onClose: () => void;
  accounts: PreviewAccount[];
  loading: boolean;
  /** Account currently analysed (highlighted with a dot). */
  currentId?: string | null;
  /** What ↵ does. The other action stays reachable with → or the row button. */
  primary: PaletteAction;
  onPick: (account: PreviewAccount, action: PaletteAction) => void;
  title?: string;
}

const ACTION_LABEL: Record<PaletteAction, string> = {
  analyse: "Analyser les créas",
  client: "Ouvrir la fiche client",
};

function fmtMoney(n: number): string {
  if (n === 0) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

/**
 * The client switcher (⌘K). One list for the whole app: name, id, 7-day spend,
 * ROAS, open alerts. Each row offers both destinations — the client sheet
 * (/portfolio) and the creative analysis — the caller only decides which one
 * ↵ triggers, depending on where the user is.
 */
export function AccountPalette(props: AccountPaletteProps) {
  // Mounted only while open: the search / highlight state starts fresh each time.
  if (!props.open) return null;
  return <PaletteBody {...props} />;
}

function PaletteBody({ onClose, accounts, loading, currentId, primary, onPick, title }: AccountPaletteProps) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const secondary: PaletteAction = primary === "analyse" ? "client" : "analyse";

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    if (!query.trim()) return accounts;
    const q = query.toLowerCase();
    return accounts.filter((a) => a.name.toLowerCase().includes(q) || (a.clientName ?? "").toLowerCase().includes(q) || a.id.includes(q));
  }, [accounts, query]);

  // Keep the highlighted row in view while navigating with the keyboard.
  useEffect(() => {
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const actionAvailable = (a: PreviewAccount, action: PaletteAction) =>
    !a.outOfScope && (action === "analyse" || !!a.clientId);

  function pick(a: PreviewAccount, action: PaletteAction) {
    if (!actionAvailable(a, action)) {
      // Client sheet missing → fall back to the analysis so ↵ always does something.
      if (action === "client" && !a.outOfScope) onPick(a, "analyse");
      return;
    }
    onPick(a, action);
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[highlight];
      if (a) pick(a, primary);
    } else if (e.key === "ArrowRight" && !query) {
      e.preventDefault();
      const a = filtered[highlight];
      if (a) pick(a, secondary);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh] bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title ?? "Changer de client"}
    >
      <div
        className="w-full max-w-2xl bg-ui-bg border border-ui-line rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-ui-line">
          <Search className="w-4 h-4 text-ui-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={handleKey}
            placeholder={title ?? "Rechercher un client…"}
            className="flex-1 bg-transparent outline-none text-sm text-ui-fg placeholder:text-ui-muted"
          />
          <span className="text-xs text-ui-muted">{filtered.length} compte{filtered.length > 1 ? "s" : ""}</span>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {loading && accounts.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-ui-muted">Chargement…</div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-ui-muted">
              {accounts.length === 0 ? "Aucun compte ne vous est attribué. Demandez à un admin." : `Aucun compte ne correspond à "${query}".`}
            </div>
          ) : (
            <ul ref={listRef}>
              {filtered.map((a, i) => {
                const active = i === highlight;
                const isCurrent = !!currentId && normalizeAct(a.id) === normalizeAct(currentId);
                return (
                  <li key={a.id}>
                    <div
                      onMouseEnter={() => setHighlight(i)}
                      className={`group w-full px-4 py-2.5 flex items-center gap-3 transition-colors ${
                        a.outOfScope ? "opacity-50" : ""
                      } ${active ? "bg-ui-accent-soft" : ""}`}
                    >
                      <button
                        type="button"
                        onClick={() => pick(a, primary)}
                        disabled={a.outOfScope}
                        className="flex-1 min-w-0 text-left disabled:cursor-not-allowed"
                      >
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium truncate ${isCurrent ? "text-ui-accent-ink" : "text-ui-fg"}`}>
                            {a.clientName ?? a.name}
                          </span>
                          {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-ui-accent shrink-0" title="Compte analysé actuellement" />}
                          {a.outOfScope && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 shrink-0">hors BM</span>
                          )}
                          {a.alertCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 shrink-0">
                              <AlertCircle className="w-2.5 h-2.5" />
                              {a.alertCount}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-ui-muted mt-0.5 truncate">
                          {a.clientName && a.clientName !== a.name ? `${a.name} · ` : ""}{a.id}
                        </div>
                      </button>

                      <div className="flex items-center gap-4 shrink-0 text-xs">
                        <div className="text-right w-16">
                          <div className="text-ui-muted">Spend 7j</div>
                          <div className="font-medium text-ui-fg">{fmtMoney(a.spend7d)}</div>
                        </div>
                        <div className="text-right w-12">
                          <div className="text-ui-muted">ROAS</div>
                          <div className={`font-medium inline-flex items-center gap-1 ${
                            a.roas7d === 0 ? "text-ui-muted" : a.roas7d >= 2 ? "text-emerald-400" : "text-amber-400"
                          }`}>
                            {a.roas7d > 0 && (a.roas7d >= 2 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />)}
                            {a.roas7d > 0 ? `${a.roas7d.toFixed(2)}x` : "—"}
                          </div>
                        </div>
                      </div>

                      {/* Both destinations, always one click away; ↵ = primary. */}
                      <div className={`flex items-center gap-1 shrink-0 transition-opacity ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                        <RowAction
                          icon={Briefcase}
                          label="Fiche"
                          primary={primary === "client"}
                          disabled={!actionAvailable(a, "client")}
                          title={a.clientId ? "Ouvrir la fiche client" : "Aucun dashboard client lié à ce compte"}
                          onClick={() => pick(a, "client")}
                        />
                        <RowAction
                          icon={Sparkles}
                          label="Créas"
                          primary={primary === "analyse"}
                          disabled={a.outOfScope}
                          title="Analyser les créas de ce compte"
                          onClick={() => pick(a, "analyse")}
                        />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-ui-line text-[11px] text-ui-muted">
          <div className="flex items-center gap-3">
            <span><kbd className="px-1 py-0.5 rounded bg-ui-raised text-ui-fg2">↑↓</kbd> naviguer</span>
            <span className="inline-flex items-center gap-1"><kbd className="px-1 py-0.5 rounded bg-ui-raised text-ui-fg2 inline-flex"><CornerDownLeft className="w-2.5 h-2.5" /></kbd> {ACTION_LABEL[primary]}</span>
            <span className="inline-flex items-center gap-1"><kbd className="px-1 py-0.5 rounded bg-ui-raised text-ui-fg2 inline-flex"><ArrowRight className="w-2.5 h-2.5" /></kbd> {ACTION_LABEL[secondary]}</span>
            <span><kbd className="px-1 py-0.5 rounded bg-ui-raised text-ui-fg2">esc</kbd> fermer</span>
          </div>
          <span>Trié par alertes puis spend 7j</span>
        </div>
      </div>
    </div>
  );
}

function RowAction({ icon: Icon, label, primary, disabled, title, onClick }: {
  icon: React.ElementType; label: string; primary: boolean; disabled: boolean; title: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        primary
          ? "bg-ui-accent-soft border-ui-accent text-ui-accent-ink hover:bg-ui-accent-soft"
          : "bg-ui-card border-ui-line text-ui-fg2 hover:border-ui-line-strong hover:text-ui-fg"
      }`}
    >
      <Icon className="w-3 h-3" /> {label}
    </button>
  );
}
