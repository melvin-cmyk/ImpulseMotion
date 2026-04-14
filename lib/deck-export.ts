/**
 * Export DeckData (from the /deck page) directly to PPTX
 * using pptxgenjs with the Impulse Analytics design system.
 */

import type { DeckData, PlatformMetrics, PlatformRow, CampaignRow, TopCreative, BudgetLine } from "./deck-data";
import { IA, FONTS, SIZES, LAYOUT } from "./impulse-theme";

// ── Inline types from page.tsx (for custom slides and dropped blocks) ────────

interface CustomSlide {
  id: string;
  label: string;
  content: string;
  fontFamily?: string;
}

interface DroppedBlock {
  id: string;
  content: string;
  slideIndex: number;
  kind?: "standard" | "custom" | "ai";
  localIdx?: number;
  x: number; // % of canvas width
  y: number; // % of canvas height
  w: number; // % of canvas width
  h?: number; // % of canvas height (auto if undefined)
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
}

// Style overrides maintained in page state for tables inside dropped blocks
export interface BlockStyle {
  headerColor: string;
  rowColor: string;
  fontSize: number;
  fontFamily: string;
  textColor: string;
  borderColor: string;
  borderWidth: number;
}

interface SlideElement {
  id: string;
  type: "text" | "rect" | "circle" | "arrow" | "triangle" | "line" | "image";
  x: number; // % of canvas width
  y: number; // % of canvas height
  w: number; // % of canvas width
  h: number; // % of canvas height
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  // Text-specific
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: "normal" | "bold";
  fontStyle?: "normal" | "italic";
  textDecoration?: "none" | "underline";
  textColor?: string;
  textAlign?: "left" | "center" | "right";
  // Image-specific
  imageUrl?: string;
}

// ── Dropped-block renderer (markdown → real pptx shapes) ────────────────────

interface MdBlock {
  type: "heading" | "paragraph" | "list" | "table";
  level?: number;            // heading level
  text?: string;             // heading/paragraph
  items?: string[];          // list items
  rows?: string[][];         // table rows (first = header)
}

function parseMarkdownBlocks(md: string): MdBlock[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines
    if (!line.trim()) { i++; continue; }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { out.push({ type: "heading", level: h[1].length, text: h[2].trim() }); i++; continue; }
    // Table — line starts with `|` and next line is separator `| --- |`
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*[-:]+/.test(lines[i + 1])) {
      const rows: string[][] = [];
      const headerCells = line.split("|").map((c) => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === "") && !(idx === arr.length - 1 && c === ""));
      rows.push(headerCells);
      i += 2; // skip header and separator
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].split("|").map((c) => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === "") && !(idx === arr.length - 1 && c === ""));
        if (cells.length > 0) rows.push(cells);
        i++;
      }
      out.push({ type: "table", rows });
      continue;
    }
    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, "").trim());
        i++;
      }
      out.push({ type: "list", items });
      continue;
    }
    // Ordered list (1. 2. 3. ...). Strip the number so the renderer uses bullets.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "").trim());
        i++;
      }
      out.push({ type: "list", items });
      continue;
    }
    // Paragraph (collect consecutive non-blank lines)
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s|\|)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push({ type: "paragraph", text: para.join(" ").trim() });
  }
  return out;
}

