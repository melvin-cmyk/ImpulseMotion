"use client";

/**
 * Public, read-only rendering of a snapshot (Motion's shared Snapshot): the
 * same report layout — title, period, numbered metrics, cards of the ticked
 * rows, table with the account average — frozen at the share date.
 */

import { useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import type { SnapshotPayload } from "@/lib/ads-warehouse/snapshots";
import type { MetricKey } from "@/lib/ads-warehouse/query";
import { METRIC_BY_KEY } from "@/lib/ads-warehouse/metrics-ui";
import { AdCard } from "./ad-card";
import { AdsTable, RANK_SWATCH } from "./ads-table";

const fmt = (d: string) => new Date(d.length === 10 ? d + "T00:00:00Z" : d).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

interface Props { title: string; emoji: string; description: string; clientName: string; createdAt: string; createdByName: string; payload: SnapshotPayload }

export function SnapshotView({ title, emoji, description, clientName, createdAt, createdByName, payload }: Props) {
  const [sort, setSort] = useState<{ key: MetricKey | "name" | "adCount" | "launch"; dir: "asc" | "desc" }>({ key: payload.metrics[0] ?? "spend", dir: "desc" });
  const rows = useMemo(() => {
    const out = [...payload.rows];
    const k = sort.key;
    const sign = sort.dir === "asc" ? 1 : -1;
    out.sort((a, b) => (k === "launch" ? (a.launch ?? "").localeCompare(b.launch ?? "") : k === "name" ? a.label.localeCompare(b.label) : k === "adCount" ? a.adCount - b.adCount : (a.metrics[k as MetricKey] ?? 0) - (b.metrics[k as MetricKey] ?? 0)) * sign);
    return out;
  }, [payload.rows, sort]);
  const cards = new Set(payload.cardKeys);
  const cardRows = payload.rows.filter((r) => cards.has(r.key));
  const groupNoun = payload.groupBy === "ad" ? { one: "annonce", many: "annonces" } : { one: "groupe", many: "groupes" };
  const noop = () => undefined;

  return (
    <div className="min-h-screen bg-ui-bg text-ui-fg">
      <header className="h-14 border-b border-ui-line flex items-center gap-3 px-5">
        <span className="w-7 h-7 rounded-lg bg-ui-accent text-ui-on-accent text-sm font-medium flex items-center justify-center">I</span>
        <span className="text-sm font-medium text-ui-fg">ImpulseMotion</span>
        <span className="ml-auto text-xs text-ui-muted">Snapshot figé le {fmt(createdAt)}{createdByName ? ` par ${createdByName}` : ""}</span>
      </header>
      <main className="mx-auto w-full max-w-[1040px] px-6 pt-14 pb-16">
        <h1 className="text-[28px] leading-9 font-medium text-ui-fg">{emoji} {title}</h1>
        {description && <p className="mt-1 text-base text-ui-fg2">{description}</p>}
        {clientName && <p className="mt-1 text-sm text-ui-muted">{clientName}</p>}
        <div className="mt-10 flex items-center gap-2 flex-wrap">
          <span className="h-8 inline-flex items-center gap-1.5 rounded-[10px] border border-ui-line bg-ui-card px-2.5 text-sm font-medium"><CalendarDays className="w-4 h-4 text-ui-fg2" />{fmt(payload.range.since)} – {fmt(payload.range.until)}{payload.compare && <span className="text-ui-muted font-normal">vs période précédente</span>}</span>
        </div>

        <section className="mt-6 rounded-xl border border-ui-line bg-ui-card p-4">
          <div className="flex items-center gap-2 flex-wrap">
            {payload.metrics.map((k, i) => (
              <span key={k} className="h-8 inline-flex items-center gap-1.5 rounded-[10px] border border-ui-line bg-ui-card pl-1.5 pr-2.5 text-sm font-medium">
                <span className={`w-[18px] h-[18px] rounded-[5px] text-[11px] font-medium flex items-center justify-center ${RANK_SWATCH[i % RANK_SWATCH.length]}`}>{i + 1}</span>{METRIC_BY_KEY[k]?.label ?? k}
              </span>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {cardRows.map((r) => <AdCard key={r.key} row={r} metrics={payload.metrics} benchmark={payload.benchmark} currency={payload.currency} compare={!!payload.compare} ratio={payload.ratio} onOpen={noop} />)}
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-ui-line bg-ui-card overflow-hidden">
          <div className="p-4 border-b border-ui-line text-xs text-ui-muted">{payload.total} {payload.total > 1 ? groupNoun.many : groupNoun.one}{payload.rows.length < payload.total ? ` · ${payload.rows.length} premiers` : ""}</div>
          <AdsTable rows={rows} columns={payload.columns.length ? payload.columns : payload.metrics} chartMetrics={payload.metrics} onToggleChartMetric={noop} benchmark={payload.benchmark} benchmarkPrevious={payload.benchmarkPrevious} currency={payload.currency} compare={!!payload.compare}
            sort={sort} onSort={(key) => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }))} selected={cards} onSelect={noop} onSelectAll={noop} onOpen={noop} groupNoun={groupNoun} />
        </section>
        <p className="mt-6 text-center text-xs text-ui-muted">Rapport partagé en lecture seule depuis ImpulseMotion · chiffres au {fmt(payload.range.until)}</p>
      </main>
    </div>
  );
}
