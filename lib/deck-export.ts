/**
 * Export DeckData (from the /deck page) directly to PPTX
 * using pptxgenjs with the Impulse Analytics design system.
 */

import type { DeckData, PlatformMetrics, PlatformRow, CampaignRow, TopCreative, BudgetLine } from "./deck-data";
import { IA, FONTS, SIZES, LAYOUT } from "./impulse-theme";

const c = (hex: string) => hex.replace("#", "");

function fmtCur(n: number) {
  return "€" + n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtDec(n: number, d = 2) {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(n: number) { return fmtDec(n, 1) + "%"; }
function fmtK(n: number) {
  if (n >= 1_000_000) return fmtDec(n / 1_000_000, 1) + "M";
  if (n >= 1_000) return fmtDec(n / 1_000, 1) + "k";
  return String(n);
}
function deltaStr(v: number) { return (v > 0 ? "+" : "") + fmtDec(v, 1) + "%"; }
function deltaColor(v: number, invert = false) {
  const positive = invert ? v < 0 : v > 0;
  return positive ? c(IA.deltaPos) : v === 0 ? c(IA.textCaption) : c(IA.deltaNeg);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PptxSlide = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PptxGen = any;

function addFooter(slide: PptxSlide, isDark: boolean) {
  slide.addText("Impulse Analytics.", {
    x: LAYOUT.marginX, y: LAYOUT.footerY, w: 3, h: 0.3,
    fontSize: SIZES.caption, bold: true, color: c(IA.blue), fontFace: FONTS.body,
  });
  slide.addText("Source: Meta Ads / Google Ads", {
    x: LAYOUT.width - 3.5, y: LAYOUT.footerY, w: 3, h: 0.3,
    fontSize: SIZES.caption, italic: true, color: c(IA.textCaption),
    fontFace: FONTS.body, align: "right",
  });
}

function addBar(slide: PptxSlide, color: string) {
  slide.addShape("rect", {
    x: 0, y: 0, w: LAYOUT.barWidth, h: LAYOUT.height,
    fill: { color: c(color) }, line: { width: 0 },
  });
}

function addHeader(slide: PptxSlide, title: string) {
  slide.addText(title, {
    x: LAYOUT.marginX + 0.3, y: 0.25, w: 11, h: 0.6,
    fontSize: SIZES.titleMain, bold: true, color: c(IA.textBlack), fontFace: FONTS.title,
  });
  slide.addShape("rect", {
    x: LAYOUT.marginX + 0.3, y: 0.9, w: 12, h: 0.015,
    fill: { color: c(IA.textCaption) }, line: { width: 0 },
  });
}

// ── Slide builders ──────────────────────────────────────────────────────────

function addCover(pptx: PptxGen, data: DeckData) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgDark) };
  addBar(s, IA.blue);
  addFooter(s, true);
  s.addText("Monthly Business Review", {
    x: 1, y: 1.5, w: 11, h: 1, fontSize: 14, bold: true,
    color: c(IA.blue), fontFace: FONTS.body, align: "center",
  });
  s.addText(data.client.name, {
    x: 1, y: 2.5, w: 11, h: 1.5, fontSize: 36, bold: true,
    color: c(IA.textWhite), fontFace: FONTS.title, align: "center",
  });
  s.addText(data.period.label, {
    x: 1, y: 4.2, w: 11, h: 0.8, fontSize: 18,
    color: c(IA.textWhite), fontFace: FONTS.body, align: "center",
  });
  s.addShape("rect", {
    x: 5, y: 5.2, w: 3.33, h: 0.03,
    fill: { color: c(IA.blue) }, line: { width: 0 },
  });
  s.addText("Prepared by Impulse Analytics", {
    x: 1, y: 5.6, w: 11, h: 0.5, fontSize: 10, italic: true,
    color: c(IA.textCaption), fontFace: FONTS.body, align: "center",
  });
}

