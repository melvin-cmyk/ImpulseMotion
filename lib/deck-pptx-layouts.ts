/**
 * Semantic PPTX layouts for AI-generated slides.
 *
 * Each renderer takes a pptxgenjs Slide (already added to the presentation)
 * plus a SlideData and draws a full layout using the Impulse Analytics DA
 * tokens from `impulse-theme.ts`. Called from `exportAiSlidesToPptx` when
 * `slide.layout` is set.
 */

import { IA, FONTS, SIZES, LAYOUT } from "./impulse-theme";
import type { SlideData, SlideLayout } from "@/types/deck";

type PptxSlide = {
  addText: (...args: unknown[]) => unknown;
  addShape: (...args: unknown[]) => unknown;
};

const c = (hex: string) => hex.replace("#", "");
const W = LAYOUT.width;
const H = LAYOUT.height;
const SHADOW = {
  type: "outer" as const,
  blur: 8,
  offset: 2,
  angle: 45,
  color: "C5CDD8",
  opacity: 0.3,
};

function drawHeader(slide: PptxSlide, title: string, subtitle?: string) {
  slide.addShape("rect", {
    x: 0,
    y: 0,
    w: 0.12,
    h: H,
    fill: { color: c(IA.blue) },
    line: { width: 0 },
  });
  slide.addText(title, {
    x: LAYOUT.marginX + 0.2,
    y: 0.3,
    w: W - LAYOUT.marginX * 2 - 0.4,
    h: 0.7,
    fontFace: FONTS.title,
    fontSize: SIZES.titleMain,
    bold: true,
    color: c(IA.blueDark),
    align: "left",
    margin: 0,
  });
  slide.addShape("line", {
    x: LAYOUT.marginX + 0.2,
    y: subtitle ? 1.4 : 1.05,
    w: W - LAYOUT.marginX * 2 - 0.4,
    h: 0,
    line: { color: c(IA.textCaption), width: 0.75 },
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: LAYOUT.marginX + 0.2,
      y: 1.0,
      w: W - LAYOUT.marginX * 2 - 0.4,
      h: 0.35,
      fontFace: FONTS.body,
      fontSize: 12,
      italic: true,
      color: c(IA.textCaption),
      margin: 0,
    });
  }
}

function drawCard(
  slide: PptxSlide,
  x: number,
  y: number,
  w: number,
  h: number,
  fill = IA.bgAlt,
) {
  slide.addShape("roundRect", {
    x,
    y,
    w,
    h,
    rectRadius: 0.1,
    fill: { color: c(fill) },
    line: { color: c(IA.bgRowAlt), width: 0.75 },
    shadow: SHADOW,
  });
}

function drawCircle(slide: PptxSlide, x: number, y: number, size: number, color: string) {
  slide.addShape("ellipse", {
    x,
    y,
    w: size,
    h: size,
    fill: { color: c(color) },
    line: { width: 0 },
  });
}

const CONTENT_Y = 1.6;
const CONTENT_H = H - CONTENT_Y - 0.6;

// ── Layouts ────────────────────────────────────────────────────────────────

function renderKpi(slide: PptxSlide, data: SlideData) {
  drawHeader(slide, data.title, data.subtitle);
  const kpis = (data.kpis ?? []).slice(0, 4);
  if (kpis.length === 0) return;
  const count = kpis.length;
  const gap = 0.25;
  const cardW = (W - LAYOUT.marginX * 2 - 0.4 - gap * (count - 1)) / count;
  kpis.forEach((kpi, i) => {
    const cx = LAYOUT.marginX + 0.2 + i * (cardW + gap);
    drawCard(slide, cx, CONTENT_Y, cardW, 3.5);
    const col = i % 2 === 0 ? IA.blueDeep : IA.violet;
    slide.addText(kpi.value, {
      x: cx,
      y: CONTENT_Y + 0.6,
      w: cardW,
      h: 1.2,
      fontFace: FONTS.kpi,
      fontSize: 36,
      bold: true,
      color: c(col),
      align: "center",
      margin: 0,
    });
    slide.addText(kpi.label, {
      x: cx + 0.1,
      y: CONTENT_Y + 1.9,
      w: cardW - 0.2,
      h: 0.6,
      fontFace: FONTS.body,
      fontSize: 12,
      color: c(IA.textBlack),
      align: "center",
      margin: 0,
    });
    if (kpi.delta) {
      const trendColor =
        kpi.trend === "up"
          ? IA.deltaPos
          : kpi.trend === "down"
            ? IA.deltaNeg
            : IA.textCaption;
      const arrow = kpi.trend === "up" ? "▲ " : kpi.trend === "down" ? "▼ " : "";
      slide.addText(`${arrow}${kpi.delta}`, {
        x: cx,
        y: CONTENT_Y + 2.6,
        w: cardW,
        h: 0.4,
        fontFace: FONTS.body,
        fontSize: 11,
        bold: true,
        color: c(trendColor),
        align: "center",
        margin: 0,
      });
    }
  });
}

