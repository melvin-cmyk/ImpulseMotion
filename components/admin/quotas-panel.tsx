"use client";

/**
 * Admin → Quotas: the daily caps of the AI generation (team and per
 * consultant, in dollars and in images) and of the client bots (messages a
 * day), with what was spent today. Also shown at the top of Admin → Bots.
 */

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Section } from "@/components/ui/surface";

interface Quotas { teamDailyUsd: number; userDailyUsd: number; teamDailyImages: number; botDailyMessages: number; warnAtPct: number }
interface Today { team: { usd: number; images: number }; user: { usd: number; images: number } }

const usd = (v: number) => `${v.toFixed(2).replace(".", ",")} $`;
const inputCls = "w-28 px-2.5 py-1.5 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white focus:border-violet-500 focus:outline-none";

export function QuotasPanel({ compact = false }: { compact?: boolean }) {
  const [quotas, setQuotas] = useState<Quotas | null>(null);
  const [today, setToday] = useState<Today | null>(null);
  const [draft, setDraft] = useState<Record<keyof Quotas, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/quotas", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j: { quotas: Quotas; today: Today } | null) => {
      if (cancelled || !j) return;
      setQuotas(j.quotas); setToday(j.today);
      setDraft({ teamDailyUsd: String(j.quotas.teamDailyUsd), userDailyUsd: String(j.quotas.userDailyUsd), teamDailyImages: String(j.quotas.teamDailyImages), botDailyMessages: String(j.quotas.botDailyMessages), warnAtPct: String(j.quotas.warnAtPct) });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true); setMsg(null);
    try {
      const body: Record<string, number> = {};
      for (const [k, v] of Object.entries(draft)) { const n = Number(v.replace(",", ".")); if (Number.isFinite(n) && n >= 0) body[k] = n; }
      const res = await fetch("/api/admin/quotas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { quotas?: Quotas; error?: string };
      if (!res.ok || !j.quotas) throw new Error(j.error ?? `Erreur ${res.status}`);
      setQuotas(j.quotas);
      setMsg({ text: "Quotas enregistrés.", tone: "ok" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Enregistrement impossible.", tone: "error" });
    } finally { setSaving(false); }
  }

  const field = (key: keyof Quotas, label: string, hint: string, unit: string) => (
    <label className="flex flex-col gap-1 text-xs text-gray-400">
      <span className="text-gray-300">{label}</span>
      <span className="flex items-center gap-1.5"><input value={draft?.[key] ?? ""} onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))} inputMode="decimal" className={inputCls} /> <span className="text-gray-500">{unit}</span></span>
      <span className="text-[11px] text-gray-500">{hint}</span>
    </label>
  );

  const bar = (value: number, cap: number) => {
    const pct = cap > 0 ? Math.min(100, (value / cap) * 100) : 0;
    const tone = cap > 0 && pct >= (quotas?.warnAtPct ?? 80) ? (pct >= 100 ? "bg-rose-500" : "bg-amber-400") : "bg-violet-500";
    return <span className="block h-1.5 w-40 rounded-full bg-gray-800 overflow-hidden"><span className={`block h-full ${tone}`} style={{ width: `${cap > 0 ? pct : 0}%` }} /></span>;
  };

  return (
    <Section title="Quotas IA & génération" action={<button type="button" onClick={() => void save()} disabled={saving || !draft} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Enregistrer</button>}>
      <div className="p-4 space-y-4">
        {!compact && <p className="text-xs text-gray-400">Chaque génération d&apos;image ou de vidéo rappelle son prix et ce qui a déjà été dépensé dans la journée (jour de Paris) ; au-delà d&apos;un plafond, la génération est refusée jusqu&apos;au lendemain. 0 = pas de plafond.</p>}
        {today && quotas && (
          <div className="grid gap-3 sm:grid-cols-2 text-xs">
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 space-y-1">
              <div className="text-gray-400">Équipe aujourd&apos;hui</div>
              <div className="text-white text-sm">{usd(today.team.usd)}{quotas.teamDailyUsd > 0 ? ` / ${usd(quotas.teamDailyUsd)}` : ""} · {today.team.images} image{today.team.images > 1 ? "s" : ""}{quotas.teamDailyImages > 0 ? ` / ${quotas.teamDailyImages}` : ""}</div>
              {bar(today.team.usd, quotas.teamDailyUsd)}
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 space-y-1">
              <div className="text-gray-400">Toi aujourd&apos;hui</div>
              <div className="text-white text-sm">{usd(today.user.usd)}{quotas.userDailyUsd > 0 ? ` / ${usd(quotas.userDailyUsd)}` : ""} · {today.user.images} image{today.user.images > 1 ? "s" : ""}</div>
              {bar(today.user.usd, quotas.userDailyUsd)}
            </div>
          </div>
        )}
        {draft ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {field("teamDailyUsd", "Plafond équipe par jour", "Images et vidéos générées par toute l'équipe (prix catalogue fal.ai / Agnes).", "$ / jour")}
            {field("userDailyUsd", "Plafond par consultant par jour", "Chaque consultant, sur ses propres générations.", "$ / jour")}
            {field("teamDailyImages", "Images par jour (équipe)", "Nombre de visuels, gratuits compris.", "images / jour")}
            {field("botDailyMessages", "Messages par jour et par bot client", "Valeur par défaut ; chaque bot peut avoir la sienne (fiche du bot). 0 = illimité.", "messages / jour")}
            {field("warnAtPct", "Avertir à partir de", "Le rappel de prix passe en orange à ce pourcentage du plafond.", "% du plafond")}
          </div>
        ) : <p className="text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement…</p>}
        {msg && <p className={`text-xs ${msg.tone === "ok" ? "text-emerald-300" : "text-rose-300"}`}>{msg.text}</p>}
      </div>
    </Section>
  );
}