function addAgenda(pptx: PptxGen, data: DeckData) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, IA.blue);
  addFooter(s, false);
  s.addText("Agenda", {
    x: LAYOUT.marginX + 0.3, y: 0.4, w: 10, h: 0.8,
    fontSize: 30, bold: true, color: c(IA.textBlack), fontFace: FONTS.title,
  });
  const items = [
    "Global Overview — Highlights · Tableau Global · NC/CP-NC",
    "Focus Google Ads — Vue globale · Campagnes · Brand Search · Pmax",
    "Focus Meta Ads — Vue globale · Campagnes · Top Créas · Learnings",
    "Next Steps & Budget — Actions · Budget mensuel",
  ];
  items.forEach((item, i) => {
    const y = 1.8 + i * 1.1;
    s.addText(`0${i + 1}`, {
      x: LAYOUT.marginX + 0.3, y, w: 0.6, h: 0.6,
      fontSize: 20, bold: true, color: c(IA.violet), fontFace: FONTS.kpi, align: "center",
    });
    s.addText(item, {
      x: LAYOUT.marginX + 1.2, y: y + 0.05, w: 10, h: 0.5,
      fontSize: SIZES.subtitle, color: c(IA.textBlack), fontFace: FONTS.body,
    });
    if (i < items.length - 1) {
      s.addShape("rect", {
        x: LAYOUT.marginX + 0.3, y: y + 0.75, w: 11, h: 0.01,
        fill: { color: c(IA.bgRowAlt) }, line: { width: 0 },
      });
    }
  });
}

function addSectionDivider(pptx: PptxGen, num: string, title: string, subtitle: string, barColor: string) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgDark) };
  addBar(s, barColor);
  addFooter(s, true);
  s.addText(num, {
    x: LAYOUT.marginX + 0.3, y: 2.0, w: 3, h: 1,
    fontSize: 64, bold: true, color: c(IA.blue), fontFace: FONTS.kpi,
  });
  s.addText(title, {
    x: LAYOUT.marginX + 0.3, y: 3.5, w: 10, h: 1,
    fontSize: 32, bold: true, color: c(IA.textWhite), fontFace: FONTS.title,
  });
  s.addText(subtitle, {
    x: LAYOUT.marginX + 0.3, y: 4.5, w: 10, h: 0.6,
    fontSize: 14, color: c(IA.textCaption), fontFace: FONTS.body,
  });
}

function addHighlights(pptx: PptxGen, data: DeckData) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, IA.blue);
  addFooter(s, false);
  addHeader(s, "Highlights du mois");

  const cards = data.highlights;
  const cardW = 2.8;
  const gap = 0.3;
  const startX = (LAYOUT.width - (cards.length * cardW + (cards.length - 1) * gap)) / 2;

  cards.forEach((h, i) => {
    const x = startX + i * (cardW + gap);
    const y = LAYOUT.contentY + 0.3;
    s.addShape("roundRect", {
      x, y, w: cardW, h: 3.5,
      fill: { color: c(IA.bgAlt) }, line: { width: 0 }, rectRadius: 0.1,
    });
    s.addText(h.title, {
      x, y: y + 0.3, w: cardW, h: 0.4,
      fontSize: SIZES.body, color: c(IA.textBlack), fontFace: FONTS.body, align: "center", bold: true,
    });
    s.addText(h.value, {
      x, y: y + 1.0, w: cardW, h: 1,
      fontSize: SIZES.kpi, bold: true, color: c(IA.blue), fontFace: FONTS.kpi, align: "center",
    });
    if (h.delta != null) {
      s.addText(deltaStr(h.delta), {
        x, y: y + 2.2, w: cardW, h: 0.5,
        fontSize: 14, bold: true,
        color: deltaColor(h.delta, h.icon === "cpa"),
        fontFace: FONTS.body, align: "center",
      });
    }
    s.addText(h.description, {
      x: x + 0.2, y: y + 2.7, w: cardW - 0.4, h: 0.7,
      fontSize: 7, color: c(IA.textCaption), fontFace: FONTS.body, align: "center",
    });
  });
}