function renderCards(slide: PptxSlide, data: SlideData) {
  drawHeader(slide, data.title, data.subtitle);
  const cards = (data.cards ?? []).slice(0, 4);
  if (cards.length === 0) return;
  const count = cards.length;
  const gap = 0.25;
  const cardW = (W - LAYOUT.marginX * 2 - 0.4 - gap * (count - 1)) / count;
  const palette = [IA.blue, IA.blueDeep, IA.violet, IA.violetAlt];
  cards.forEach((card, i) => {
    const cx = LAYOUT.marginX + 0.2 + i * (cardW + gap);
    drawCard(slide, cx, CONTENT_Y, cardW, CONTENT_H);
    drawCircle(slide, cx + 0.3, CONTENT_Y + 0.3, 0.55, palette[i % palette.length]);
    slide.addText(card.title, {
      x: cx + 0.15,
      y: CONTENT_Y + 1.05,
      w: cardW - 0.3,
      h: 0.55,
      fontFace: FONTS.title,
      fontSize: 14,
      bold: true,
      color: c(IA.textBlack),
      margin: 0,
    });
    slide.addText(card.body, {
      x: cx + 0.15,
      y: CONTENT_Y + 1.65,
      w: cardW - 0.3,
      h: CONTENT_H - 1.8,
      fontFace: FONTS.body,
      fontSize: 11,
      color: c(IA.textBlack),
      valign: "top",
      margin: 0,
      shrinkText: true,
    });
  });
}

function renderSteps(slide: PptxSlide, data: SlideData) {
  drawHeader(slide, data.title, data.subtitle);
  const steps = (data.steps ?? []).slice(0, 5);
  if (steps.length === 0) return;
  const gap = 0.15;
  const rowH = (CONTENT_H - gap * (steps.length - 1)) / steps.length;
  steps.forEach((step, i) => {
    const cy = CONTENT_Y + i * (rowH + gap);
    const col = i % 2 === 0 ? IA.blueDeep : IA.violet;
    if (i % 2 === 0) {
      slide.addShape("roundRect", {
        x: LAYOUT.marginX + 0.2,
        y: cy,
        w: W - LAYOUT.marginX * 2 - 0.4,
        h: rowH,
        rectRadius: 0.08,
        fill: { color: c(IA.bgAlt) },
        line: { color: c(IA.bgRowAlt), width: 0.5 },
      });
    }
    const circleSize = 0.5;
    const circleX = LAYOUT.marginX + 0.3;
    const circleY = cy + rowH / 2 - circleSize / 2;
    drawCircle(slide, circleX, circleY, circleSize, col);
    slide.addText(String(i + 1), {
      x: circleX,
      y: circleY,
      w: circleSize,
      h: circleSize,
      fontFace: FONTS.title,
      fontSize: 14,
      bold: true,
      color: c(IA.textWhite),
      align: "center",
      valign: "middle",
      margin: 0,
    });
    const textX = circleX + circleSize + 0.2;
    const kpiW = step.kpi ? 2.0 : 0;
    slide.addText(step.title, {
      x: textX,
      y: cy + 0.1,
      w: W - textX - LAYOUT.marginX - 0.2 - kpiW,
      h: 0.4,
      fontFace: FONTS.title,
      fontSize: 13,
      bold: true,
      color: c(IA.textBlack),
      margin: 0,
    });
    if (step.body) {
      slide.addText(step.body, {
        x: textX,
        y: cy + 0.5,
        w: W - textX - LAYOUT.marginX - 0.2 - kpiW,
        h: rowH - 0.55,
        fontFace: FONTS.body,
        fontSize: 11,
        color: c(IA.textBlack),
        valign: "top",
        margin: 0,
        shrinkText: true,
      });
    }
    if (step.kpi) {
      slide.addText(step.kpi, {
        x: W - LAYOUT.marginX - 0.2 - kpiW,
        y: cy + 0.1,
        w: kpiW,
        h: rowH - 0.2,
        fontFace: FONTS.kpi,
        fontSize: 18,
        bold: true,
        color: c(col),
        align: "center",
        valign: "middle",
        margin: 0,
      });
    }
  });
}

