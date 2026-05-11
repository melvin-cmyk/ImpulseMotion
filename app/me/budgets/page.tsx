"use client";

import { useEffect, useState, useCallback } from "react";
import { PageHeader, Card, Pill } from "@/components/ui/surface";
import { Target, TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";

type Account = { platform: string; accountId: string; label: string | null };

type Pacing = {
  accountId: string;
  monthlyTarget: number;
  currency: string;
  mtdSpend: number;
  daysElapsed: number;
  daysInMonth: number;
  daysRemaining: number;
  dailyRunRate: number;
  projectedSpend: number;
  pacingPct: number;
  status: "on_track" | "under" | "over" | "critical_under" | "critical_over";
};

type Budget = {
  id: string;
  userId: string;
  accountId: string;
  platform: string;
  monthlyTarget: number;
  currency: string;
  updatedAt: string;
  pacing?: Pacing | null;
};

const inputCls =
  "px-3 py-2 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";
const primaryBtnCls =
  "px-4 py-2 rounded-lg font-semibold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-colors";

function fmtMoney(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}

const STATUS_LABEL: Record<Pacing["status"], string> = {
  on_track: "Dans la cible",
  under: "Sous-consomme",
  over: "Sur-consomme",
  critical_under: "Très en retard",
  critical_over: "Très en avance",
};

const STATUS_TONE: Record<Pacing["status"], "emerald" | "amber" | "red" | "blue"> = {
  on_track: "emerald",
  under: "amber",
  over: "amber",
  critical_under: "red",
  critical_over: "red",
};

function PacingBar({ pacing }: { pacing: Pacing }) {
  // Two bars stacked: target (gray) and projected (colored).
  // Pacing % drives the colored bar width relative to target = 100%.
  const projectedPct = Math.min(pacing.pacingPct, 200);
  const elapsedPct = Math.round((pacing.daysElapsed / pacing.daysInMonth) * 100);
  const color =
    pacing.status === "on_track"
      ? "bg-emerald-500"
      : pacing.status === "critical_under" || pacing.status === "critical_over"
      ? "bg-red-500"
      : "bg-amber-500";

  return (
    <div className="space-y-1.5">
      <div className="relative h-2.5 rounded-full bg-gray-800 overflow-hidden">
        {/* Time-elapsed marker */}
        <div
          className="absolute top-0 bottom-0 w-px bg-white/30"
          style={{ left: `${Math.min(elapsedPct, 100)}%` }}
          title={`Jour ${pacing.daysElapsed} / ${pacing.daysInMonth}`}
        />
        {/* MTD spend (filled, gray) */}
        <div
          className="absolute top-0 bottom-0 bg-gray-600"
          style={{ width: `${Math.min((pacing.mtdSpend / pacing.monthlyTarget) * 100, 100)}%` }}
        />
        {/* Projection (colored, semi-transparent on top) */}
        <div
          className={`absolute top-0 bottom-0 ${color} opacity-70`}
          style={{ width: `${Math.min(projectedPct, 100)}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span>
          MTD : <span className="text-white">{fmtMoney(pacing.mtdSpend, pacing.currency)}</span> ·
          Run rate : <span className="text-white">{fmtMoney(pacing.dailyRunRate, pacing.currency)}/j</span>
        </span>
        <span>
          Projeté : <span className="text-white">{fmtMoney(pacing.projectedSpend, pacing.currency)}</span> /
          <span> {fmtMoney(pacing.monthlyTarget, pacing.currency)}</span>
        </span>
      </div>
    </div>
  );
}

export default function MeBudgetsPage() {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formAccountId, setFormAccountId] = useState("");
  const [formTarget, setFormTarget] = useState<number | "">("");
  const [formCurrency, setFormCurrency] = useState("EUR");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [b, a] = await Promise.all([
      fetch("/api/me/budgets?withPacing=1").then((r) => r.json()),
      fetch("/api/me/accounts").then((r) => r.json()),
    ]);
    setBudgets(b.budgets ?? []);
    setAccounts(a.accounts ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const availableAccounts = accounts.filter(
    (a) => a.platform === "meta" && !budgets.some((b) => b.accountId === a.accountId),
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!formAccountId || !formTarget) {
      setError("Compte et budget requis");
      return;
    }
    const res = await fetch("/api/me/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: formAccountId,
        platform: "meta",
        monthlyTarget: Number(formTarget),
        currency: formCurrency,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Création échouée");
      return;
    }
    setFormAccountId("");
    setFormTarget("");
    setShowCreate(false);
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Supprimer ce budget ?")) return;
    await fetch(`/api/me/budgets/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <PageHeader
        title="Mes budgets"
        subtitle="Définis un budget mensuel par compte. Le pacing compare ce que tu vas dépenser à ton objectif."
        action={
          availableAccounts.length > 0 && (
            <button onClick={() => setShowCreate((s) => !s)} className={primaryBtnCls}>
              + Nouveau budget
            </button>
          )
        }
      />

      {showCreate && (
        <Card padded>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="block">
                <span className="text-xs text-gray-400">Compte</span>
                <select
                  value={formAccountId}
                  onChange={(e) => setFormAccountId(e.target.value)}
                  required
                  className={`${inputCls} mt-1 w-full`}
                >
                  <option value="">— Sélectionner —</option>
                  {availableAccounts.map((a) => (
                    <option key={a.accountId} value={a.accountId}>{a.label ?? a.accountId}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-gray-400">Budget mensuel</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={formTarget}
                  onChange={(e) => setFormTarget(e.target.value === "" ? "" : Number(e.target.value))}
                  required
                  placeholder="10000"
                  className={`${inputCls} mt-1 w-full`}
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-400">Devise</span>
                <select
                  value={formCurrency}
                  onChange={(e) => setFormCurrency(e.target.value)}
                  className={`${inputCls} mt-1 w-full`}
                >
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                  <option value="GBP">GBP</option>
                </select>
              </label>
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white">
                Annuler
              </button>
              <button type="submit" className={primaryBtnCls.replace("py-2", "py-1.5")}>
                Créer
              </button>
            </div>
          </form>
        </Card>
      )}

      {loading ? (
        <p className="text-gray-400">Chargement…</p>
      ) : budgets.length === 0 ? (
        <Card padded className="text-center text-gray-500 border-dashed">
          <Target className="w-8 h-8 mx-auto mb-2 text-gray-700" />
          Aucun budget configuré. Définis un budget mensuel pour suivre ton pacing par compte.
        </Card>
      ) : (
        <div className="space-y-3">
          {budgets.map((b) => {
            const account = accounts.find((a) => a.accountId === b.accountId);
            const label = account?.label ?? b.accountId;
            const p = b.pacing;
            return (
              <Card key={b.id} padded className="space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white">{label}</span>
                      <Pill tone="violet">{b.platform}</Pill>
                      {p && <Pill tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Pill>}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Objectif : <span className="text-white">{fmtMoney(b.monthlyTarget, b.currency)}</span>
                      {p && <> · J{p.daysElapsed}/{p.daysInMonth} · reste {p.daysRemaining}j</>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {p && (
                      <div className="text-right">
                        <div className={`text-2xl font-bold inline-flex items-center gap-1 ${
                          p.status === "on_track"
                            ? "text-emerald-400"
                            : p.status.startsWith("critical")
                            ? "text-red-400"
                            : "text-amber-400"
                        }`}>
                          {p.status === "critical_over" && <AlertTriangle className="w-5 h-5" />}
                          {p.status === "critical_under" && <AlertTriangle className="w-5 h-5" />}
                          {p.pacingPct > 100 ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
                          {p.pacingPct}%
                        </div>
                        <div className="text-[10px] text-gray-500 uppercase tracking-wide">pacing</div>
                      </div>
                    )}
                    <button onClick={() => handleDelete(b.id)} className="text-xs text-red-400 hover:text-red-300 ml-2">
                      Supprimer
                    </button>
                  </div>
                </div>
                {p && <PacingBar pacing={p} />}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