function addGlobalTable(pptx: PptxGen, data: DeckData) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, IA.blue);
  addFooter(s, false);
  addHeader(s, "Vue Globale — Performance par Plateforme");
  s.addText(`${data.period.label} vs ${data.previousPeriod.label}`, {
    x: LAYOUT.marginX + 0.3, y: 0.92, w: 11, h: 0.3,
    fontSize: 9, italic: true, color: c(IA.textCaption), fontFace: FONTS.body,
  });

  const cols = ["Platform", "Spend", "Impr.", "Clicks", "Conv.", "Revenue", "CPM", "CTR", "CPC", "CPA", "ROAS"];
  const fmtFns: ((r: PlatformRow) => string)[] = [
    (r) => r.platform,
    (r) => fmtCur(r.current.spend),
    (r) => fmtK(r.current.impressions),
    (r) => fmtK(r.current.clicks),
    (r) => String(Math.round(r.current.conversions)),
    (r) => fmtCur(r.current.revenue),
    (r) => fmtCur(r.current.cpm),
    (r) => fmtPct(r.current.ctr),
    (r) => "€" + fmtDec(r.current.cpc),
    (r) => "€" + fmtDec(r.current.cpa),
    (r) => fmtDec(r.current.roas) + "×",
  ];

  const headerRow = cols.map((h) => ({
    text: h,
    options: {
      bold: true, color: c(IA.textWhite), fill: { color: c(IA.tableHeader) },
      fontSize: 8, fontFace: FONTS.body, align: "center" as const,
    },
  }));

  const dataRows = data.globalTable.map((row, idx) => {
    const isTotal = row.platform === "Total";
    return fmtFns.map((fn) => ({
      text: fn(row),
      options: {
        color: isTotal ? c(IA.blueDark) : c(IA.textBlack),
        bold: isTotal,
        fill: isTotal ? { color: c(IA.bgAlt) } : idx % 2 === 1 ? { color: c(IA.bgRowAlt) } : { color: c(IA.bgWhite) },
        fontSize: 8, fontFace: FONTS.body, align: "center" as const,
      },
    }));
  });

  const colW = 12 / cols.length;
  s.addTable([headerRow, ...dataRows], {
    x: LAYOUT.marginX + 0.2, y: LAYOUT.contentY + 0.3,
    w: cols.length * colW,
    colW: Array(cols.length).fill(colW),
    rowH: 0.35,
    border: { type: "solid", pt: 0.5, color: c(IA.bgRowAlt) },
  });
}

function addNCTable(pptx: PptxGen, data: DeckData) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, IA.blue);
  addFooter(s, false);
  addHeader(s, "Nouveaux Clients — NC / CP-NC / %NC");

  const cols = ["Platform", "NC", "Δ NC", "CP-NC", "Δ CP-NC", "%NC", "Δ %NC"];
  const headerRow = cols.map((h) => ({
    text: h,
    options: {
      bold: true, color: c(IA.textWhite), fill: { color: c(IA.tableHeader) },
      fontSize: 9, fontFace: FONTS.body, align: "center" as const,
    },
  }));

  const dataRows = data.ncTable.map((row, idx) => {
    const isTotal = row.platform === "Total";
    const base = {
      color: isTotal ? c(IA.blueDark) : c(IA.textBlack),
      bold: isTotal,
      fill: isTotal ? { color: c(IA.bgAlt) } : idx % 2 === 1 ? { color: c(IA.bgRowAlt) } : { color: c(IA.bgWhite) },
      fontSize: 9, fontFace: FONTS.body, align: "center" as const,
    };
    return [
      { text: row.platform, options: base },
      { text: String(row.current.newClients), options: base },
      { text: deltaStr(row.delta.newClients), options: { ...base, color: deltaColor(row.delta.newClients) } },
      { text: "€" + fmtDec(row.current.cpNc), options: base },
      { text: deltaStr(row.delta.cpNc), options: { ...base, color: deltaColor(row.delta.cpNc, true) } },
      { text: fmtPct(row.current.percentNc), options: base },
      { text: deltaStr(row.delta.percentNc), options: { ...base, color: deltaColor(row.delta.percentNc) } },
    ];
  });

  const colW = 12 / cols.length;
  s.addTable([headerRow, ...dataRows], {
    x: LAYOUT.marginX + 0.2, y: LAYOUT.contentY + 0.3,
    w: cols.length * colW, colW: Array(cols.length).fill(colW), rowH: 0.4,
    border: { type: "solid", pt: 0.5, color: c(IA.bgRowAlt) },
  });
}

function addLearnings(pptx: PptxGen, learnings: string[], barColor: string) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, barColor);
  addFooter(s, false);
  addHeader(s, "Learnings");

  // Dark block
  s.addShape("roundRect", {
    x: LAYOUT.marginX + 0.3, y: LAYOUT.contentY + 0.2, w: 12, h: 5.5,
    fill: { color: c(IA.bgDark) }, line: { width: 0 }, rectRadius: 0.1,
  });
  s.addText("// LEARNINGS", {
    x: LAYOUT.marginX + 0.6, y: LAYOUT.contentY + 0.4, w: 5, h: 0.4,
    fontSize: 12, bold: true, color: c(IA.blue), fontFace: FONTS.title,
  });

  learnings.forEach((l, i) => {
    const y = LAYOUT.contentY + 1.0 + i * 0.9;
    s.addText(`${String(i + 1).padStart(2, "0")}.`, {
      x: LAYOUT.marginX + 0.6, y, w: 0.5, h: 0.5,
      fontSize: 11, bold: true, color: c(IA.blue), fontFace: FONTS.body,
    });
    s.addText(l, {
      x: LAYOUT.marginX + 1.2, y, w: 10.5, h: 0.7,
      fontSize: 10, color: c(IA.textWhite), fontFace: FONTS.body, valign: "top",
    });
  });
}