/** Strip simple inline markdown (bold/italic/code) for display in pptx text. */
function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/**
 * Render a dropped block (markdown content with optional table) onto a slide.
 * Honours the user-customised block style for tables (header/row colours, font).
 * Returns true on success.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addDroppedBlock(slide: any, block: DroppedBlock, style: BlockStyle | undefined, layoutW: number, layoutH: number) {
  const xIn = (block.x / 100) * layoutW;
  const yIn = (block.y / 100) * layoutH;
  const wIn = (block.w / 100) * layoutW;
  const allocatedH = block.h !== undefined ? (block.h / 100) * layoutH : layoutH * 0.5;

  const blocks = parseMarkdownBlocks(block.content);
  const fontFace = style?.fontFamily === "Mono" ? "Courier New"
    : style?.fontFamily === "Georgia" ? "Georgia"
    : style?.fontFamily ?? block.fontFamily ?? FONTS.body;
  const baseColor = (style?.textColor ?? block.textColor ?? "#1a1a1a").replace("#", "");
  const baseSize = style?.fontSize ?? block.fontSize ?? 11;

  const padX = 0.12;
  const padY = 0.12;

  // Estimate natural content height so the card shrinks to fit small content
  // (avoids huge empty white area when only a 3-row table is dropped).
  // Estimate ~2.0 chars per em width for typical fonts at body size.
  const innerWForEstimate = wIn - padX * 2;
  const charsPerLine = Math.max(20, Math.floor((innerWForEstimate * 72) / (baseSize * 0.55)));
  const lineH = (baseSize * 1.35) / 72;
  let naturalH = padY * 2;
  for (const b of blocks) {
    if (b.type === "heading") {
      const size = b.level === 1 ? Math.max(baseSize + 6, 14) : Math.max(baseSize + 3, 12);
      naturalH += (size * 1.5) / 72 + 0.05;
    } else if (b.type === "paragraph") {
      const lines = Math.max(1, Math.ceil((b.text ?? "").length / charsPerLine));
      naturalH += lines * lineH + 0.1;
    } else if (b.type === "list") {
      for (const item of b.items ?? []) {
        const lines = Math.max(1, Math.ceil((item.length + 2) / charsPerLine));
        naturalH += lines * lineH + 0.04;
      }
    } else if (b.type === "table") {
      naturalH += ((b.rows?.length ?? 0) * (baseSize + 6)) / 72 + 0.15;
    }
  }
  // Honour the allocated height as an upper bound, but if natural is less, shrink.
  const hIn = block.h !== undefined ? Math.min(allocatedH, Math.max(naturalH, baseSize / 72 + 0.4)) : Math.min(allocatedH, naturalH);

  // White card background to mirror the on-screen look
  slide.addShape("rect", {
    x: xIn, y: yIn, w: wIn, h: hIn,
    fill: { color: "FFFFFF" },
    line: { color: "E5E7EB", width: 0.5 },
  });

  let cursorY = yIn + padY;
  const innerW = wIn - padX * 2;
  const maxY = yIn + hIn - padY;

  for (const b of blocks) {
    if (cursorY >= maxY) break;
    if (b.type === "heading") {
      const size = b.level === 1 ? Math.max(baseSize + 6, 14) : Math.max(baseSize + 3, 12);
      const h = (size / 72) * 1.5;
      if (cursorY + h > maxY) break;
      slide.addText(stripInline(b.text ?? ""), {
        x: xIn + padX, y: cursorY, w: innerW, h,
        fontSize: size, bold: true, color: baseColor, fontFace,
        valign: "top",
      });
      cursorY += h + 0.05;
    } else if (b.type === "paragraph") {
      const lines = Math.max(1, Math.ceil((b.text ?? "").length / charsPerLine));
      const h = Math.min(maxY - cursorY, lines * lineH + 0.1);
      slide.addText(stripInline(b.text ?? ""), {
        x: xIn + padX, y: cursorY, w: innerW, h,
        fontSize: baseSize, color: baseColor, fontFace,
        valign: "top", wrap: true,
      });
      cursorY += h + 0.05;
    } else if (b.type === "list") {
      const items = b.items ?? [];
      for (const item of items) {
        if (cursorY >= maxY) break;
        const lines = Math.max(1, Math.ceil((stripInline(item).length + 2) / charsPerLine));
        const h = Math.min(maxY - cursorY, lines * lineH + 0.05);
        slide.addText("• " + stripInline(item), {
          x: xIn + padX, y: cursorY, w: innerW, h,
          fontSize: baseSize, color: baseColor, fontFace,
          valign: "top", wrap: true,
        });
        cursorY += h + 0.04;
      }
    } else if (b.type === "table") {
      const rows = b.rows ?? [];
      if (rows.length === 0) continue;
      const colCount = Math.max(...rows.map((r) => r.length));
      const headerColor = (style?.headerColor ?? "#0070C0").replace("#", "");
      const rowAltColor = (style?.rowColor ?? "#F3F3F3").replace("#", "");
      const borderColor = (style?.borderColor ?? "#E5E7EB").replace("#", "");
      const borderW = style?.borderWidth ?? 1;
      const tableRows = rows.map((r, rIdx) => {
        // Pad short rows to colCount
        const cells = [...r];
        while (cells.length < colCount) cells.push("");
        return cells.map((cell) => ({
          text: stripInline(cell),
          options: rIdx === 0
            ? {
                fill: { color: headerColor },
                color: "FFFFFF",
                bold: true,
                fontSize: baseSize,
                fontFace,
                align: "left" as const,
                valign: "middle" as const,
                border: { type: "solid" as const, color: borderColor, pt: borderW * 0.75 },
              }
            : {
                fill: { color: rIdx % 2 === 0 ? "FFFFFF" : rowAltColor },
                color: baseColor,
                fontSize: baseSize,
                fontFace,
                align: "left" as const,
                valign: "middle" as const,
                border: { type: "solid" as const, color: borderColor, pt: borderW * 0.75 },
              },
        }));
      });
      const remaining = maxY - cursorY;
      const tableH = Math.min(remaining, ((rows.length * (baseSize + 6)) / 72) + 0.1);
      slide.addTable(tableRows, {
        x: xIn + padX, y: cursorY, w: innerW, h: tableH,
        fontSize: baseSize, fontFace,
        autoPage: false,
        rowH: tableH / rows.length,
      });
      cursorY += tableH + 0.05;
    }
  }
}

/** Render SlideElements onto a pptxgenjs slide object */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addSlideElements(slide: any, elements: SlideElement[], layoutW: number, layoutH: number) {
  for (const el of elements) {
    const x = (el.x / 100) * layoutW;
    const y = (el.y / 100) * layoutH;
    const w = (el.w / 100) * layoutW;
    const h = (el.h / 100) * layoutH;
    const fill = el.fillColor === "transparent" ? { type: "none" as const } : { color: el.fillColor.replace("#", "") };
    const line = el.strokeWidth > 0 ? { color: el.strokeColor.replace("#", ""), width: el.strokeWidth } : undefined;

    switch (el.type) {
      case "rect":
        slide.addShape("rect", { x, y, w, h, fill, line });
        break;
      case "circle":
        slide.addShape("ellipse", { x, y, w, h, fill, line });
        break;
      case "triangle":
        slide.addShape("triangle", { x, y, w, h, fill, line });
        break;
      case "arrow":
        slide.addShape("line", { x, y, w, h: 0, line: { color: el.strokeColor.replace("#", ""), width: el.strokeWidth, endArrowType: "arrow" } });
        break;
      case "line":
        slide.addShape("line", { x, y, w, h: 0, line: { color: el.strokeColor.replace("#", ""), width: el.strokeWidth } });
        break;
      case "text":
        if (el.text) {
          slide.addText(el.text, {
            x, y, w, h,
            fontSize: el.fontSize ?? 12,
            color: (el.textColor ?? "#ffffff").replace("#", ""),
            fontFace: el.fontFamily?.split(",")[0].trim().replace(/'/g, "") ?? "Inter",
            bold: el.fontWeight === "bold",
            italic: el.fontStyle === "italic",
            underline: el.textDecoration === "underline" ? { style: "sng" } : undefined,
            align: el.textAlign ?? "left",
            valign: "top",
            wrap: true,
          });
        }
        break;
      case "image":
        if (el.imageUrl?.startsWith("data:")) {
          try {
            const [header, data] = el.imageUrl.split(",");
            const ext = header.match(/image\/(\w+)/)?.[1] ?? "png";
            slide.addImage({ data: `${header},${data}`, x, y, w, h, sizing: { type: "contain", w, h } });
          } catch { /* skip invalid images */ }
        }
        break;
    }
  }
}

/** Strip common markdown formatting to produce plain text */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")       // headings
    .replace(/\*\*(.+?)\*\*/g, "$1")    // bold
    .replace(/\*(.+?)\*/g, "$1")        // italic
    .replace(/`(.+?)`/g, "$1")          // inline code
    .replace(/^[-*+]\s+/gm, "• ")       // unordered list
    .replace(/^\d+\.\s+/gm, "")         // ordered list
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // links
    .replace(/!\[.*?\]\(.+?\)/g, "")    // images
    .replace(/^\|.+\|$/gm, "")          // tables
    .replace(/^[-|: ]+$/gm, "")         // table separators
    .replace(/\n{3,}/g, "\n\n")         // excessive newlines
    .trim();
}

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