function renderComparative(slide: PptxSlide, data: SlideData) {
  drawHeader(slide, data.title, data.subtitle);
  const left = data.comparativeLeft;
  const right = data.comparativeRight;
  if (!left || !right) return;
  const gap = 0.3;
  const colW = (W - LAYOUT.marginX * 2 - 0.4 - gap) / 2;
  const cols: Array<[typeof left, number, string]> = [
    [left, LAYOUT.marginX + 0.2, IA.blueDeep],
    [right, LAYOUT.marginX + 0.2 + colW + gap, IA.violet],
  ];
  cols.forEach(([col, cx, color]) => {
    slide.addShape("roundRect", {
      x: cx,
      y: CONTENT_Y,
      w: colW,
      h: 0.6,
      rectRadius: 0.08,
      fill: { color: c(color) },
      line: { width: 0 },
    });
    slide.addText(col.header, {
      x: cx + 0.1,
      y: CONTENT_Y,
      w: colW - 0.2,
      h: 0.6,
      fontFace: FONTS.title,
      fontSize: 14,
      bold: true,
      color: c(IA.textWhite),
      align: "center",
      valign: "middle",
      margin: 0,
    });
    drawCard(slide, cx, CONTENT_Y + 0.7, colW, CONTENT_H - 0.7);
    const items = col.items.slice(0, 8);
    const rowH = (CONTENT_H - 1.0) / Math.max(items.length, 1);
    items.forEach((item, j) => {
      slide.addText(
        [
          { text: "›  ", options: { bold: true, color: c(color) } },
          { text: item, options: { color: c(IA.textBlack) } },
        ],
        {
          x: cx + 0.2,
          y: CONTENT_Y + 0.85 + j * rowH,
          w: colW - 0.4,
          h: rowH,
          fontFace: FONTS.body,
          fontSize: 12,
          valign: "top",
          margin: 0,
          shrinkText: true,
        },
      );
    });
  });
}

function renderNextSteps(slide: PptxSlide, data: SlideData) {
  drawHeader(slide, data.title, data.subtitle);
  const items = (data.actions ?? []).slice(0, 6);
  if (items.length === 0) return;
  const gap = 0.15;
  const rowH = Math.min(1.0, (CONTENT_H - gap * (items.length - 1)) / items.length);
  items.forEach((item, i) => {
    const cy = CONTENT_Y + i * (rowH + gap);
    const col = i % 2 === 0 ? IA.blueDeep : IA.violet;
    slide.addShape("rect", {
      x: LAYOUT.marginX + 0.2,
      y: cy + 0.1,
      w: 0.18,
      h: 0.3,
      fill: { color: c(col) },
      line: { width: 0 },
    });
    const ownerW = item.owner ? 2.2 : 0;
    slide.addText(item.label, {
      x: LAYOUT.marginX + 0.55,
      y: cy,
      w: W - LAYOUT.marginX * 2 - 1.0 - ownerW,
      h: 0.4,
      fontFace: FONTS.title,
      fontSize: 13,
      bold: true,
      color: c(IA.textBlack),
      margin: 0,
    });
    if (item.desc) {
      slide.addText(item.desc, {
        x: LAYOUT.marginX + 0.55,
        y: cy + 0.4,
        w: W - LAYOUT.marginX * 2 - 1.0 - ownerW,
        h: rowH - 0.45,
        fontFace: FONTS.body,
        fontSize: 11,
        color: c(IA.textBlack),
        valign: "top",
        margin: 0,
        shrinkText: true,
      });
    }
    if (item.owner) {
      slide.addText(item.owner, {
        x: W - LAYOUT.marginX - 0.2 - ownerW,
        y: cy + 0.1,
        w: ownerW,
        h: 0.35,
        fontFace: FONTS.body,
        fontSize: 10,
        bold: true,
        color: c(col),
        align: "right",
        margin: 0,
      });
    }
    if (i < items.length - 1) {
      slide.addShape("line", {
        x: LAYOUT.marginX + 0.2,
        y: cy + rowH + gap / 2,
        w: W - LAYOUT.marginX * 2 - 0.4,
        h: 0,
        line: { color: c(IA.bgRowAlt), width: 0.5 },
      });
    }
  });
}