function addKPIOverview(pptx: PptxGen, title: string, metrics: PlatformMetrics, barColor: string, accent: string) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, barColor);
  addFooter(s, false);
  addHeader(s, title);

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

  const cols = 4;
  const cardW = 2.6;
  const gap = 0.25;
  const totalW = cols * cardW + (cols - 1) * gap;
  const startX = (LAYOUT.width - totalW) / 2;

  kpis.forEach((k, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = startX + col * (cardW + gap);
    const y = LAYOUT.contentY + 0.4 + row * 2.2;

    s.addShape("roundRect", {
      x, y, w: cardW, h: 1.8,
      fill: { color: c(IA.bgAlt) }, line: { width: 0 }, rectRadius: 0.08,
    });
    s.addText(k.label, {
      x, y: y + 0.2, w: cardW, h: 0.4,
      fontSize: 9, color: c(IA.textCaption), fontFace: FONTS.body, align: "center",
    });
    s.addText(k.value, {
      x, y: y + 0.7, w: cardW, h: 0.8,
      fontSize: 28, bold: true, color: c(accent), fontFace: FONTS.kpi, align: "center",
    });
  });
}

function addCampaignTable(pptx: PptxGen, title: string, campaigns: CampaignRow[], barColor: string, periodLabel: string) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, barColor);
  addFooter(s, false);
  addHeader(s, title);
  s.addText(periodLabel, {
    x: LAYOUT.marginX + 0.3, y: 0.92, w: 11, h: 0.3,
    fontSize: 9, italic: true, color: c(IA.textCaption), fontFace: FONTS.body,
  });

  const cols = ["Campaign", "Status", "Spend", "Impr.", "Clicks", "Conv.", "CPA", "ROAS", "Δ ROAS"];
  const headerRow = cols.map((h) => ({
    text: h,
    options: {
      bold: true, color: c(IA.textWhite), fill: { color: c(IA.tableHeader) },
      fontSize: 8, fontFace: FONTS.body, align: "center" as const,
    },
  }));

  const dataRows = campaigns.map((camp, idx) => {
    const base = {
      color: c(IA.textBlack), fontSize: 8, fontFace: FONTS.body, align: "center" as const,
      fill: idx % 2 === 1 ? { color: c(IA.bgRowAlt) } : { color: c(IA.bgWhite) },
    };
    return [
      { text: camp.name, options: { ...base, align: "left" as const } },
      { text: camp.status, options: { ...base, color: camp.status === "Active" ? c(IA.deltaPos) : "E65100" } },
      { text: fmtCur(camp.current.spend), options: base },
      { text: fmtK(camp.current.impressions), options: base },
      { text: fmtK(camp.current.clicks), options: base },
      { text: String(Math.round(camp.current.conversions)), options: base },
      { text: "€" + fmtDec(camp.current.cpa), options: base },
      { text: fmtDec(camp.current.roas) + "×", options: { ...base, bold: true } },
      { text: deltaStr(camp.delta.roas), options: { ...base, color: deltaColor(camp.delta.roas) } },
    ];
  });

  s.addTable([headerRow, ...dataRows], {
    x: LAYOUT.marginX + 0.2, y: LAYOUT.contentY + 0.3,
    w: 12.5, colW: [2.5, 0.8, 1.2, 1.2, 1, 0.9, 1.1, 1, 1],
    rowH: 0.35,
    border: { type: "solid", pt: 0.5, color: c(IA.bgRowAlt) },
  });
}