function addTopCreatives(pptx: PptxGen, creatives: TopCreative[], thumbnailDataMap: Record<string, string> = {}) {
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

    // Thumbnail image (top portion of card)
    const imgDataUrl = cr.id ? thumbnailDataMap[cr.id] : undefined;
    const imgH = 0.85;
    if (imgDataUrl) {
      try {
        s.addImage({ data: imgDataUrl, x: x + 0.1, y: y + 0.1, w: cardW - 0.2, h: imgH, sizing: { type: "cover", w: cardW - 0.2, h: imgH } });
      } catch { /* skip if image fails */ }
    } else {
      // Placeholder gradient rect when no image
      s.addShape("roundRect", {
        x: x + 0.1, y: y + 0.1, w: cardW - 0.2, h: imgH,
        fill: { color: c(IA.violet), alpha: 30 }, line: { width: 0 }, rectRadius: 0.05,
      });
      s.addText(cr.format, {
        x: x + 0.1, y: y + 0.1, w: cardW - 0.2, h: imgH,
        fontSize: 9, bold: true, color: c(IA.violet), fontFace: FONTS.body, align: "center", valign: "middle",
      });
    }

    // Name below image
    s.addText(cr.name, {
      x: x + 0.15, y: y + imgH + 0.18, w: cardW - 0.3, h: 0.3,
      fontSize: 7, bold: true, color: c(IA.textBlack), fontFace: FONTS.body,
    });

    // Format badge
    s.addShape("roundRect", {
      x: x + 0.15, y: y + imgH + 0.52, w: 0.7, h: 0.22,
      fill: { color: c(IA.violet) }, line: { width: 0 }, rectRadius: 0.04,
    });
    s.addText(cr.format, {
      x: x + 0.15, y: y + imgH + 0.52, w: 0.7, h: 0.22,
      fontSize: 6, bold: true, color: c(IA.textWhite), fontFace: FONTS.body, align: "center",
    });

    const metrics = [
      { label: "Spend", value: fmtCur(cr.spend) },
      { label: "ROAS", value: fmtDec(cr.roas) + "×" },
      { label: "CTR", value: fmtPct(cr.ctr) },
      { label: "CPA", value: "€" + fmtDec(cr.cpa) },
    ];
    metrics.forEach((m, mi) => {
      const mx = x + 0.15 + (mi % 2) * (cardW / 2 - 0.15);
      const my = y + imgH + 0.82 + Math.floor(mi / 2) * 0.55;
      s.addText(m.label, {
        x: mx, y: my, w: cardW / 2 - 0.3, h: 0.22,
        fontSize: 6, color: c(IA.textCaption), fontFace: FONTS.body,
      });
      s.addText(m.value, {
        x: mx, y: my + 0.19, w: cardW / 2 - 0.3, h: 0.28,
        fontSize: 9, bold: true, color: c(IA.textBlack), fontFace: FONTS.body,
      });
    });
  });
}

// ── Main export function ────────────────────────────────────────────────────