function renderMatrix(slide: PptxSlide, data: SlideData) {
  drawHeader(slide, data.title, data.subtitle);
  const m = data.matrix;
  if (!m || !m.quadrants || m.quadrants.length < 4) return;
  const quads = m.quadrants.slice(0, 4);
  const gap = 0.2;
  const zoneX = LAYOUT.marginX + 0.2;
  const zoneW = W - LAYOUT.marginX * 2 - 0.4;
  const zoneH = CONTENT_H;
  const cellW = (zoneW - gap) / 2;
  const cellH = (zoneH - gap) / 2;
  const palette = [IA.blue, IA.violet, IA.violetAlt, IA.blueDeep];
  quads.forEach((q, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = zoneX + col * (cellW + gap);
    const cy = CONTENT_Y + row * (cellH + gap);
    const accent = palette[i % palette.length];
    drawCard(slide, cx, cy, cellW, cellH);
    slide.addShape("rect", {
      x: cx,
      y: cy,
      w: 0.12,
      h: cellH,
      fill: { color: c(accent) },
      line: { width: 0 },
    });
    slide.addText(q.title, {
      x: cx + 0.25,
      y: cy + 0.15,
      w: cellW - 0.4,
      h: 0.45,
      fontFace: FONTS.title,
      fontSize: 13,
      bold: true,
      color: c(accent),
      margin: 0,
    });
    const items = q.items ?? (q.body ? [q.body] : []);
    if (items.length > 0) {
      slide.addText(
        items.map((it) => ({
          text: it,
          options: { bullet: { code: "25AA" }, color: c(IA.textBlack) },
        })),
        {
          x: cx + 0.25,
          y: cy + 0.65,
          w: cellW - 0.4,
          h: cellH - 0.8,
          fontFace: FONTS.body,
          fontSize: 11,
          color: c(IA.textBlack),
          valign: "top",
          margin: 0,
          shrinkText: true,
          paraSpaceAfter: 4,
        },
      );
    }
  });
  if (m.xLabel) {
    slide.addText(m.xLabel, {
      x: zoneX,
      y: CONTENT_Y + zoneH + 0.05,
      w: zoneW,
      h: 0.3,
      fontFace: FONTS.body,
      fontSize: 10,
      italic: true,
      color: c(IA.textCaption),
      align: "center",
      margin: 0,
    });
  }
  if (m.yLabel) {
    // Rotated 270°: pptxgenjs rotates around the bbox center. Size the bbox
    // square-ish so the rotated text sits just left of the matrix.
    const yLabelW = 1.5;
    const yLabelH = 0.3;
    slide.addText(m.yLabel, {
      x: zoneX - yLabelW / 2 - 0.25,
      y: CONTENT_Y + zoneH / 2 - yLabelH / 2,
      w: yLabelW,
      h: yLabelH,
      fontFace: FONTS.body,
      fontSize: 10,
      italic: true,
      color: c(IA.textCaption),
      align: "center",
      rotate: 270,
      margin: 0,
    });
  }
}

function renderFunnel(slide: PptxSlide, data: SlideData) {
  drawHeader(slide, data.title, data.subtitle);
  const stages = (data.funnel ?? []).slice(0, 6);
  if (stages.length === 0) return;
  const zoneX = LAYOUT.marginX + 0.2;
  const zoneW = W - LAYOUT.marginX * 2 - 0.4;
  const leftW = zoneW * 0.55;
  const rightX = zoneX + leftW + 0.3;
  const rightW = zoneW - leftW - 0.3;
  const gap = 0.12;
  const barH = (CONTENT_H - gap * (stages.length - 1)) / stages.length;
  const maxW = leftW;
  const minW = leftW * 0.35;
  const palette = [IA.blue, IA.blueDeep, IA.violetAlt, IA.violet, IA.blueDark, IA.textCaption];
  stages.forEach((stage, i) => {
    const t = stages.length === 1 ? 0 : i / (stages.length - 1);
    const w = maxW - (maxW - minW) * t;
    const x = zoneX + (maxW - w) / 2;
    const y = CONTENT_Y + i * (barH + gap);
    const accent = palette[i % palette.length];
    slide.addShape("roundRect", {
      x,
      y,
      w,
      h: barH,
      rectRadius: 0.08,
      fill: { color: c(accent) },
      line: { width: 0 },
      shadow: SHADOW,
    });
    slide.addText(stage.label, {
      x,
      y,
      w,
      h: barH,
      fontFace: FONTS.title,
      fontSize: 13,
      bold: true,
      color: c(IA.textWhite),
      align: "center",
      valign: "middle",
      margin: 0,
      shrinkText: true,
    });
    slide.addText(stage.value, {
      x: rightX,
      y,
      w: rightW,
      h: barH * 0.55,
      fontFace: FONTS.kpi,
      fontSize: 22,
      bold: true,
      color: c(accent),
      valign: "bottom",
      margin: 0,
    });
    if (stage.caption) {
      slide.addText(stage.caption, {
        x: rightX,
        y: y + barH * 0.55,
        w: rightW,
        h: barH * 0.45,
        fontFace: FONTS.body,
        fontSize: 10,
        color: c(IA.textBlack),
        valign: "top",
        margin: 0,
        shrinkText: true,
      });
    }
  });
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

const RENDERERS: Record<SlideLayout, (slide: PptxSlide, data: SlideData) => void> = {
  kpi: renderKpi,
  cards: renderCards,
  steps: renderSteps,
  comparative: renderComparative,
  nextSteps: renderNextSteps,
  matrix: renderMatrix,
  funnel: renderFunnel,
};

export function renderSemanticLayout(
  slide: PptxSlide,
  data: SlideData,
): boolean {
  if (!data.layout) return false;
  const fn = RENDERERS[data.layout];
  if (!fn) return false;
  fn(slide, data);
  return true;
}