function addNextSteps(pptx: PptxGen, title: string, steps: string[], barColor: string, accent: string) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, barColor);
  addFooter(s, false);
  addHeader(s, title);

  steps.forEach((step, i) => {
    const y = LAYOUT.contentY + 0.3 + i * 0.9;
    const bg = i % 2 === 0 ? IA.bgAlt : IA.bgWhite;
    s.addShape("roundRect", {
      x: LAYOUT.marginX + 0.3, y, w: 12, h: 0.7,
      fill: { color: c(bg) }, line: { width: 0 }, rectRadius: 0.05,
    });
    s.addText(`${String(i + 1).padStart(2, "0")}`, {
      x: LAYOUT.marginX + 0.5, y, w: 0.5, h: 0.7,
      fontSize: 14, bold: true, color: c(accent), fontFace: FONTS.kpi,
    });
    s.addText(step, {
      x: LAYOUT.marginX + 1.2, y, w: 10.5, h: 0.7,
      fontSize: SIZES.body, color: c(IA.textBlack), fontFace: FONTS.body, valign: "middle",
    });
  });
}

function addBudget(pptx: PptxGen, budget: BudgetLine[], periodLabel: string) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, IA.blue);
  addFooter(s, false);
  addHeader(s, `Budget — ${periodLabel}`);

  const cols = ["Platform", "Budget prévu", "Dépensé", "Écart"];
  const headerRow = cols.map((h) => ({
    text: h,
    options: {
      bold: true, color: c(IA.textWhite), fill: { color: c(IA.tableHeader) },
      fontSize: 10, fontFace: FONTS.body, align: "center" as const,
    },
  }));

  const dataRows = budget.map((b, idx) => {
    const isTotal = b.platform === "Total";
    const base = {
      color: isTotal ? c(IA.blueDark) : c(IA.textBlack),
      bold: isTotal,
      fill: isTotal ? { color: c(IA.bgAlt) } : idx % 2 === 1 ? { color: c(IA.bgRowAlt) } : { color: c(IA.bgWhite) },
      fontSize: 10, fontFace: FONTS.body, align: "center" as const,
    };
    return [
      { text: b.platform, options: base },
      { text: fmtCur(b.planned), options: base },
      { text: fmtCur(b.actual), options: base },
      { text: deltaStr(b.variance), options: { ...base, color: deltaColor(b.variance) } },
    ];
  });

  s.addTable([headerRow, ...dataRows], {
    x: LAYOUT.marginX + 1, y: LAYOUT.contentY + 0.3,
    w: 10, colW: [2.5, 2.5, 2.5, 2.5], rowH: 0.45,
    border: { type: "solid", pt: 0.5, color: c(IA.bgRowAlt) },
  });

  // Bar chart
  const platforms = budget.filter((b) => b.platform !== "Total");
  const barStartY = LAYOUT.contentY + 2.5;
  platforms.forEach((b, i) => {
    const x = LAYOUT.marginX + 1 + i * 5;
    const barW = 4;
    const pct = Math.min(1, b.actual / b.planned);
    const barColor = b.platform === "Meta" ? IA.violet : IA.blue;

    s.addText(b.platform, {
      x, y: barStartY, w: barW, h: 0.3,
      fontSize: 10, bold: true, color: c(IA.blueDark), fontFace: FONTS.body,
    });
    s.addShape("roundRect", {
      x, y: barStartY + 0.35, w: barW, h: 0.25,
      fill: { color: c(IA.bgRowAlt) }, line: { width: 0 }, rectRadius: 0.05,
    });
    s.addShape("roundRect", {
      x, y: barStartY + 0.35, w: barW * pct, h: 0.25,
      fill: { color: c(barColor) }, line: { width: 0 }, rectRadius: 0.05,
    });
    s.addText(`${fmtCur(b.actual)} / ${fmtCur(b.planned)}`, {
      x, y: barStartY + 0.65, w: barW, h: 0.25,
      fontSize: 8, color: c(IA.textCaption), fontFace: FONTS.body,
    });
  });
}