async function fetchOneThumbnail(url: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/deck/proxy-image?url=${encodeURIComponent(url)}&format=base64`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function fetchThumbnails(creatives: TopCreative[], extraUrls: string[] = []): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await Promise.all([
    ...creatives.filter(cr => cr.thumbnailUrl && cr.id).map(async (cr) => {
      const dataUrl = await fetchOneThumbnail(cr.thumbnailUrl!);
      if (dataUrl) result[cr.id] = dataUrl;
    }),
    // AI slide images keyed by the URL itself
    ...extraUrls.filter(Boolean).map(async (u) => {
      const dataUrl = await fetchOneThumbnail(u);
      if (dataUrl) result[u] = dataUrl;
    }),
  ]);
  return result;
}

export async function exportDeckToPptx(
  data: DeckData,
  customSlides?: CustomSlide[],
  droppedBlocks?: DroppedBlock[],
  slideElements?: Record<number, SlideElement[]>,
  aiSlides?: import("@/types/deck").SlideData[],
  blockStyles?: Record<string, BlockStyle>
): Promise<Blob> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();

  pptx.author = "Impulse Analytics";
  pptx.title = `MBR — ${data.client.name} — ${data.period.label}`;
  pptx.layout = "LAYOUT_WIDE";

  const periodLabel = `${data.period.label} vs ${data.previousPeriod.label}`;

  // Pre-fetch creative thumbnails + any AI-slide image URLs (server-side proxy avoids CORS)
  const aiImageUrls = (aiSlides ?? []).flatMap((sl) => (sl.images ?? []).map((i) => i.url));
  const thumbnailDataMap = await fetchThumbnails(data.topCreatives ?? [], aiImageUrls);

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
  addTopCreatives(pptx, data.topCreatives, thumbnailDataMap);
  addLearnings(pptx, data.insightsMeta, IA.violet);
  addNextSteps(pptx, "Next Steps — Meta Ads", data.nextStepsMeta, IA.violet, IA.violet);

  // Section 4 — Next Steps & Budget
  addSectionDivider(pptx, "04", "Next Steps & Budget", "Actions globales · Budget mensuel", IA.blue);
  addNextSteps(pptx, "Next Steps — Global", data.nextStepsGlobal, IA.blue, IA.blue);
  addBudget(pptx, data.budget, data.period.label);

  // Standard slides are indices 0..17 (18 slides total above)
  const STANDARD_SLIDE_COUNT = 18;

  // ── Dropped blocks overlay on standard slides ───────────────────────────
  if (droppedBlocks && droppedBlocks.length > 0) {
    // pptxgenjs slide objects can't be retrieved after creation, so we process
    // dropped blocks that fall on custom slides below. For standard slides we
    // add them by re-using the slide reference returned from addSlide — but
    // since the helpers above don't return the slide, we use a workaround:
    // group blocks by slideIndex and store them for post-processing via the
    // pptx.slides array.
    // Group standard-slide drops by their LOCAL standard index. New blocks
    // carry kind/localIdx; legacy blocks fall back to the absolute slideIndex
    // (which was correct when the page slide count == export slide count).
    const blocksBySlide: Record<number, DroppedBlock[]> = {};
    for (const block of droppedBlocks) {
      const isStandard = block.kind ? block.kind === "standard" : block.slideIndex < STANDARD_SLIDE_COUNT;
      if (!isStandard) continue;
      const idx = block.kind === "standard" && block.localIdx != null ? block.localIdx : block.slideIndex;
      if (!blocksBySlide[idx]) blocksBySlide[idx] = [];
      blocksBySlide[idx].push(block);
    }
    // Access internal slides array to add overlays on already-created slides
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalSlides: any[] = (pptx as any).slides ?? [];
    for (const [slideIdxStr, blocks] of Object.entries(blocksBySlide)) {
      const slideIdx = Number(slideIdxStr);
      if (slideIdx >= STANDARD_SLIDE_COUNT) continue;
      const slide = internalSlides[slideIdx];
      if (!slide) continue;
      for (const block of blocks) {
        addDroppedBlock(slide, block, blockStyles?.[block.id], LAYOUT.width, LAYOUT.height);
      }
      // SlideElements (drawn shapes/text) on this standard slide
      const els = slideElements?.[slideIdx];
      if (els && els.length > 0) addSlideElements(slide, els, LAYOUT.width, LAYOUT.height);
    }

    // Also handle standard slides that have elements but no dropped blocks
    if (slideElements) {
      for (const [idxStr, els] of Object.entries(slideElements)) {
        const idx = Number(idxStr);
        if (idx >= STANDARD_SLIDE_COUNT) continue;
        if (blocksBySlide[idx]) continue; // already processed above
        const slide = internalSlides[idx];
        if (slide && els.length > 0) addSlideElements(slide, els, LAYOUT.width, LAYOUT.height);
      }
    }
  } else if (slideElements) {
    // No dropped blocks but may have drawn elements on standard slides
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalSlides: any[] = (pptx as any).slides ?? [];
    for (const [idxStr, els] of Object.entries(slideElements)) {
      const idx = Number(idxStr);
      if (idx >= STANDARD_SLIDE_COUNT) continue;
      const slide = internalSlides[idx];
      if (slide && els.length > 0) addSlideElements(slide, els, LAYOUT.width, LAYOUT.height);
    }
  }

  // ── Custom slides ────────────────────────────────────────────────────────
  if (customSlides && customSlides.length > 0) {
    // Build a map of dropped blocks for custom slides, keyed by LOCAL custom
    // index (so it's robust to page filter differences).
    const customBlocksBySlide: Record<number, DroppedBlock[]> = {};
    if (droppedBlocks) {
      for (const block of droppedBlocks) {
        let localIdx: number | null = null;
        if (block.kind === "custom" && block.localIdx != null) localIdx = block.localIdx;
        else if (!block.kind && block.slideIndex >= STANDARD_SLIDE_COUNT) {
          // Legacy block — assume export-coordinates
          localIdx = block.slideIndex - STANDARD_SLIDE_COUNT;
        }
        if (localIdx != null) {
          if (!customBlocksBySlide[localIdx]) customBlocksBySlide[localIdx] = [];
          customBlocksBySlide[localIdx].push(block);
        }
      }
    }

    customSlides.forEach((cs, i) => {
      const absIdx = STANDARD_SLIDE_COUNT + i;
      const s = pptx.addSlide();
      s.background = { color: c(IA.bgDark) };
      addBar(s, IA.blue);
      addFooter(s, true);

      // Title (label)
      s.addText(cs.label, {
        x: LAYOUT.marginX + 0.3, y: 0.25, w: 11, h: 0.6,
        fontSize: SIZES.titleMain, bold: true, color: c(IA.textWhite),
        fontFace: cs.fontFamily ?? FONTS.title,
      });
      s.addShape("rect", {
        x: LAYOUT.marginX + 0.3, y: 0.9, w: 12, h: 0.015,
        fill: { color: c(IA.blue) }, line: { width: 0 },
      });

      // Content — render markdown content (tables, headings, lists) as a
      // block on a white background so it matches the on-screen preview.
      // Strip a leading H1 if it matches the slide label (avoids duplicating
      // the title that's already shown in the slide header).
      if (cs.content && cs.content.trim()) {
        let content = cs.content;
        const firstHeading = content.match(/^\s*#\s+(.+?)\s*$/m);
        if (firstHeading && firstHeading[1].trim() === cs.label.trim()) {
          content = content.replace(firstHeading[0], "").trimStart();
        }
        const contentBlock: DroppedBlock = {
          id: `cs-${cs.id}`,
          content,
          slideIndex: absIdx,
          x: 2.5, y: 13, w: 95, h: 80,
          fontFamily: cs.fontFamily,
        };
        addDroppedBlock(s, contentBlock, undefined, LAYOUT.width, LAYOUT.height);
      }

      // Dropped blocks on this custom slide
      const blocks = customBlocksBySlide[i] ?? [];
      for (const block of blocks) {
        addDroppedBlock(s, block, blockStyles?.[block.id], LAYOUT.width, LAYOUT.height);
      }

      // SlideElements (drawn shapes/text) on this custom slide
      const customEls = slideElements?.[absIdx];
      if (customEls && customEls.length > 0) addSlideElements(s, customEls, LAYOUT.width, LAYOUT.height);
    });
  }

  // ── AI Dynamic Slides ──────────────────────────────────────────────────────
  if (aiSlides && aiSlides.length > 0) {
    // Section divider for AI slides
    addSectionDivider(pptx, "AI", "Slides IA", "Slides générées par l'intelligence artificielle", IA.violet);

    // Lazy-load the semantic layout renderer (same as exportAiSlidesToPptx)
    const { renderSemanticLayout } = await import("./deck-pptx-layouts");

    for (let aiIdx = 0; aiIdx < aiSlides.length; aiIdx++) {
      const slide = aiSlides[aiIdx];
      const s = pptx.addSlide();
      s.background = { color: c(IA.bgWhite) };

      // Semantic layout dispatch: if AI tagged the slide with `layout`,
      // delegate to the dedicated renderer and skip the generic stacking path.
      // Still apply editor element + dropped-block overlays below.
      // Exception: when the slide carries creative thumbnails (`images`), fall
      // through to the generic path so they render — semantic renderers don't
      // know about `thumbnailDataMap`.
      let semanticHandled = false;
      const hasImages = !!(slide.images && slide.images.length > 0);
      if (slide.layout && !hasImages) {
        addFooter(s, false);
        if (renderSemanticLayout(s as unknown as Parameters<typeof renderSemanticLayout>[0], slide)) {
          semanticHandled = true;
        }
      }

      if (semanticHandled) {
        // Editor elements overlay on this AI slide
        const aiEditorIdx = 1000 + aiIdx;
        const els = slideElements?.[aiEditorIdx];
        if (els && els.length > 0) addSlideElements(s, els, LAYOUT.width, LAYOUT.height);

        // Dropped blocks targeting this AI slide
        if (droppedBlocks) {
          for (const block of droppedBlocks) {
            let isThisAiSlide = false;
            if (block.kind === "ai" && block.localIdx === aiIdx) isThisAiSlide = true;
            else if (!block.kind && block.slideIndex === STANDARD_SLIDE_COUNT + (customSlides?.length ?? 0) + aiIdx) isThisAiSlide = true;
            if (isThisAiSlide) {
              addDroppedBlock(s, block, blockStyles?.[block.id], LAYOUT.width, LAYOUT.height);
            }
          }
        }
        continue;
      }

      const barColor = slide.type === "recommendation" ? IA.violet : IA.blue;
      addBar(s, barColor);
      addFooter(s, false);

      // Title
      s.addText(slide.title, {
        x: LAYOUT.marginX + 0.3, y: 0.25, w: 11, h: 0.5,
        fontSize: SIZES.titleMain, bold: true, color: c(IA.textBlack),
        fontFace: FONTS.title,
      });
      if (slide.subtitle) {
        s.addText(slide.subtitle, {
          x: LAYOUT.marginX + 0.3, y: 0.75, w: 11, h: 0.3,
          fontSize: SIZES.subtitle, color: c(IA.textCaption),
          fontFace: FONTS.body, italic: true,
        });
      }

      // KPIs as cards in a row
      if (slide.kpis && slide.kpis.length > 0) {
        const kpiCount = Math.min(slide.kpis.length, 4);
        const kpiW = 11.5 / kpiCount;
        slide.kpis.slice(0, 4).forEach((kpi, ki) => {
          const xPos = LAYOUT.marginX + 0.3 + ki * kpiW;
          s.addShape("rect", {
            x: xPos, y: 1.15, w: kpiW - 0.15, h: 0.85,
            fill: { color: "F5F7FA" }, line: { color: "E8EDF3", width: 1 },
            rectRadius: 0.06,
          });
          s.addText(kpi.label.toUpperCase(), {
            x: xPos + 0.1, y: 1.2, w: kpiW - 0.35, h: 0.2,
            fontSize: 7, bold: true, color: "8A9BB5",
            fontFace: FONTS.body,
          });
          s.addText(kpi.value, {
            x: xPos + 0.1, y: 1.4, w: kpiW - 0.35, h: 0.35,
            fontSize: 18, bold: true, color: c(IA.blue),
            fontFace: FONTS.title,
          });
          if (kpi.delta) {
            const deltaColor = kpi.trend === "up" ? "0B8043" : kpi.trend === "down" ? "C53929" : "999999";
            const arrow = kpi.trend === "up" ? "▲ " : kpi.trend === "down" ? "▼ " : "";
            s.addText(`${arrow}${kpi.delta}`, {
              x: xPos + 0.1, y: 1.75, w: kpiW - 0.35, h: 0.2,
              fontSize: 7, bold: true, color: deltaColor,
              fontFace: FONTS.body,
            });
          }
        });
      }

      let yPos = slide.kpis && slide.kpis.length > 0 ? 2.15 : 1.15;

      // Table
      if (slide.table) {
        const tbl = slide.table;
        const rows: Array<Array<{ text: string; options: Record<string, unknown> }>> = [];
        // Header row
        rows.push(tbl.headers.map((h, hi) => ({
          text: h,
          options: {
            bold: true, color: "FFFFFF", fill: { color: c(IA.blue) },
            fontSize: 8, fontFace: FONTS.body,
            align: hi === 0 ? "left" : "right",
          },
        })));
        // Data rows
        tbl.rows.forEach((row, ri) => {
          rows.push(row.cells.map((cell, ci) => ({
            text: cell,
            options: {
              bold: row.isHeader || false,
              color: cell.startsWith("+") ? "0B8043" : cell.startsWith("-") ? "C53929" : ci === 0 ? "333333" : c(IA.blue),
              fill: { color: row.highlight ? "EFF6FF" : ri % 2 === 0 ? "FAFBFD" : "FFFFFF" },
              fontSize: 8, fontFace: ci > 0 ? FONTS.title : FONTS.body,
              align: ci === 0 ? "left" : "right",
            },
          })));
        });
        s.addTable(rows, {
          x: LAYOUT.marginX + 0.3, y: yPos, w: 11.5,
          border: { type: "solid", pt: 0.5, color: "E8EDF3" },
          colW: Array(tbl.headers.length).fill(11.5 / tbl.headers.length),
          rowH: 0.3,
        });
        yPos += (rows.length * 0.3) + 0.2;
      }

      // Chart (basic horizontal bar) — was only in the dead exportAiSlidesToPptx
      if (slide.chart) {
        const entries = Object.entries(slide.chart.data).filter(([, v]) => typeof v === "number") as [string, number][];
        if (entries.length > 0) {
          const max = Math.max(...entries.map(([, v]) => v));
          const barH = 0.28;
          const barTrackW = 8.5;
          entries.forEach(([label, value], i) => {
            const y = yPos + i * (barH + 0.08);
            const pct = max > 0 ? (value / max) * barTrackW : 0;
            s.addText(label, {
              x: LAYOUT.marginX + 0.3, y, w: 2.2, h: barH,
              fontSize: 8, color: "333333", fontFace: FONTS.body, align: "right", valign: "middle",
            });
            s.addShape("rect", {
              x: LAYOUT.marginX + 2.7, y: y + barH * 0.2, w: barTrackW, h: barH * 0.6,
              fill: { color: "F0F4F8" }, line: { width: 0 }, rectRadius: 0.03,
            });
            s.addShape("rect", {
              x: LAYOUT.marginX + 2.7, y: y + barH * 0.2, w: pct, h: barH * 0.6,
              fill: { color: c(IA.blue) }, line: { width: 0 }, rectRadius: 0.03,
            });
            s.addText(typeof value === "number" ? value.toLocaleString("fr-FR") : String(value), {
              x: LAYOUT.marginX + 11.4, y, w: 1.5, h: barH,
              fontSize: 8, bold: true, color: c(IA.blueDeep), fontFace: FONTS.title, align: "right", valign: "middle",
            });
          });
          yPos += entries.length * (barH + 0.08) + 0.15;
        }
      }

      // Creative images (thumbnails) — was missing from export
      if (slide.images && slide.images.length > 0) {
        const imgs = slide.images.slice(0, 3);
        const totalW = 11.5;
        const gap = 0.2;
        const imgW = (totalW - gap * (imgs.length - 1)) / imgs.length;
        const imgH = Math.min(2.4, LAYOUT.height - yPos - 1.5);
        for (let ii = 0; ii < imgs.length; ii++) {
          const img = imgs[ii];
          const x = LAYOUT.marginX + 0.3 + ii * (imgW + gap);
          // Background card
          s.addShape("rect", {
            x, y: yPos, w: imgW, h: imgH,
            fill: { color: "F5F7FA" }, line: { color: "E8EDF3", width: 0.5 },
            rectRadius: 0.04,
          });
          // Image — pptxgenjs accepts URLs but external fetches fail; if we
          // have a thumbnailDataMap entry use that
          const dataUrl = thumbnailDataMap[img.url];
          if (dataUrl) {
            s.addImage({ data: dataUrl, x: x + 0.05, y: yPos + 0.05, w: imgW - 0.1, h: imgH - 0.5 });
          } else {
            s.addText(img.label || "Image", {
              x: x + 0.05, y: yPos + 0.05, w: imgW - 0.1, h: imgH - 0.5,
              fontSize: 9, color: "8A9BB5", fontFace: FONTS.body,
              align: "center", valign: "middle", italic: true,
            });
          }
          if (img.label) {
            s.addText(img.label, {
              x: x + 0.05, y: yPos + imgH - 0.4, w: imgW - 0.1, h: 0.2,
              fontSize: 8, bold: true, color: c(IA.textBlack), fontFace: FONTS.body, align: "left",
            });
          }
          if (img.metrics) {
            s.addText(img.metrics, {
              x: x + 0.05, y: yPos + imgH - 0.2, w: imgW - 0.1, h: 0.18,
              fontSize: 7, color: c(IA.textCaption), fontFace: FONTS.body, align: "left",
            });
          }
        }
        yPos += imgH + 0.2;
      }

      // Insights — auto-scale font when many items or limited space
      if (slide.insights && slide.insights.length > 0) {
        // Section divider line
        s.addText("// ANALYSE", {
          x: LAYOUT.marginX + 0.3, y: yPos, w: 3, h: 0.25,
          fontSize: 8, bold: true, color: c(IA.blue), fontFace: FONTS.body,
        });
        s.addShape("rect", {
          x: LAYOUT.marginX + 2.2, y: yPos + 0.12, w: 9.6, h: 0.015,
          fill: { color: c(IA.blue) }, line: { width: 0 },
        });
        yPos += 0.35;

        const remainingH = LAYOUT.height - yPos - 1.0; // leave room for recommendation + footer
        const insightCount = slide.insights.length;
        const rowH = Math.min(0.32, remainingH / insightCount);
        const insightFontSize = insightCount > 4 || rowH < 0.25 ? 7 : 9;

        slide.insights.forEach((insight, ii) => {
          s.addShape("ellipse", {
            x: LAYOUT.marginX + 0.3, y: yPos + 0.03, w: 0.18, h: 0.18,
            fill: { color: c(IA.blue) },
          });
          s.addText(String(ii + 1), {
            x: LAYOUT.marginX + 0.3, y: yPos + 0.03, w: 0.18, h: 0.18,
            fontSize: Math.min(7, insightFontSize), bold: true, color: "FFFFFF", align: "center", valign: "middle",
            fontFace: FONTS.body,
          });
          s.addText(insight, {
            x: LAYOUT.marginX + 0.6, y: yPos, w: 11.2, h: rowH,
            fontSize: insightFontSize, color: "333333", fontFace: FONTS.body,
            valign: "middle", wrap: true, shrinkText: true,
          });
          yPos += rowH;
        });
      }

      // Recommendation
      if (slide.recommendation) {
        s.addShape("rect", {
          x: LAYOUT.marginX + 0.3, y: yPos + 0.1, w: 11.5, h: 0.4,
          fill: { color: "EFF6FF" },
          line: { color: c(IA.blue), width: 0.5 },
          rectRadius: 0.04,
        });
        s.addText(`➜ ${slide.recommendation}`, {
          x: LAYOUT.marginX + 0.5, y: yPos + 0.1, w: 11.1, h: 0.4,
          fontSize: 9, bold: true, color: c(IA.blue), fontFace: FONTS.body,
          valign: "middle", wrap: true, shrinkText: true,
        });
      }

      // Editor elements overlay on this AI slide
      const aiEditorIdx = 1000 + aiIdx;
      const els = slideElements?.[aiEditorIdx];
      if (els && els.length > 0) addSlideElements(s, els, LAYOUT.width, LAYOUT.height);

      // Dropped blocks targeting this AI slide — match by kind+localIdx.
      // Legacy fallback: absolute slideIndex was STANDARD_SLIDE_COUNT + customs + aiIdx,
      // but that only worked when the page slide count matched the export count.
      if (droppedBlocks) {
        for (const block of droppedBlocks) {
          let isThisAiSlide = false;
          if (block.kind === "ai" && block.localIdx === aiIdx) isThisAiSlide = true;
          else if (!block.kind && block.slideIndex === STANDARD_SLIDE_COUNT + (customSlides?.length ?? 0) + aiIdx) isThisAiSlide = true;
          if (isThisAiSlide) {
            addDroppedBlock(s, block, blockStyles?.[block.id], LAYOUT.width, LAYOUT.height);
          }
        }
      }
    }
  }

  // Return as Blob — caller handles download
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = await (pptx as any).write({ outputType: "blob" }) as Blob;
  return blob;
}

// ── Export AI Dynamic Slides to PPTX ────────────────────────────────────────

export async function exportAiSlidesToPptx(
  slides: import("@/types/deck").SlideData[],
  title?: string,
): Promise<Blob> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();

  pptx.author = "Impulse Analytics";
  pptx.title = title ?? "AI Performance Deck";
  pptx.layout = "LAYOUT_WIDE";

  const severityBg: Record<string, string> = {
    alert: "FFF0F0",
    warning: "FFFBEA",
    ok: "F0FFF4",
  };
  const severityBorder: Record<string, string> = {
    alert: "C53929",
    warning: "F9A825",
    ok: "0B8043",
  };

  // Pre-fetch any creative images
  const allImages = slides.flatMap(s => s.images ?? []);
  const imageDataMap: Record<string, string> = {};
  await Promise.all(
    allImages.filter(img => img.url).map(async (img) => {
      try {
        const res = await fetch(`/api/deck/proxy-image?url=${encodeURIComponent(img.url)}&format=base64`, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const json = await res.json() as { dataUrl?: string };
          if (json.dataUrl) imageDataMap[img.url] = json.dataUrl;
        }
      } catch { /* skip */ }
    })
  );

  const { renderSemanticLayout } = await import("./deck-pptx-layouts");

  for (const slide of slides) {
    const s = pptx.addSlide();

    // Semantic layout dispatch: when the AI tags the slide with `layout`,
    // delegate to the dedicated renderer and skip the generic stacking path.
    if (slide.layout) {
      s.background = { color: c(IA.bgWhite) };
      addFooter(s, false);
      if (renderSemanticLayout(s as unknown as Parameters<typeof renderSemanticLayout>[0], slide)) {
        continue;
      }
    }

    const isAlert = slide.severity === "alert" || slide.type === "alert";
    const bgColor = slide.severity && severityBg[slide.severity] ? severityBg[slide.severity] : c(IA.bgWhite);
    s.background = { color: bgColor };

    // Left accent bar
    const barColor = slide.type === "recommendation" ? IA.violet : IA.blue;
    addBar(s, barColor);
    addFooter(s, false);

    // Severity left border
    if (slide.severity && severityBorder[slide.severity]) {
      s.addShape("rect", {
        x: LAYOUT.barWidth, y: 0, w: 0.04, h: LAYOUT.height,
        fill: { color: severityBorder[slide.severity] }, line: { width: 0 },
      });
    }

    // Title
    const titlePrefix = isAlert ? "⚠️ " : slide.type === "recommendation" ? "💡 " : "";
    s.addText(`${titlePrefix}${slide.title}`, {
      x: LAYOUT.marginX + 0.3, y: 0.25, w: 10, h: 0.6,
      fontSize: SIZES.titleMain, bold: true, color: c(IA.blueDark), fontFace: FONTS.title,
    });

    // Severity badge
    if (slide.severity && slide.severity !== "ok") {
      s.addShape("roundRect", {
        x: 11, y: 0.3, w: 1.2, h: 0.35,
        fill: { color: severityBorder[slide.severity] }, line: { width: 0 }, rectRadius: 0.06,
      });
      s.addText(slide.severity.toUpperCase(), {
        x: 11, y: 0.3, w: 1.2, h: 0.35,
        fontSize: 8, bold: true, color: c(IA.textWhite), fontFace: FONTS.body, align: "center",
      });
    }

    // Subtitle
    if (slide.subtitle) {
      s.addText(slide.subtitle, {
        x: LAYOUT.marginX + 0.3, y: 0.85, w: 11, h: 0.3,
        fontSize: 10, italic: true, color: c(IA.textCaption), fontFace: FONTS.body,
      });
    }

    // Divider
    s.addShape("rect", {
      x: LAYOUT.marginX + 0.3, y: 1.15, w: 12, h: 0.015,
      fill: { color: c(IA.textCaption) }, line: { width: 0 },
    });

    let yPos = 1.35;

    // KPIs
    if (slide.kpis && slide.kpis.length > 0) {
      const kpiCount = Math.min(slide.kpis.length, 4);
      const kpiW = 2.8;
      const kpiGap = 0.25;
      const kpiStartX = (LAYOUT.width - (kpiCount * kpiW + (kpiCount - 1) * kpiGap)) / 2;

      slide.kpis.slice(0, 4).forEach((kpi, i) => {
        const x = kpiStartX + i * (kpiW + kpiGap);
        s.addShape("roundRect", {
          x, y: yPos, w: kpiW, h: 1.5,
          fill: { color: c(IA.bgAlt) }, line: { width: 0 }, rectRadius: 0.08,
        });
        s.addText(kpi.label, {
          x, y: yPos + 0.15, w: kpiW, h: 0.25,
          fontSize: 8, color: c(IA.textCaption), fontFace: FONTS.body, align: "center",
        });
        s.addText(kpi.value, {
          x, y: yPos + 0.45, w: kpiW, h: 0.6,
          fontSize: 22, bold: true, color: c(IA.blueDark), fontFace: FONTS.kpi, align: "center",
        });
        if (kpi.delta) {
          const trendColor = kpi.trend === "up" ? c(IA.deltaPos) : kpi.trend === "down" ? c(IA.deltaNeg) : c(IA.textCaption);
          const arrow = kpi.trend === "up" ? "▲ " : kpi.trend === "down" ? "▼ " : "";
          s.addText(`${arrow}${kpi.delta}`, {
            x, y: yPos + 1.05, w: kpiW, h: 0.3,
            fontSize: 9, bold: true, color: trendColor, fontFace: FONTS.body, align: "center",
          });
        }
      });
      yPos += 1.7;
    }

    // Images (creatives)
    if (slide.images && slide.images.length > 0) {
      const imgCount = Math.min(slide.images.length, 3);
      const imgW = 3.0;
      const imgH = 2.2;
      const imgGap = 0.3;
      const imgStartX = (LAYOUT.width - (imgCount * imgW + (imgCount - 1) * imgGap)) / 2;

      slide.images.slice(0, 3).forEach((img, i) => {
        const x = imgStartX + i * (imgW + imgGap);
        s.addShape("roundRect", {
          x, y: yPos, w: imgW, h: imgH,
          fill: { color: c(IA.bgAlt) }, line: { width: 0 }, rectRadius: 0.08,
        });
        const dataUrl = imageDataMap[img.url];
        if (dataUrl) {
          try {
            s.addImage({ data: dataUrl, x: x + 0.1, y: yPos + 0.1, w: imgW - 0.2, h: imgH - 0.8, sizing: { type: "cover", w: imgW - 0.2, h: imgH - 0.8 } });
          } catch { /* skip */ }
        }
        if (img.label) {
          s.addText(img.label, {
            x: x + 0.1, y: yPos + imgH - 0.65, w: imgW - 0.2, h: 0.25,
            fontSize: 7, bold: true, color: c(IA.textBlack), fontFace: FONTS.body,
          });
        }
        if (img.metrics) {
          s.addText(img.metrics, {
            x: x + 0.1, y: yPos + imgH - 0.4, w: imgW - 0.2, h: 0.3,
            fontSize: 7, color: c(IA.textCaption), fontFace: FONTS.body,
          });
        }
      });
      yPos += 2.4;
    }

    // Chart (basic bar)
    if (slide.chart) {
      const entries = Object.entries(slide.chart.data).filter(([, v]) => typeof v === "number") as [string, number][];
      if (entries.length > 0) {
        const max = Math.max(...entries.map(([, v]) => v));
        const barH = 0.3;
        entries.forEach(([label, value], i) => {
          const y = yPos + i * (barH + 0.1);
          const pct = max > 0 ? (value / max) * 8 : 0;
          s.addText(label, {
            x: LAYOUT.marginX + 0.3, y, w: 2, h: barH,
            fontSize: 8, color: c(IA.textBlack), fontFace: FONTS.body, align: "right",
          });
          s.addShape("rect", {
            x: LAYOUT.marginX + 2.5, y, w: 8, h: barH,
            fill: { color: c(IA.bgRowAlt) }, line: { width: 0 },
          });
          s.addShape("rect", {
            x: LAYOUT.marginX + 2.5, y, w: pct, h: barH,
            fill: { color: c(IA.blue) }, line: { width: 0 },
          });
          s.addText(value.toLocaleString(), {
            x: LAYOUT.marginX + 10.8, y, w: 1.5, h: barH,
            fontSize: 8, bold: true, color: c(IA.textBlack), fontFace: FONTS.body, align: "right",
          });
        });
        yPos += entries.length * (barH + 0.1) + 0.2;
      }
    }

    // Insights — auto-scale font when many items or limited space
    if (slide.insights && slide.insights.length > 0) {
      const remainingH = LAYOUT.height - yPos - 1.0;
      const insightCount = slide.insights.length;
      const rowH = Math.min(0.45, remainingH / insightCount);
      const insightFontSize = insightCount > 4 || rowH < 0.35 ? 7 : 9;
      slide.insights.forEach((insight, i) => {
        s.addText(`• ${insight}`, {
          x: LAYOUT.marginX + 0.5, y: yPos + i * rowH, w: 11, h: rowH,
          fontSize: insightFontSize, color: c(IA.textBlack), fontFace: FONTS.body, valign: "top",
          shrinkText: true,
        });
      });
      yPos += insightCount * rowH + 0.1;
    }

    // Recommendation
    if (slide.recommendation) {
      s.addShape("roundRect", {
        x: LAYOUT.marginX + 0.3, y: yPos, w: 12, h: 0.7,
        fill: { color: "EFF6FF" }, line: { color: c(IA.blue), width: 1 }, rectRadius: 0.06,
      });
      s.addText(`➜ ${slide.recommendation}`, {
        x: LAYOUT.marginX + 0.5, y: yPos, w: 11.5, h: 0.7,
        fontSize: 9, bold: true, color: c(IA.blueDark), fontFace: FONTS.body, valign: "middle",
        shrinkText: true,
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = await (pptx as any).write({ outputType: "blob" }) as Blob;
  return blob;
}
