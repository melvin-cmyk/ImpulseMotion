"use client";

import { SlideShell } from "./slide-shell";
import { EditableText } from "./editable-text";
import type {
  DeckData,
  PlatformRow,
  NCRow,
  CampaignRow,
  DeckHighlight,
  TopCreative,
  BudgetLine,
} from "@/lib/deck-data";

// ── Types pour l'édition inline ──────────────────────────────────────────────

interface EditCallbacks {
  onEdit?: (field: string, slideIndex: number, newValue: string) => void;
  getOverride?: (slideIndex: number, field: string) => string | undefined;
}

// ── Design tokens ────────────────────────────────────────────────────────────

const colors = {
  blueDeep: "#0944A1",
  blueSignature: "#2CA6F9",
  blueHeader: "#0070C0",
  violet: "#7F5AFD",
  violetAlt: "#4F6EFF",
  deltaPos: "#0B8043",
  deltaNeg: "#C53929",
  bgAlt: "#F2F9FE",
  bgRow: "#F3F3F3",
  caption: "#CCCCCC",
  text: "#000000",
};

// ── Font sizes — use max() to guarantee readable minimums ────────────────────
// % = relative to slide width, px = absolute minimum on small screens
const fs = {
  title: "max(3.5%, 22px)",      // Slide titles
  subtitle: "max(2.2%, 14px)",    // Subtitles, section headers
  body: "max(2%, 13px)",          // Table cells, bullet points
  bodyLg: "max(2.2%, 14px)",      // Table headers, KPI labels
  kpiValue: "max(4%, 22px)",      // KPI numbers
  kpiLabel: "max(2%, 12px)",      // KPI labels
  small: "max(1.6%, 10px)",       // Captions, deltas, status badges
  cover: "max(5.5%, 32px)",       // Cover client name
  coverSub: "max(2.5%, 16px)",    // Cover subtitle
  section: "max(4%, 24px)",       // Section divider text
  sectionHeader: "max(2.2%, 14px)", // // LEARNINGS, // NEXT STEPS
  agendaTitle: "max(2.2%, 14px)", // Agenda bar titles
  agendaBody: "max(2%, 12px)",    // Agenda bullet points
  highlight: "max(4%, 22px)",     // Highlight card values
  highlightTitle: "max(2.2%, 14px)", // Highlight card titles
  highlightDesc: "max(1.8%, 11px)", // Highlight card descriptions
  bgNumber: "max(8%, 48px)",      // Background numbers on highlight cards
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtCur(n: number) {
  return "€" + n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtDec(n: number, d = 2) {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(n: number) {
  return fmtDec(n, 1) + "%";
}
function fmtK(n: number) {
  if (n >= 1_000_000) return fmtDec(n / 1_000_000, 1) + "M";
  if (n >= 1_000) return fmtDec(n / 1_000, 1) + "k";
  return String(n);
}

function DeltaBadge({ value, invert }: { value: number; invert?: boolean }) {
  if (value === 999) return <span style={{ color: colors.caption, fontWeight: 600, fontSize: "inherit" }}>N/A</span>;
  const positive = invert ? value < 0 : value > 0;
  const color = positive ? colors.deltaPos : value === 0 ? colors.caption : colors.deltaNeg;
  const arrow = value > 0 ? "+" : "";
  return (
    <span style={{ color, fontWeight: 600, fontSize: "inherit" }}>
      {arrow}{fmtDec(value, 1)}%
    </span>
  );
}

// ── 1. Cover Slide ───────────────────────────────────────────────────────────

export function CoverSlide({ data, slideNumber, onEdit, getOverride }: { data: DeckData; slideNumber?: number } & EditCallbacks) {
  const sn = slideNumber ?? 0;
  const rawName = data.client.name;
  // Strip account ID suffix like "Bazile (5221764839)"
  const clientName = getOverride?.(sn, "clientName") ?? rawName.replace(/\s*\(\d+\)\s*$/, "");
  const period = getOverride?.(sn, "period") ?? data.period.label;
  const subtitle = getOverride?.(sn, "subtitle") ?? "Préparé par Impulse Analytics";
  return (
    <SlideShell dark slideNumber={slideNumber}>
      <div className="flex flex-col items-center justify-center h-full text-center">
        {/* Title block */}
        <div className="flex flex-col items-center gap-[2%]">
          <div
            className="font-bold tracking-[0.2em] uppercase opacity-80"
            style={{ fontFamily: "'Open Sans', Calibri, sans-serif", fontSize: fs.coverSub }}
          >
            Monthly Business Review
          </div>
          <div className="text-[2%] opacity-60">Media</div>
          <div
            className="font-extrabold mt-[2%]"
            style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", fontSize: fs.cover }}
          >
            {onEdit ? <EditableText field="clientName" slideIndex={sn} currentValue={clientName} onEdit={onEdit}>{clientName}</EditableText> : clientName}
          </div>
          <div className="text-[2.2%] italic opacity-80 mt-[1%]">
            {onEdit ? <EditableText field="period" slideIndex={sn} currentValue={period} onEdit={onEdit}>{period}</EditableText> : period}
          </div>
        </div>

        {/* Bottom branding */}
        <div className="absolute bottom-[6%] left-0 right-0 flex items-end justify-between px-[5%]">
          <div>
            <div className="text-[2%] font-extrabold" style={{ color: "#fff" }}>
              Impulse Analytics.
            </div>
            <div className="text-[1.1%] italic opacity-60">Growing Faster</div>
          </div>
          <div className="text-[1%] opacity-50">
            {onEdit ? <EditableText field="subtitle" slideIndex={sn} currentValue={subtitle} onEdit={onEdit}>{subtitle}</EditableText> : subtitle}
          </div>
        </div>
      </div>
    </SlideShell>
  );
}

// ── 2. Agenda Slide ──────────────────────────────────────────────────────────

export function AgendaSlide({ data }: { data: DeckData }) {
  // Use client account config, not spend, to determine active platforms
  // (spend can be 0 on first render before data loads)
  const platform = data.client.platform;
  const hasGoogle = !!(data.client.googleCustomerId || platform === "google" || platform === "both");
  const hasMeta = !!(data.client.metaAccountId || platform === "meta" || platform === "both")
    || (!hasGoogle && !data.client.metaAccountId && !data.client.googleCustomerId); // fallback: assume Meta if nothing set
  let sectionNum = 1;
  const sections = [
    { num: String(sectionNum++).padStart(2, "0"), title: "Vue Globale", sub: "Highlights · Tableau Global · NC/CP-NC" },
    ...(hasGoogle ? [{ num: String(sectionNum++).padStart(2, "0"), title: "Focus Google Ads", sub: "Vue globale · Campagnes · Brand Search · Pmax" }] : []),
    ...(hasMeta ? [{ num: String(sectionNum++).padStart(2, "0"), title: "Focus Meta Ads", sub: "Vue globale · Campagnes · Top Créas · Points Clés" }] : []),
    { num: String(sectionNum++).padStart(2, "0"), title: "Prochaines Étapes & Budget", sub: "Actions prioritaires · Budget mensuel" },
  ];
  const barColors = ["#2CA6F9", "#1a8fd4", "#0944A1", "#7F5AFD"];
  return (
    <SlideShell accent="blue" slideNumber={2}>
      <div>
        <h2
          className="text-[3.2%] font-extrabold mb-[3%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature }}
        >
          Agenda du jour
        </h2>
        <div className="flex flex-col gap-[5%] mt-[4%]">
          {sections.map((s, i) => (
            <div key={s.num} className="flex items-center gap-[2%]">
              {/* Number circle */}
              <div
                className="flex-shrink-0 w-[7%] aspect-square rounded-full flex items-center justify-center border-2"
                style={{ borderColor: barColors[i % barColors.length], color: barColors[i % barColors.length] }}
              >
                <span className="text-[2.5%] font-bold">{parseInt(s.num)}</span>
              </div>
              {/* Colored bar with title */}
              <div
                className="flex-shrink-0 rounded-lg px-[3%] py-[2.5%]"
                style={{ backgroundColor: barColors[i % barColors.length], minWidth: "32%" }}
              >
                <span className="text-[2.2%] font-bold text-white uppercase tracking-wider">
                  {s.title}
                </span>
              </div>
              {/* Description box */}
              <div
                className="flex-1 rounded-lg px-[3%] py-[2%]"
                style={{ backgroundColor: "#F3F4F6" }}
              >
                <ul style={{ color: "#333", fontSize: fs.agendaBody }}>
                  {s.sub.split(" · ").map((item, j) => (
                    <li key={j} className="flex items-start gap-[1%]">
                      <span style={{ color: "#333" }}>&#8226;</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SlideShell>
  );
}

// ── 3. Section Divider ───────────────────────────────────────────────────────

export function SectionDividerSlide({
  sectionNumber,
  title,
  subtitle,
  slideNumber,
  onEdit,
  getOverride,
}: {
  sectionNumber: string;
  title: string;
  subtitle?: string;
  slideNumber?: number;
} & EditCallbacks) {
  const actualTitle = getOverride?.(slideNumber ?? 0, "title") ?? title;
  const actualSubtitle = getOverride?.(slideNumber ?? 0, "subtitle") ?? subtitle;

  return (
    <SlideShell dark slideNumber={slideNumber}>
      <div className="flex items-center justify-center h-full">
        {/* White rounded box centered */}
        <div
          className="bg-white rounded-2xl px-[10%] py-[5%] flex items-center justify-center gap-[2%] shadow-lg"
          style={{ minWidth: "45%" }}
        >
          <span
            className="font-extrabold"
            style={{ color: "#000", fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", fontSize: fs.section }}
          >
            {onEdit ? (
              <EditableText field="title" slideIndex={slideNumber ?? 0} currentValue={`${sectionNumber} - ${actualTitle}`} onEdit={onEdit}>
                {sectionNumber} - {actualTitle}
              </EditableText>
            ) : (
              <>{sectionNumber} - {actualTitle}</>
            )}
          </span>
        </div>
      </div>
    </SlideShell>
  );
}

// ── 4. Highlights (4 cards) ──────────────────────────────────────────────────

export function HighlightsSlide({
  data,
  slideNumber,
  onEdit,
  getOverride,
}: {
  data: DeckData;
  slideNumber?: number;
} & EditCallbacks) {
  return (
    <SlideShell accent="blue" slideNumber={slideNumber}>
      <div>
        <h2
          className="font-extrabold mb-[3%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature, fontSize: fs.title }}
        >
          Elements cles du mois
        </h2>
        <div className="grid grid-cols-2 gap-[3%]">
          {data.highlights.map((h, i) => (
            <HighlightCard
              key={i}
              highlight={h}
              index={i}
              slideNumber={slideNumber ?? 0}
              onEdit={onEdit}
              getOverride={getOverride}
            />
          ))}
        </div>
      </div>
    </SlideShell>
  );
}

function HighlightCard({
  highlight,
  index,
  slideNumber,
  onEdit,
  getOverride,
}: {
  highlight: DeckHighlight;
  index: number;
  slideNumber: number;
} & EditCallbacks) {
  const titleField = `highlight${index}_title`;
  const descField = `highlight${index}_description`;
  const actualTitle = getOverride?.(slideNumber, titleField) ?? highlight.title;
  const actualDesc = getOverride?.(slideNumber, descField) ?? highlight.description;

  return (
    <div
      className="relative rounded-xl p-[6%] flex flex-col justify-center min-h-[40%]"
      style={{ backgroundColor: "#F3F4F6" }}
    >
      {/* Large background number */}
      <span
        className="absolute top-[4%] left-[6%] font-black leading-none"
        style={{ color: "#D1D5DB", fontFamily: "'Raleway', sans-serif", fontSize: fs.bgNumber }}
      >
        {index + 1}
      </span>
      <div className="relative mt-[3%] text-center">
        <div className="font-bold leading-snug" style={{ color: "#111", fontSize: fs.highlightTitle }}>
          {onEdit ? (
            <EditableText
              field={titleField}
              slideIndex={slideNumber}
              currentValue={actualTitle}
              onEdit={onEdit}
            >
              {actualTitle}
            </EditableText>
          ) : (
            actualTitle
          )}
        </div>
        <div className="flex items-center justify-center gap-[4%] mt-[4%]">
          <span
            className="font-black"
            style={{ fontFamily: "'Raleway', sans-serif", color: colors.text, fontSize: fs.highlight }}
          >
            {highlight.value}
          </span>
          {highlight.delta != null && (
            <span className="text-[2%]">
              <DeltaBadge value={highlight.delta} invert={highlight.icon === "cpa"} />
            </span>
          )}
        </div>
        <div className="text-[2%] mt-[3%]" style={{ color: "#555" }}>
          {onEdit ? (
            <EditableText
              field={descField}
              slideIndex={slideNumber}
              currentValue={actualDesc}
              onEdit={onEdit}
            >
              {actualDesc}
            </EditableText>
          ) : (
            actualDesc
          )}
        </div>
      </div>
    </div>
  );
}

// ── 5. Global Table (10 columns) ─────────────────────────────────────────────

export function GlobalTableSlide({ data, slideNumber, onEdit, getOverride }: { data: DeckData; slideNumber?: number } & EditCallbacks) {
  const sn = slideNumber ?? 0;
  const cols: { label: string; key: keyof import("@/lib/deck-data").PlatformMetrics; fmt: (n: number) => string; invert?: boolean }[] = [
    { label: "Dépense", key: "spend", fmt: fmtCur },
    { label: "Impr.", key: "impressions", fmt: fmtK },
    { label: "Clics", key: "clicks", fmt: fmtK },
    { label: "Conv.", key: "conversions", fmt: (n) => String(Math.round(n)) },
    { label: "Revenu", key: "revenue", fmt: fmtCur },
    { label: "CPM", key: "cpm", fmt: (n) => fmtCur(n) },
    { label: "CTR", key: "ctr", fmt: fmtPct },
    { label: "CPC", key: "cpc", fmt: (n) => "€" + fmtDec(n) },
    { label: "CPA", key: "cpa", fmt: (n) => "€" + fmtDec(n), invert: true },
    { label: "ROAS", key: "roas", fmt: (n) => fmtDec(n) + "×" },
  ];

  const title = getOverride?.(sn, "title") ?? "Vue Globale — Performance par Plateforme";
  const periodStr = getOverride?.(sn, "period") ?? `${data.period.label} vs ${data.previousPeriod.label}`;

  return (
    <SlideShell accent="blue" slideNumber={slideNumber}>
      <div>
        <h2
          className="font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature, fontSize: fs.title }}
        >
          {onEdit ? <EditableText field="title" slideIndex={sn} currentValue={title} onEdit={onEdit}>{title}</EditableText> : title}
        </h2>
        <div className="mb-[1.5%]" style={{ color: colors.caption, fontSize: fs.small }}>
          {onEdit ? <EditableText field="period" slideIndex={sn} currentValue={periodStr} onEdit={onEdit}>{periodStr}</EditableText> : periodStr}
        </div>

        <table className="w-full border-collapse" style={{ fontSize: fs.body }}>
          <thead>
            <tr style={{ backgroundColor: colors.blueHeader, color: "#fff" }}>
              <th className="text-left px-[1.2%] py-[1.2%] font-semibold">Plateforme</th>
              {cols.map((c) => (
                <th key={c.key} className="text-right px-[1%] py-[1.2%] font-semibold">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.globalTable.map((row, idx) => (
              <PlatformTableRow key={row.platform} row={row} cols={cols} isTotal={row.platform === "Total"} odd={idx % 2 === 1} rowIdx={idx} slideIndex={sn} onEdit={onEdit} getOverride={getOverride} />
            ))}
          </tbody>
        </table>

        {/* // OVERVIEW section */}
        <div className="mt-[4%]">
          <div className="font-bold" style={{ color: colors.blueDeep, fontSize: fs.sectionHeader }}>
            // OVERVIEW
          </div>
          <div className="w-[15%] h-[3px] mt-[0.5%] mb-[2%]" style={{ backgroundColor: colors.blueSignature }} />
          <ul className="space-y-[1%]" style={{ fontSize: fs.body }}>
            {data.globalTable.filter(r => r.platform !== "Total").map((row) => (
              <li key={row.platform} className="flex gap-[1.5%]" style={{ color: "#333" }}>
                <span className="font-bold flex-shrink-0" style={{ color: colors.blueDeep }}>&#8226;</span>
                <span>
                  <strong>{row.platform}</strong> : {fmtCur(row.current.spend)} investis
                  {row.current.revenue > 0 && <> pour {fmtCur(row.current.revenue)} de revenus</>}
                  {row.current.roas > 0 && <> — ROAS {fmtDec(row.current.roas)}x</>}
                  {row.current.conversions > 0 && <> ({Math.round(row.current.conversions)} conversions)</>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </SlideShell>
  );
}

function PlatformTableRow({
  row,
  cols,
  isTotal,
  odd,
  rowIdx,
  slideIndex,
  onEdit,
  getOverride,
}: {
  row: PlatformRow;
  cols: { key: keyof import("@/lib/deck-data").PlatformMetrics; fmt: (n: number) => string; invert?: boolean }[];
  isTotal: boolean;
  odd: boolean;
  rowIdx: number;
  slideIndex: number;
} & EditCallbacks) {
  const bg = isTotal ? colors.bgAlt : odd ? colors.bgRow : "#fff";
  const textColor = isTotal ? colors.blueDeep : colors.text;
  const weight = isTotal ? 700 : 400;

  return (
    <>
      <tr style={{ backgroundColor: bg, color: textColor, fontWeight: weight }}>
        <td className="px-[1.2%] py-[1%]">
          {onEdit ? (
            <EditableText field={`row${rowIdx}.platform`} slideIndex={slideIndex} currentValue={getOverride?.(slideIndex, `row${rowIdx}.platform`) ?? row.platform} onEdit={onEdit}>
              {getOverride?.(slideIndex, `row${rowIdx}.platform`) ?? row.platform}
            </EditableText>
          ) : row.platform}
        </td>
        {cols.map((c) => {
          const field = `row${rowIdx}.${c.key}`;
          const formatted = c.fmt(row.current[c.key]);
          const override = getOverride?.(slideIndex, field);
          return (
            <td key={c.key} className="text-right px-[1%] py-[1%]">
              {onEdit ? (
                <EditableText field={field} slideIndex={slideIndex} currentValue={override ?? formatted} onEdit={onEdit}>
                  {override ?? formatted}
                </EditableText>
              ) : formatted}
            </td>
          );
        })}
      </tr>
      <tr style={{ backgroundColor: bg }}>
        <td className="px-[1%] pb-[0.6%] text-[1%]" style={{ color: colors.caption }}>
          Delta
        </td>
        {cols.map((c) => (
          <td key={c.key} className="text-right px-[0.8%] pb-[0.6%] text-[1%]">
            <DeltaBadge value={row.delta[c.key]} invert={c.invert} />
          </td>
        ))}
      </tr>
    </>
  );
}

// ── 6. NC / CP-NC Slide ──────────────────────────────────────────────────────

export function NCSlide({ data, slideNumber, onEdit, getOverride }: { data: DeckData; slideNumber?: number } & EditCallbacks) {
  const sn = slideNumber ?? 0;
  const title = getOverride?.(sn, "title") ?? "Nouveaux Clients — NC / CP-NC / %NC";
  return (
    <SlideShell accent="blue" slideNumber={slideNumber}>
      <div>
        <h2
          className="font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature, fontSize: fs.title }}
        >
          {onEdit ? <EditableText field="title" slideIndex={sn} currentValue={title} onEdit={onEdit}>{title}</EditableText> : title}
        </h2>
        <div className="w-full h-[1px] mb-[2%]" style={{ backgroundColor: colors.caption }} />

        <table className="w-full border-collapse" style={{ fontSize: fs.body }}>
          <thead>
            <tr style={{ backgroundColor: colors.blueHeader, color: "#fff" }}>
              <th className="text-left px-[1.5%] py-[1%] font-semibold">Plateforme</th>
              <th className="text-right px-[1.5%] py-[1%] font-semibold">NC</th>
              <th className="text-right px-[1.5%] py-[1%] font-semibold">Delta</th>
              <th className="text-right px-[1.5%] py-[1%] font-semibold">CP-NC</th>
              <th className="text-right px-[1.5%] py-[1%] font-semibold">Delta</th>
              <th className="text-right px-[1.5%] py-[1%] font-semibold">%NC</th>
              <th className="text-right px-[1.5%] py-[1%] font-semibold">Delta</th>
            </tr>
          </thead>
          <tbody>
            {data.ncTable.map((row, idx) => {
              const isTotal = row.platform === "Total";
              const bg = isTotal ? colors.bgAlt : idx % 2 === 1 ? colors.bgRow : "#fff";
              const nc = getOverride?.(sn, `nc${idx}.nc`) ?? String(row.current.newClients);
              const cpnc = getOverride?.(sn, `nc${idx}.cpnc`) ?? `€${fmtDec(row.current.cpNc)}`;
              const pnc = getOverride?.(sn, `nc${idx}.pnc`) ?? fmtPct(row.current.percentNc);
              return (
                <tr key={row.platform} style={{ backgroundColor: bg, fontWeight: isTotal ? 700 : 400, color: isTotal ? colors.blueDeep : colors.text }}>
                  <td className="px-[2%] py-[2%]">{row.platform}</td>
                  <td className="text-right px-[2%] py-[2%]">{onEdit ? <EditableText field={`nc${idx}.nc`} slideIndex={sn} currentValue={nc} onEdit={onEdit}>{nc}</EditableText> : nc}</td>
                  <td className="text-right px-[2%] py-[2%]"><DeltaBadge value={row.delta.newClients} /></td>
                  <td className="text-right px-[2%] py-[2%]">{onEdit ? <EditableText field={`nc${idx}.cpnc`} slideIndex={sn} currentValue={cpnc} onEdit={onEdit}>{cpnc}</EditableText> : cpnc}</td>
                  <td className="text-right px-[2%] py-[2%]"><DeltaBadge value={row.delta.cpNc} invert /></td>
                  <td className="text-right px-[2%] py-[2%]">{onEdit ? <EditableText field={`nc${idx}.pnc`} slideIndex={sn} currentValue={pnc} onEdit={onEdit}>{pnc}</EditableText> : pnc}</td>
                  <td className="text-right px-[2%] py-[2%]"><DeltaBadge value={row.delta.percentNc} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* // OVERVIEW section */}
        <div className="mt-[4%]">
          <div className="font-bold" style={{ color: colors.blueDeep, fontSize: fs.sectionHeader }}>
            // OVERVIEW
          </div>
          <div className="w-[15%] h-[3px] mt-[0.5%] mb-[2%]" style={{ backgroundColor: colors.blueSignature }} />
          <ul className="space-y-[1.5%]" style={{ fontSize: fs.body }}>
            {data.ncTable.filter(r => r.platform !== "Total").map((row) => {
              const ncDelta = row.delta.newClients !== 999 ? ` (${row.delta.newClients > 0 ? "+" : ""}${fmtDec(row.delta.newClients, 1)}%)` : "";
              return (
                <li key={row.platform} className="flex gap-[1.5%]" style={{ color: "#333" }}>
                  <span className="font-bold flex-shrink-0" style={{ color: colors.blueDeep }}>&#8226;</span>
                  <span>
                    <strong>{row.platform}</strong> : {row.current.newClients} nouveaux clients{ncDelta},
                    CP-NC {fmtCur(Math.round(row.current.cpNc))}, %NC {fmtPct(row.current.percentNc)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </SlideShell>
  );
}

// ── 7. Campaign Table (Google or Meta) ───────────────────────────────────────

export function CampaignTableSlide({
  title,
  campaigns,
  accent = "blue",
  slideNumber,
  periodLabel,
  onEdit,
  getOverride,
}: {
  title: string;
  campaigns: CampaignRow[];
  accent?: "blue" | "violet";
  slideNumber?: number;
  periodLabel?: string;
} & EditCallbacks) {
  const sn = slideNumber ?? 0;
  const actualTitle = getOverride?.(sn, "title") ?? title;
  return (
    <SlideShell accent={accent} slideNumber={slideNumber}>
      <div>
        <h2
          className="font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature, fontSize: fs.title }}
        >
          {onEdit ? <EditableText field="title" slideIndex={sn} currentValue={actualTitle} onEdit={onEdit}>{actualTitle}</EditableText> : actualTitle}
        </h2>
        {periodLabel && (
          <div className="mb-[1%]" style={{ color: colors.caption, fontSize: fs.small }}>{periodLabel}</div>
        )}
        <div className="w-full h-[1px] mb-[2%]" style={{ backgroundColor: colors.caption }} />

        {campaigns.length === 0 ? (
          <div className="flex items-center justify-center py-[4%] text-[2%]" style={{ color: colors.caption }}>
            Aucune campagne disponible pour cette période.
          </div>
        ) : (
        <table className="w-full border-collapse" style={{ fontSize: fs.body }}>
          <thead>
            <tr style={{ backgroundColor: colors.blueHeader, color: "#fff" }}>
              <th className="text-left px-[1%] py-[1.2%] font-semibold">Campagne</th>
              <th className="text-center px-[0.5%] py-[1.2%] font-semibold">Statut</th>
              <th className="text-right px-[0.8%] py-[1.2%] font-semibold">Depense</th>
              <th className="text-right px-[0.8%] py-[1.2%] font-semibold">Impr.</th>
              <th className="text-right px-[0.8%] py-[1.2%] font-semibold">Clics</th>
              <th className="text-right px-[0.8%] py-[1.2%] font-semibold">Conv.</th>
              <th className="text-right px-[0.8%] py-[1.2%] font-semibold">CPA</th>
              <th className="text-right px-[0.8%] py-[1.2%] font-semibold">ROAS</th>
              <th className="text-right px-[0.8%] py-[1.2%] font-semibold">Delta</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c, idx) => {
              const campaignName = getOverride?.(sn, `c${idx}.name`) ?? c.name;
              const campaignSpend = getOverride?.(sn, `c${idx}.spend`) ?? fmtCur(c.current.spend);
              const campaignRoas = getOverride?.(sn, `c${idx}.roas`) ?? `${fmtDec(c.current.roas)}×`;
              return (
              <tr key={c.id} style={{ backgroundColor: idx % 2 === 1 ? colors.bgRow : "#fff" }}>
                <td className="px-[1%] py-[1.5%] font-medium">{onEdit ? <EditableText field={`c${idx}.name`} slideIndex={sn} currentValue={campaignName} onEdit={onEdit}>{campaignName}</EditableText> : campaignName}</td>
                <td className="text-center px-[0.5%] py-[1%]">
                  <span
                    className="inline-block px-[6px] py-[2px] rounded font-semibold"
                    style={{
                      fontSize: fs.small,
                      backgroundColor: c.status === "Active" ? "#E8F5E9" : "#FFF3E0",
                      color: c.status === "Active" ? colors.deltaPos : "#E65100",
                    }}
                  >
                    {c.status === "Active" ? "Actif" : c.status === "Paused" ? "En pause" : c.status}
                  </span>
                </td>
                <td className="text-right px-[0.5%] py-[0.5%]">{onEdit ? <EditableText field={`c${idx}.spend`} slideIndex={sn} currentValue={campaignSpend} onEdit={onEdit}>{campaignSpend}</EditableText> : campaignSpend}</td>
                <td className="text-right px-[0.5%] py-[0.5%]">{fmtK(c.current.impressions)}</td>
                <td className="text-right px-[0.5%] py-[0.5%]">{fmtK(c.current.clicks)}</td>
                <td className="text-right px-[0.5%] py-[0.5%]">{Math.round(c.current.conversions)}</td>
                <td className="text-right px-[0.5%] py-[0.5%]">€{fmtDec(c.current.cpa)}</td>
                <td className="text-right px-[0.5%] py-[0.5%] font-bold">{onEdit ? <EditableText field={`c${idx}.roas`} slideIndex={sn} currentValue={campaignRoas} onEdit={onEdit}>{campaignRoas}</EditableText> : campaignRoas}</td>
                <td className="text-right px-[0.5%] py-[0.5%]">
                  <DeltaBadge value={c.delta.roas} />
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </div>
    </SlideShell>
  );
}

// ── 8. Top Creatives ─────────────────────────────────────────────────────────

export function TopCreativesSlide({
  creatives,
  slideNumber,
}: {
  creatives: TopCreative[];
  slideNumber?: number;
}) {
  return (
    <SlideShell accent="violet" slideNumber={slideNumber}>
      <div>
        <h2
          className="font-extrabold mb-[2%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature, fontSize: fs.title }}
        >
          Top Performers creatives
        </h2>

        <div className="grid grid-cols-3 gap-[3%]">
          {creatives.slice(0, 3).map((c) => (
            <div
              key={c.id}
              className="rounded-lg overflow-hidden border"
              style={{ backgroundColor: "#fff", borderColor: "#E8EDF3" }}
            >
              {/* Thumbnail */}
              <div
                className="w-full aspect-[4/3] flex items-center justify-center relative overflow-hidden"
                style={{ backgroundColor: "#F5F7FA" }}
              >
                {c.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/deck/proxy-image?url=${encodeURIComponent(c.thumbnailUrl)}`}
                    alt={c.name}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      const target = e.currentTarget;
                      target.style.display = "none";
                      const fallback = target.nextElementSibling as HTMLElement;
                      if (fallback) fallback.style.display = "flex";
                    }}
                  />
                ) : null}
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-[4%]"
                  style={{ display: c.thumbnailUrl ? "none" : "flex" }}
                >
                  <span className="font-semibold text-center px-[8%]" style={{ color: colors.violet, fontSize: fs.body }}>
                    {c.format}
                  </span>
                </div>
              </div>
              <div className="p-[4%]">
                <div className="font-bold mb-[2%] line-clamp-2" style={{ fontSize: fs.small, lineHeight: 1.3 }}>{c.name}</div>
                <div className="grid grid-cols-2 gap-[3%]" style={{ fontSize: fs.small }}>
                  <div>
                    <span style={{ color: colors.caption }}>Dépense</span>
                    <div className="font-semibold">{fmtCur(c.spend)}</div>
                  </div>
                  <div>
                    <span style={{ color: colors.caption }}>ROAS</span>
                    <div className="font-bold" style={{ color: colors.blueDeep }}>{fmtDec(c.roas)}×</div>
                  </div>
                  <div>
                    <span style={{ color: colors.caption }}>CTR</span>
                    <div>{fmtPct(c.ctr)}</div>
                  </div>
                  <div>
                    <span style={{ color: colors.caption }}>CPA</span>
                    <div>€{fmtDec(c.cpa)}</div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SlideShell>
  );
}

// ── 9. Learnings Block ───────────────────────────────────────────────────────

export function LearningsSlide({
  learnings,
  slideNumber,
  accent = "blue",
  onEdit,
  getOverride,
}: {
  learnings: string[];
  slideNumber?: number;
  accent?: "blue" | "violet";
} & EditCallbacks) {
  return (
    <SlideShell accent={accent} slideNumber={slideNumber}>
      <div>
        <h2
          className="font-extrabold mb-[2%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature, fontSize: fs.title }}
        >
          Points Cles
        </h2>

        {/* // LEARNINGS section header */}
        <div className="mb-[3%]">
          <div className="font-bold" style={{ color: colors.blueDeep, fontSize: fs.sectionHeader }}>
            // LEARNINGS
          </div>
          <div className="w-[15%] h-[3px] mt-[0.5%]" style={{ backgroundColor: colors.blueSignature }} />
        </div>

        <div className="space-y-[3%]">
          {learnings.map((l, i) => {
            const field = `learning${i}`;
            const actualValue = getOverride?.(slideNumber ?? 0, field) ?? l;
            return (
              <div key={i} className="flex gap-[2%] rounded-lg p-[2%]" style={{ color: "#333", fontSize: fs.body, backgroundColor: i % 2 === 0 ? "#F5F7FA" : "#fff", border: "1px solid #E8EDF3" }}>
                <span style={{ color: colors.blueDeep }} className="font-bold flex-shrink-0">
                  &#8226;
                </span>
                <span>
                  {onEdit ? (
                    <EditableText
                      field={field}
                      slideIndex={slideNumber ?? 0}
                      currentValue={actualValue}
                      onEdit={onEdit}
                    >
                      {actualValue}
                    </EditableText>
                  ) : (
                    actualValue
                  )}
                </span>
              </div>
              );
            })}
          </div>
      </div>
    </SlideShell>
  );
}

// ── 10. Next Steps ───────────────────────────────────────────────────────────

export function NextStepsSlide({
  title,
  steps,
  accent = "blue",
  slideNumber,
  onEdit,
  getOverride,
}: {
  title: string;
  steps: string[];
  accent?: "blue" | "violet";
  slideNumber?: number;
} & EditCallbacks) {
  return (
    <SlideShell accent={accent} slideNumber={slideNumber}>
      <div>
        <h2
          className="font-extrabold mb-[2%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature, fontSize: fs.title }}
        >
          {title}
        </h2>

        {/* // NEXT STEPS section header */}
        <div className="mb-[3%]">
          <div className="font-bold" style={{ color: colors.blueDeep, fontSize: fs.sectionHeader }}>
            // NEXT STEPS
          </div>
          <div className="w-[15%] h-[3px] mt-[0.5%]" style={{ backgroundColor: colors.blueSignature }} />
        </div>

        <div className="space-y-[3%]">
          {steps.map((s, i) => {
            const field = `step${i}`;
            const actualValue = getOverride?.(slideNumber ?? 0, field) ?? s;
            return (
              <div
                key={i}
                className="flex gap-[2%] items-start rounded-lg p-[2%]"
                style={{ color: "#333", fontSize: fs.body, backgroundColor: "#EFF6FF", borderLeft: `4px solid ${colors.blueSignature}` }}
              >
                <span className="font-bold flex-shrink-0" style={{ color: colors.blueSignature }}>
                  &#8594;
                </span>
                <span>
                  {onEdit ? (
                    <EditableText
                      field={field}
                      slideIndex={slideNumber ?? 0}
                      currentValue={actualValue}
                      onEdit={onEdit}
                    >
                      {actualValue}
                    </EditableText>
                  ) : (
                    actualValue
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </SlideShell>
  );
}

// ── 11. Budget Slide ─────────────────────────────────────────────────────────

export function BudgetSlide({
  budget,
  period,
  slideNumber,
  onEdit,
  getOverride,
}: {
  budget: BudgetLine[];
  period: string;
  slideNumber?: number;
} & EditCallbacks) {
  const sn = slideNumber ?? 0;
  const titlePeriod = getOverride?.(sn, "period") ?? period;
  return (
    <SlideShell accent="blue" slideNumber={slideNumber}>
      <div>
        <h2
          className="font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature, fontSize: fs.title }}
        >
          Budget — {onEdit ? <EditableText field="period" slideIndex={sn} currentValue={titlePeriod} onEdit={onEdit}>{titlePeriod}</EditableText> : titlePeriod}
        </h2>
        <div className="w-full h-[1px] mb-[2%]" style={{ backgroundColor: colors.caption }} />

        <table className="w-full border-collapse" style={{ fontSize: fs.body }}>
          <thead>
            <tr style={{ backgroundColor: colors.blueHeader, color: "#fff" }}>
              <th className="text-left px-[2%] py-[1%] font-semibold">Plateforme</th>
              <th className="text-right px-[2%] py-[1%] font-semibold">Budget prévu</th>
              <th className="text-right px-[2%] py-[1%] font-semibold">Dépensé</th>
              <th className="text-right px-[2%] py-[1%] font-semibold">Écart</th>
            </tr>
          </thead>
          <tbody>
            {budget.map((b, idx) => {
              const isTotal = b.platform === "Total";
              const planned = getOverride?.(sn, `b${idx}.planned`) ?? fmtCur(b.planned);
              const actual = getOverride?.(sn, `b${idx}.actual`) ?? fmtCur(b.actual);
              return (
                <tr
                  key={b.platform}
                  style={{
                    backgroundColor: isTotal ? colors.bgAlt : idx % 2 === 1 ? colors.bgRow : "#fff",
                    fontWeight: isTotal ? 700 : 400,
                    color: isTotal ? colors.blueDeep : colors.text,
                  }}
                >
                  <td className="px-[2%] py-[1.5%]">{b.platform}</td>
                  <td className="text-right px-[2%] py-[1.5%]">{onEdit ? <EditableText field={`b${idx}.planned`} slideIndex={sn} currentValue={planned} onEdit={onEdit}>{planned}</EditableText> : planned}</td>
                  <td className="text-right px-[2%] py-[1.5%]">{onEdit ? <EditableText field={`b${idx}.actual`} slideIndex={sn} currentValue={actual} onEdit={onEdit}>{actual}</EditableText> : actual}</td>
                  <td className="text-right px-[2%] py-[1.5%]">
                    <DeltaBadge value={b.variance} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Budget bar chart */}
        <div className="mt-[4%] flex gap-[4%]">
          {budget.filter((b) => b.platform !== "Total").map((b) => (
            <div key={b.platform} className="flex-1 rounded-lg p-[3%]" style={{ backgroundColor: "#F5F7FA", border: "1px solid #E8EDF3" }}>
              <div className="font-semibold mb-[2%]" style={{ color: colors.blueDeep, fontSize: fs.body }}>
                {b.platform}
              </div>
              <div className="h-[14px] w-full rounded-full overflow-hidden" style={{ backgroundColor: "#E5E7EB" }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (b.actual / b.planned) * 100)}%`,
                    backgroundColor: b.platform === "Meta" ? colors.violet : colors.blueSignature,
                  }}
                />
              </div>
              <div className="flex justify-between mt-[2%]" style={{ color: "#555", fontSize: fs.small }}>
                <span className="font-semibold">{fmtCur(b.actual)}</span>
                <span>/ {fmtCur(b.planned)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SlideShell>
  );
}

// ── 12. KPI Overview (Google or Meta) ────────────────────────────────────────

export function KPIOverviewSlide({
  title,
  metrics,
  accent = "blue",
  slideNumber,
  onEdit,
  getOverride,
}: {
  title: string;
  metrics: import("@/lib/deck-data").PlatformMetrics;
  accent?: "blue" | "violet";
  slideNumber?: number;
} & EditCallbacks) {
  const sn = slideNumber ?? 0;
  const kpis = [
    { label: "Dépense", key: "spend", value: fmtCur(metrics.spend) },
    { label: "Impressions", key: "impressions", value: fmtK(metrics.impressions) },
    { label: "Clics", key: "clicks", value: fmtK(metrics.clicks) },
    { label: "Conversions", key: "conversions", value: String(Math.round(metrics.conversions)) },
    { label: "Revenus", key: "revenue", value: fmtCur(metrics.revenue) },
    { label: "ROAS", key: "roas", value: fmtDec(metrics.roas) + "×" },
    { label: "CPA", key: "cpa", value: "€" + fmtDec(metrics.cpa) },
    { label: "CTR", key: "ctr", value: fmtPct(metrics.ctr) },
  ];

  const accentColor = accent === "violet" ? colors.violet : colors.blueSignature;
  const actualTitle = getOverride?.(sn, "title") ?? title;

  return (
    <SlideShell accent={accent} slideNumber={slideNumber}>
      <div>
        <h2
          className="font-extrabold mb-[1%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: colors.blueSignature, fontSize: fs.title }}
        >
          {onEdit ? <EditableText field="title" slideIndex={sn} currentValue={actualTitle} onEdit={onEdit}>{actualTitle}</EditableText> : actualTitle}
        </h2>

        {/* KPI BUSINESS badge */}
        <div className="flex justify-center mb-[2%]">
          <span
            className="text-[1.2%] font-bold uppercase tracking-wider px-[2%] py-[0.5%] rounded-full text-white"
            style={{ backgroundColor: accentColor }}
          >
            KPI Business
          </span>
        </div>

        {/* Row 1: first 4 KPIs */}
        <div className="grid grid-cols-4 gap-[2%] mb-[4%]">
          {kpis.slice(0, 4).map((k) => {
            const override = getOverride?.(sn, `kpi.${k.key}`) ?? k.value;
            return (
            <div key={k.label} className="text-center py-[4%] rounded-lg" style={{ backgroundColor: "#F5F7FA", border: "1px solid #E8EDF3" }}>
              <div className="font-semibold uppercase tracking-wider mb-[2%]" style={{ color: "#8A9BB5", fontSize: fs.kpiLabel }}>
                {k.label}
              </div>
              <div
                className="font-extrabold"
                style={{ fontFamily: "'Raleway', sans-serif", color: colors.blueDeep, fontSize: fs.kpiValue }}
              >
                {onEdit ? <EditableText field={`kpi.${k.key}`} slideIndex={sn} currentValue={override} onEdit={onEdit}>{override}</EditableText> : override}
              </div>
            </div>
            );
          })}
        </div>

        {/* Row 2: remaining KPIs */}
        {kpis.length > 4 && (
          <div className="grid grid-cols-4 gap-[2%]">
            {kpis.slice(4).map((k) => {
              const override = getOverride?.(sn, `kpi.${k.key}`) ?? k.value;
              return (
              <div key={k.label} className="text-center py-[4%] rounded-lg" style={{ backgroundColor: "#F5F7FA", border: "1px solid #E8EDF3" }}>
                <div className="font-semibold uppercase tracking-wider mb-[2%]" style={{ color: "#8A9BB5", fontSize: fs.kpiLabel }}>
                  {k.label}
                </div>
                <div
                  className="font-extrabold"
                  style={{ fontFamily: "'Raleway', sans-serif", color: colors.blueDeep, fontSize: fs.kpiValue }}
                >
                  {onEdit ? <EditableText field={`kpi.${k.key}`} slideIndex={sn} currentValue={override} onEdit={onEdit}>{override}</EditableText> : override}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </SlideShell>
  );
}