function addTopCreatives(pptx: PptxGen, creatives: TopCreative[]) {
  const s = pptx.addSlide();
  s.background = { color: c(IA.bgWhite) };
  addBar(s, IA.violet);
  addFooter(s, false);
  addHeader(s, "Top Créatives — Performance");

  const top6 = creatives.slice(0, 6);
  const cols = 3;
  const cardW = 3.6;
  const cardH = 2.5;
  const gapX = 0.35;
  const gapY = 0.3;
  const startX = (LAYOUT.width - (cols * cardW + (cols - 1) * gapX)) / 2;

  top6.forEach((cr, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = startX + col * (cardW + gapX);
    const y = LAYOUT.contentY + 0.3 + row * (cardH + gapY);

    s.addShape("roundRect", {
      x, y, w: cardW, h: cardH,
      fill: { color: c(IA.bgAlt) }, line: { width: 0 }, rectRadius: 0.08,
    });
    s.addText(cr.name, {
      x: x + 0.15, y: y + 0.1, w: cardW - 0.3, h: 0.35,
      fontSize: 8, bold: true, color: c(IA.textBlack), fontFace: FONTS.body,
    });
    s.addShape("roundRect", {
      x: x + 0.15, y: y + 0.5, w: cardW - 0.3, h: 0.3,
      fill: { color: c(IA.violet) }, line: { width: 0 }, rectRadius: 0.04,
    });
    s.addText(cr.format, {
      x: x + 0.15, y: y + 0.5, w: cardW - 0.3, h: 0.3,
      fontSize: 8, bold: true, color: c(IA.textWhite), fontFace: FONTS.body, align: "center",
    });

    const metrics = [
      { label: "Spend", value: fmtCur(cr.spend) },
      { label: "ROAS", value: fmtDec(cr.roas) + "×" },
      { label: "CTR", value: fmtPct(cr.ctr) },
      { label: "CPA", value: "€" + fmtDec(cr.cpa) },
    ];
    metrics.forEach((m, mi) => {
      const mx = x + 0.15 + (mi % 2) * (cardW / 2 - 0.15);
      const my = y + 1.0 + Math.floor(mi / 2) * 0.65;
      s.addText(m.label, {
        x: mx, y: my, w: cardW / 2 - 0.3, h: 0.25,
        fontSize: 7, color: c(IA.textCaption), fontFace: FONTS.body,
      });
      s.addText(m.value, {
        x: mx, y: my + 0.22, w: cardW / 2 - 0.3, h: 0.3,
        fontSize: 10, bold: true, color: c(IA.textBlack), fontFace: FONTS.body,
      });
    });
  });
}

// ── Main export function ────────────────────────────────────────────────────

export async function exportDeckToPptx(data: DeckData): Promise<Blob> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();

  pptx.author = "Impulse Analytics";
  pptx.title = `MBR — ${data.client.name} — ${data.period.label}`;
  pptx.layout = "LAYOUT_WIDE";

  const periodLabel = `${data.period.label} vs ${data.previousPeriod.label}`;

  // Cover & Agenda
  addCover(pptx, data);
  addAgenda(pptx, data);

  // Section 1 — Global Overview
  addSectionDivider(pptx, "01", "Global Overview", "Highlights · Performance · Nouveaux Clients", IA.blue);
  addHighlights(pptx, data);
  addGlobalTable(pptx, data);
  addNCTable(pptx, data);
  addLearnings(pptx, data.learnings, IA.blue);

  // Section 2 — Google Ads
  addSectionDivider(pptx, "02", "Focus Google Ads", "Vue globale · Campagnes · Brand Search · Pmax", IA.blue);
  addKPIOverview(pptx, "Google Ads — Vue Globale", data.googleOverview, IA.blue, IA.blue);
  addCampaignTable(pptx, "Google Ads — Campagnes", data.googleCampaigns, IA.blue, periodLabel);
  addLearnings(pptx, data.insightsGoogle, IA.blue);
  addNextSteps(pptx, "Next Steps — Google Ads", data.nextStepsGoogle, IA.blue, IA.blue);

  // Section 3 — Meta Ads
  addSectionDivider(pptx, "03", "Focus Meta Ads", "Vue globale · Campagnes · Top Créas · Learnings", IA.violet);
  addKPIOverview(pptx, "Meta Ads — Vue Globale", data.metaOverview, IA.violet, IA.violet);
  addCampaignTable(pptx, "Meta Ads — Campagnes", data.metaCampaigns, IA.violet, periodLabel);
  addTopCreatives(pptx, data.topCreatives);
  addLearnings(pptx, data.insightsMeta, IA.violet);
  addNextSteps(pptx, "Next Steps — Meta Ads", data.nextStepsMeta, IA.violet, IA.violet);

  // Section 4 — Next Steps & Budget
  addSectionDivider(pptx, "04", "Next Steps & Budget", "Actions globales · Budget mensuel", IA.blue);
  addNextSteps(pptx, "Next Steps — Global", data.nextStepsGlobal, IA.blue, IA.blue);
  addBudget(pptx, data.budget, data.period.label);

  // Return as Blob — caller handles download
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = await (pptx as any).write({ outputType: "blob" }) as Blob;
  return blob;
}
