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

export function CoverSlide({ data }: { data: DeckData }) {
  return (
    <SlideShell dark>
      <div className="flex flex-col items-center justify-center h-full text-center gap-[3%]">
        <div
          className="text-[5%] font-extrabold tracking-wide uppercase"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif", color: "#2CA6F9" }}
        >
          Monthly Business Review
        </div>
        <div
          className="text-[3.5%] font-extrabold"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          {data.client.name}
        </div>
        <div className="text-[2%] opacity-80">{data.period.label}</div>
        <div
          className="mt-[2%] w-[30%] h-[2px]"
          style={{ backgroundColor: "#2CA6F9" }}
        />
        <div className="text-[1.4%] opacity-60 mt-[1%]">
          Prepared by Impulse Analytics
        </div>
      </div>
    </SlideShell>
  );
}

// ── 2. Agenda Slide ──────────────────────────────────────────────────────────

export function AgendaSlide({ data }: { data: DeckData }) {
  const sections = [
    { num: "01", title: "Global Overview", sub: "Highlights · Tableau Global · NC/CP-NC" },
    { num: "02", title: "Focus Google Ads", sub: "Vue globale · Campagnes · Brand Search · Pmax" },
    { num: "03", title: "Focus Meta Ads", sub: "Vue globale · Campagnes · Top Créas · Learnings" },
    { num: "04", title: "Next Steps & Budget", sub: "Actions · Budget mensuel" },
  ];
  return (
    <SlideShell accent="blue" slideNumber={2}>
      <div>
        <h2
          className="text-[3%] font-extrabold mb-[1%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          Agenda
        </h2>
        <div className="w-full h-[1px] mb-[3%]" style={{ backgroundColor: colors.caption }} />
        <div className="grid grid-cols-2 gap-[3%]">
          {sections.map((s) => (
            <div key={s.num} className="flex gap-[8%] items-start">
              <span
                className="text-[4%] font-black"
                style={{ color: colors.violet, fontFamily: "'Mulish', 'Arial Black', sans-serif" }}
              >
                {s.num}
              </span>
              <div>
                <div className="text-[2%] font-bold" style={{ color: colors.blueDeep }}>
                  {s.title}
                </div>
                <div className="text-[1.4%]" style={{ color: colors.caption }}>
                  {s.sub}
                </div>
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
      <div className="flex flex-col items-center justify-center h-full text-center gap-[2%]">
        <span
          className="text-[6%] font-black"
          style={{ color: "#2CA6F9", fontFamily: "'Mulish', 'Arial Black', sans-serif" }}
        >
          {sectionNumber}
        </span>
        <div
          className="text-[4%] font-extrabold"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          {onEdit ? (
            <EditableText
              field="title"
              slideIndex={slideNumber ?? 0}
              currentValue={actualTitle}
              onEdit={onEdit}
            >
              {actualTitle}
            </EditableText>
          ) : (
            actualTitle
          )}
        </div>
        {actualSubtitle && (
          <div className="text-[1.8%] opacity-70">
            {onEdit ? (
              <EditableText
                field="subtitle"
                slideIndex={slideNumber ?? 0}
                currentValue={actualSubtitle}
                onEdit={onEdit}
              >
                {actualSubtitle}
              </EditableText>
            ) : (
              actualSubtitle
            )}
          </div>
        )}
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
          className="text-[2.8%] font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          Highlights du mois
        </h2>
        <div className="w-full h-[1px] mb-[3%]" style={{ backgroundColor: colors.caption }} />
        <div className="grid grid-cols-2 gap-[2.5%]">
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
      className="rounded-[8px] p-[8%] flex flex-col gap-[6%]"
      style={{ backgroundColor: colors.bgAlt }}
    >
      <div className="text-[1.6%] font-bold" style={{ color: colors.blueDeep }}>
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
      <div className="flex items-baseline gap-[6%]">
        <span
          className="text-[3.5%] font-black"
          style={{ fontFamily: "'Mulish', 'Arial Black', sans-serif", color: colors.text }}
        >
          {highlight.value}
        </span>
        {highlight.delta != null && (
          <span className="text-[1.6%]">
            <DeltaBadge value={highlight.delta} invert={highlight.icon === "cpa"} />
          </span>
        )}
      </div>
      <div className="text-[1.2%]" style={{ color: "#555" }}>
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
  );
}

// ── 5. Global Table (10 columns) ─────────────────────────────────────────────

export function GlobalTableSlide({ data, slideNumber }: { data: DeckData; slideNumber?: number }) {
  const cols: { label: string; key: keyof import("@/lib/deck-data").PlatformMetrics; fmt: (n: number) => string; invert?: boolean }[] = [
    { label: "Spend", key: "spend", fmt: fmtCur },
    { label: "Impr.", key: "impressions", fmt: fmtK },
    { label: "Clicks", key: "clicks", fmt: fmtK },
    { label: "Conv.", key: "conversions", fmt: (n) => String(Math.round(n)) },
    { label: "Revenue", key: "revenue", fmt: fmtCur },
    { label: "CPM", key: "cpm", fmt: (n) => fmtCur(n) },
    { label: "CTR", key: "ctr", fmt: fmtPct },
    { label: "CPC", key: "cpc", fmt: (n) => "€" + fmtDec(n) },
    { label: "CPA", key: "cpa", fmt: (n) => "€" + fmtDec(n), invert: true },
    { label: "ROAS", key: "roas", fmt: (n) => fmtDec(n) + "×" },
  ];

  return (
    <SlideShell accent="blue" slideNumber={slideNumber}>
      <div>
        <h2
          className="text-[2.8%] font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          Vue Globale — Performance par Plateforme
        </h2>
        <div className="text-[1.4%] mb-[1%]" style={{ color: colors.caption }}>
          {data.period.label} vs {data.previousPeriod.label}
        </div>
        <div className="w-full h-[1px] mb-[2%]" style={{ backgroundColor: colors.caption }} />

        <table className="w-full text-[1.2%] border-collapse">
          <thead>
            <tr style={{ backgroundColor: colors.blueHeader, color: "#fff" }}>
              <th className="text-left px-[1%] py-[0.8%] font-semibold">Platform</th>
              {cols.map((c) => (
                <th key={c.key} className="text-right px-[0.8%] py-[0.8%] font-semibold">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.globalTable.map((row, idx) => (
              <PlatformTableRow key={row.platform} row={row} cols={cols} isTotal={row.platform === "Total"} odd={idx % 2 === 1} />
            ))}
          </tbody>
        </table>
      </div>
    </SlideShell>
  );
}

function PlatformTableRow({
  row,
  cols,
  isTotal,
  odd,
}: {
  row: PlatformRow;
  cols: { key: keyof import("@/lib/deck-data").PlatformMetrics; fmt: (n: number) => string; invert?: boolean }[];
  isTotal: boolean;
  odd: boolean;
}) {
  const bg = isTotal ? colors.bgAlt : odd ? colors.bgRow : "#fff";
  const textColor = isTotal ? colors.blueDeep : colors.text;
  const weight = isTotal ? 700 : 400;

  return (
    <>
      <tr style={{ backgroundColor: bg, color: textColor, fontWeight: weight }}>
        <td className="px-[1%] py-[0.6%]">{row.platform}</td>
        {cols.map((c) => (
          <td key={c.key} className="text-right px-[0.8%] py-[0.6%]">
            {c.fmt(row.current[c.key])}
          </td>
        ))}
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

export function NCSlide({ data, slideNumber }: { data: DeckData; slideNumber?: number }) {
  return (
    <SlideShell accent="blue" slideNumber={slideNumber}>
      <div>
        <h2
          className="text-[2.8%] font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          Nouveaux Clients — NC / CP-NC / %NC
        </h2>
        <div className="w-full h-[1px] mb-[2%]" style={{ backgroundColor: colors.caption }} />

        <table className="w-full text-[1.4%] border-collapse">
          <thead>
            <tr style={{ backgroundColor: colors.blueHeader, color: "#fff" }}>
              <th className="text-left px-[1.5%] py-[1%] font-semibold">Platform</th>
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
              return (
                <tr key={row.platform} style={{ backgroundColor: bg, fontWeight: isTotal ? 700 : 400, color: isTotal ? colors.blueDeep : colors.text }}>
                  <td className="px-[1.5%] py-[0.8%]">{row.platform}</td>
                  <td className="text-right px-[1.5%] py-[0.8%]">{row.current.newClients}</td>
                  <td className="text-right px-[1.5%] py-[0.8%]"><DeltaBadge value={row.delta.newClients} /></td>
                  <td className="text-right px-[1.5%] py-[0.8%]">€{fmtDec(row.current.cpNc)}</td>
                  <td className="text-right px-[1.5%] py-[0.8%]"><DeltaBadge value={row.delta.cpNc} invert /></td>
                  <td className="text-right px-[1.5%] py-[0.8%]">{fmtPct(row.current.percentNc)}</td>
                  <td className="text-right px-[1.5%] py-[0.8%]"><DeltaBadge value={row.delta.percentNc} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
}: {
  title: string;
  campaigns: CampaignRow[];
  accent?: "blue" | "violet";
  slideNumber?: number;
  periodLabel?: string;
}) {
  return (
    <SlideShell accent={accent} slideNumber={slideNumber}>
      <div>
        <h2
          className="text-[2.8%] font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          {title}
        </h2>
        {periodLabel && (
          <div className="text-[1.4%] mb-[1%]" style={{ color: colors.caption }}>{periodLabel}</div>
        )}
        <div className="w-full h-[1px] mb-[2%]" style={{ backgroundColor: colors.caption }} />

        <table className="w-full text-[1.1%] border-collapse">
          <thead>
            <tr style={{ backgroundColor: colors.blueHeader, color: "#fff" }}>
              <th className="text-left px-[0.8%] py-[0.6%] font-semibold">Campaign</th>
              <th className="text-center px-[0.5%] py-[0.6%] font-semibold">Status</th>
              <th className="text-right px-[0.5%] py-[0.6%] font-semibold">Spend</th>
              <th className="text-right px-[0.5%] py-[0.6%] font-semibold">Impr.</th>
              <th className="text-right px-[0.5%] py-[0.6%] font-semibold">Clicks</th>
              <th className="text-right px-[0.5%] py-[0.6%] font-semibold">Conv.</th>
              <th className="text-right px-[0.5%] py-[0.6%] font-semibold">CPA</th>
              <th className="text-right px-[0.5%] py-[0.6%] font-semibold">ROAS</th>
              <th className="text-right px-[0.5%] py-[0.6%] font-semibold">Δ ROAS</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c, idx) => (
              <tr key={c.id} style={{ backgroundColor: idx % 2 === 1 ? colors.bgRow : "#fff" }}>
                <td className="px-[0.8%] py-[0.5%] font-medium">{c.name}</td>
                <td className="text-center px-[0.5%] py-[0.5%]">
                  <span
                    className="inline-block px-[4px] py-[1px] rounded text-[0.9%] font-semibold"
                    style={{
                      backgroundColor: c.status === "Active" ? "#E8F5E9" : "#FFF3E0",
                      color: c.status === "Active" ? colors.deltaPos : "#E65100",
                    }}
                  >
                    {c.status}
                  </span>
                </td>
                <td className="text-right px-[0.5%] py-[0.5%]">{fmtCur(c.current.spend)}</td>
                <td className="text-right px-[0.5%] py-[0.5%]">{fmtK(c.current.impressions)}</td>
                <td className="text-right px-[0.5%] py-[0.5%]">{fmtK(c.current.clicks)}</td>
                <td className="text-right px-[0.5%] py-[0.5%]">{Math.round(c.current.conversions)}</td>
                <td className="text-right px-[0.5%] py-[0.5%]">€{fmtDec(c.current.cpa)}</td>
                <td className="text-right px-[0.5%] py-[0.5%] font-bold">{fmtDec(c.current.roas)}×</td>
                <td className="text-right px-[0.5%] py-[0.5%]">
                  <DeltaBadge value={c.delta.roas} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
          className="text-[2.8%] font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          Top Créatives — Performance
        </h2>
        <div className="w-full h-[1px] mb-[2%]" style={{ backgroundColor: colors.caption }} />

        <div className="grid grid-cols-3 gap-[2%]">
          {creatives.slice(0, 6).map((c) => (
            <div
              key={c.id}
              className="rounded-[8px] overflow-hidden"
              style={{ backgroundColor: colors.bgAlt }}
            >
              {/* Thumbnail placeholder */}
              <div
                className="w-full aspect-[16/10] flex items-center justify-center"
                style={{ backgroundColor: "#E0E7FF" }}
              >
                {c.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.thumbnailUrl} alt={c.name} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[1.4%] font-semibold" style={{ color: colors.violet }}>
                    {c.format}
                  </span>
                )}
              </div>
              <div className="p-[6%]">
                <div className="text-[1.2%] font-bold truncate mb-[4%]">{c.name}</div>
                <div className="grid grid-cols-2 gap-[4%] text-[1%]">
                  <div>
                    <span style={{ color: colors.caption }}>Spend</span>
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
          className="text-[2.8%] font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          Learnings
        </h2>
        <div className="w-full h-[1px] mb-[3%]" style={{ backgroundColor: colors.caption }} />

        <div className="rounded-[12px] p-[4%]" style={{ backgroundColor: colors.blueDeep }}>
          <div className="text-[1.4%] font-bold mb-[2%]" style={{ color: colors.blueSignature }}>
            // LEARNINGS
          </div>
          <ul className="space-y-[2%]">
            {learnings.map((l, i) => {
              const field = `learning${i}`;
              const actualValue = getOverride?.(slideNumber ?? 0, field) ?? l;
              return (
                <li key={i} className="flex gap-[2%] text-[1.3%] text-white">
                  <span style={{ color: colors.blueSignature }} className="font-bold flex-shrink-0">
                    {String(i + 1).padStart(2, "0")}.
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
                </li>
              );
            })}
          </ul>
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
          className="text-[2.8%] font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          {title}
        </h2>
        <div className="w-full h-[1px] mb-[3%]" style={{ backgroundColor: colors.caption }} />

        <div className="space-y-[2.5%]">
          {steps.map((s, i) => {
            const field = `step${i}`;
            const actualValue = getOverride?.(slideNumber ?? 0, field) ?? s;
            return (
              <div
                key={i}
                className="flex gap-[2%] items-start rounded-[8px] p-[2.5%]"
                style={{ backgroundColor: i % 2 === 0 ? colors.bgAlt : "#fff" }}
              >
                <span
                  className="text-[2.5%] font-black flex-shrink-0"
                  style={{ color: accent === "violet" ? colors.violet : colors.blueSignature, fontFamily: "'Mulish', 'Arial Black', sans-serif" }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-[1.4%] pt-[0.4%]">
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
}: {
  budget: BudgetLine[];
  period: string;
  slideNumber?: number;
}) {
  return (
    <SlideShell accent="blue" slideNumber={slideNumber}>
      <div>
        <h2
          className="text-[2.8%] font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          Budget — {period}
        </h2>
        <div className="w-full h-[1px] mb-[2%]" style={{ backgroundColor: colors.caption }} />

        <table className="w-full text-[1.4%] border-collapse">
          <thead>
            <tr style={{ backgroundColor: colors.blueHeader, color: "#fff" }}>
              <th className="text-left px-[2%] py-[1%] font-semibold">Platform</th>
              <th className="text-right px-[2%] py-[1%] font-semibold">Budget prévu</th>
              <th className="text-right px-[2%] py-[1%] font-semibold">Dépensé</th>
              <th className="text-right px-[2%] py-[1%] font-semibold">Écart</th>
            </tr>
          </thead>
          <tbody>
            {budget.map((b, idx) => {
              const isTotal = b.platform === "Total";
              return (
                <tr
                  key={b.platform}
                  style={{
                    backgroundColor: isTotal ? colors.bgAlt : idx % 2 === 1 ? colors.bgRow : "#fff",
                    fontWeight: isTotal ? 700 : 400,
                    color: isTotal ? colors.blueDeep : colors.text,
                  }}
                >
                  <td className="px-[2%] py-[0.8%]">{b.platform}</td>
                  <td className="text-right px-[2%] py-[0.8%]">{fmtCur(b.planned)}</td>
                  <td className="text-right px-[2%] py-[0.8%]">{fmtCur(b.actual)}</td>
                  <td className="text-right px-[2%] py-[0.8%]">
                    <DeltaBadge value={b.variance} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Budget bar chart */}
        <div className="mt-[4%] flex gap-[3%]">
          {budget.filter((b) => b.platform !== "Total").map((b) => (
            <div key={b.platform} className="flex-1">
              <div className="text-[1.2%] font-semibold mb-[1%]" style={{ color: colors.blueDeep }}>
                {b.platform}
              </div>
              <div className="h-[8px] w-full rounded-full overflow-hidden" style={{ backgroundColor: colors.bgRow }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (b.actual / b.planned) * 100)}%`,
                    backgroundColor: b.platform === "Meta" ? colors.violet : colors.blueSignature,
                  }}
                />
              </div>
              <div className="flex justify-between text-[1%] mt-[0.5%]" style={{ color: colors.caption }}>
                <span>{fmtCur(b.actual)}</span>
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
}: {
  title: string;
  metrics: import("@/lib/deck-data").PlatformMetrics;
  accent?: "blue" | "violet";
  slideNumber?: number;
}) {
  const kpis = [
    { label: "Spend", value: fmtCur(metrics.spend) },
    { label: "Impressions", value: fmtK(metrics.impressions) },
    { label: "Clicks", value: fmtK(metrics.clicks) },
    { label: "Conversions", value: String(Math.round(metrics.conversions)) },
    { label: "Revenue", value: fmtCur(metrics.revenue) },
    { label: "ROAS", value: fmtDec(metrics.roas) + "×" },
    { label: "CPA", value: "€" + fmtDec(metrics.cpa) },
    { label: "CTR", value: fmtPct(metrics.ctr) },
  ];

  const accentColor = accent === "violet" ? colors.violet : colors.blueSignature;

  return (
    <SlideShell accent={accent} slideNumber={slideNumber}>
      <div>
        <h2
          className="text-[2.8%] font-extrabold mb-[0.5%]"
          style={{ fontFamily: "'Raleway', 'Trebuchet MS', sans-serif" }}
        >
          {title}
        </h2>
        <div className="w-full h-[1px] mb-[3%]" style={{ backgroundColor: colors.caption }} />

        <div className="grid grid-cols-4 gap-[2%]">
          {kpis.map((k) => (
            <div key={k.label} className="rounded-[8px] p-[5%] text-center" style={{ backgroundColor: colors.bgAlt }}>
              <div className="text-[1.2%] mb-[4%]" style={{ color: colors.caption }}>
                {k.label}
              </div>
              <div
                className="text-[2.8%] font-black"
                style={{ fontFamily: "'Mulish', 'Arial Black', sans-serif", color: accentColor }}
              >
                {k.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </SlideShell>
  );
}
