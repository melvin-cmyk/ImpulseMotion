/**
 * PPTX Export — Impulse Analytics branded Monthly Business Review.
 * Uses pptxgenjs with the Impulse design system.
 */

import type { Deck, Slide, TableData } from "./deck-store"
import { IA, FONTS, SIZES, LAYOUT, SECTION_BAR, type SectionId } from "./impulse-theme"

// Strip # for pptxgenjs colour values
const c = (hex: string) => hex.replace("#", "")

export async function exportMBR(deck: Deck): Promise<void> {
  const PptxGenJS = (await import("pptxgenjs")).default
  const pptx = new PptxGenJS()

  pptx.author = "Impulse Analytics"
  pptx.title = deck.name
  pptx.layout = "LAYOUT_WIDE" // 13.33 × 7.5

  for (const slide of deck.slides) {
    const pptSlide = pptx.addSlide()
    const section: SectionId = slide.section || "global"
    const barColor = SECTION_BAR[section]

    if (slide.isDark || slide.type === "cover" || slide.type === "section-divider" || slide.type === "learnings") {
      renderDarkSlide(pptSlide, slide, barColor)
    } else {
      renderLightSlide(pptSlide, slide, section, barColor)
    }
  }

  await pptx.writeFile({ fileName: `${deck.name.replace(/\s+/g, "_")}.pptx` })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PptxSlide = any

function addFooter(pptSlide: PptxSlide, isDark: boolean) {
  // Left: "Impulse Analytics."
  pptSlide.addText("Impulse Analytics.", {
    x: LAYOUT.marginX, y: LAYOUT.footerY, w: 3, h: 0.3,
    fontSize: SIZES.caption, bold: true,
    color: isDark ? c(IA.blue) : c(IA.blue),
    fontFace: FONTS.body,
  })
  // Right: source
  pptSlide.addText("Source: Meta Ads / Google Ads", {
    x: LAYOUT.width - 3.5, y: LAYOUT.footerY, w: 3, h: 0.3,
    fontSize: SIZES.caption, italic: true,
    color: c(IA.textCaption),
    fontFace: FONTS.body, align: "right",
  })
}

function addBar(pptSlide: PptxSlide, color: string) {
  pptSlide.addShape("rect", {
    x: 0, y: 0, w: LAYOUT.barWidth, h: LAYOUT.height,
    fill: { color: c(color) },
    line: { width: 0 },
  })
}

function renderDarkSlide(pptSlide: PptxSlide, slide: Slide, barColor: string) {
  pptSlide.background = { color: c(IA.bgDark) }
  addBar(pptSlide, barColor)
  addFooter(pptSlide, true)

  if (slide.type === "cover") {
    pptSlide.addText(slide.title || "", {
      x: LAYOUT.marginX + 0.3, y: 2.2, w: 10, h: 1.5,
      fontSize: 36, bold: true, color: c(IA.textWhite),
      fontFace: FONTS.title,
    })
    if (slide.subtitle) {
      pptSlide.addText(slide.subtitle, {
        x: LAYOUT.marginX + 0.3, y: 3.8, w: 10, h: 0.8,
        fontSize: SIZES.subtitle, color: c(IA.blue),
        fontFace: FONTS.body,
      })
    }
  } else if (slide.type === "section-divider") {
    pptSlide.addText(slide.subtitle || "", {
      x: LAYOUT.marginX + 0.3, y: 2.0, w: 3, h: 1,
      fontSize: 64, bold: true, color: c(IA.blue),
      fontFace: FONTS.kpi,
    })
    pptSlide.addText(slide.title || "", {
      x: LAYOUT.marginX + 0.3, y: 3.5, w: 10, h: 1,
      fontSize: 32, bold: true, color: c(IA.textWhite),
      fontFace: FONTS.title,
    })
  } else if (slide.type === "learnings") {
    // Label
    pptSlide.addText("// LEARNINGS", {
      x: LAYOUT.marginX + 0.3, y: 0.5, w: 5, h: 0.5,
      fontSize: 14, bold: true, color: c(IA.blue),
      fontFace: FONTS.title,
    })
    // Separator
    pptSlide.addShape("rect", {
      x: LAYOUT.marginX + 0.3, y: 1.1, w: 12, h: 0.02,
      fill: { color: c(IA.textCaption) },
      line: { width: 0 },
    })
    // Content
    pptSlide.addText(slide.content || "", {
      x: LAYOUT.marginX + 0.3, y: 1.3, w: 12, h: 5.5,
      fontSize: SIZES.body, color: c(IA.textWhite),
      fontFace: FONTS.body, valign: "top",
      lineSpacingMultiple: 1.5,
    })
  }
}

function renderLightSlide(pptSlide: PptxSlide, slide: Slide, section: SectionId, barColor: string) {
  pptSlide.background = { color: c(IA.bgWhite) }
  addBar(pptSlide, barColor)
  addFooter(pptSlide, false)

  // Header
  if (slide.title && slide.type !== "agenda") {
    pptSlide.addText(slide.title, {
      x: LAYOUT.marginX + 0.3, y: 0.25, w: 11, h: 0.6,
      fontSize: SIZES.titleMain, bold: true, color: c(IA.textBlack),
      fontFace: FONTS.title,
    })
    // Separator line
    pptSlide.addShape("rect", {
      x: LAYOUT.marginX + 0.3, y: 0.9, w: 12, h: 0.015,
      fill: { color: c(IA.textCaption) },
      line: { width: 0 },
    })
  }

  switch (slide.type) {
    case "agenda":
      renderAgenda(pptSlide, slide)
      break
    case "highlights":
      renderHighlights(pptSlide, slide, section)
      break
    case "kpi-table":
      renderKPITable(pptSlide, slide)
      break
    case "table":
      renderGenericTable(pptSlide, slide)
      break
    case "next-steps":
      renderNextSteps(pptSlide, slide, section)
      break
    case "budget":
      renderBudget(pptSlide, slide)
      break
    case "creative":
    case "image":
      renderImage(pptSlide, slide)
      break
    case "title":
      renderTitle(pptSlide, slide)
      break
    case "markdown":
    default:
      renderMarkdown(pptSlide, slide)
      break
  }
}

function renderAgenda(pptSlide: PptxSlide, slide: Slide) {
  pptSlide.addText(slide.title || "Agenda", {
    x: LAYOUT.marginX + 0.3, y: 0.4, w: 10, h: 0.8,
    fontSize: 30, bold: true, color: c(IA.textBlack),
    fontFace: FONTS.title,
  })

  const items = slide.items || []
  items.forEach((item, i) => {
    const y = 1.8 + i * 1.1
    // Number badge
    pptSlide.addText(`0${i + 1}`, {
      x: LAYOUT.marginX + 0.3, y, w: 0.6, h: 0.6,
      fontSize: 20, bold: true, color: c(IA.violet),
      fontFace: FONTS.kpi, align: "center",
    })
    // Label
    pptSlide.addText(item, {
      x: LAYOUT.marginX + 1.2, y: y + 0.05, w: 10, h: 0.5,
      fontSize: SIZES.subtitle, color: c(IA.textBlack),
      fontFace: FONTS.body,
    })
    // Separator
    if (i < items.length - 1) {
      pptSlide.addShape("rect", {
        x: LAYOUT.marginX + 0.3, y: y + 0.75, w: 11, h: 0.01,
        fill: { color: c(IA.bgRowAlt) },
        line: { width: 0 },
      })
    }
  })
}

function renderHighlights(pptSlide: PptxSlide, slide: Slide, section: SectionId) {
  const items = slide.highlights || []
  const cardW = 2.8
  const gap = 0.3
  const startX = (LAYOUT.width - (items.length * cardW + (items.length - 1) * gap)) / 2

  items.forEach((item, i) => {
    const x = startX + i * (cardW + gap)
    const y = LAYOUT.contentY + 0.5
    const accent = section === "meta" ? IA.violet : IA.blue

    // Card background
    pptSlide.addShape("roundRect", {
      x, y, w: cardW, h: 3.5,
      fill: { color: c(IA.bgAlt) },
      line: { width: 0 },
      rectRadius: 0.1,
    })

    // Label
    pptSlide.addText(item.label, {
      x, y: y + 0.3, w: cardW, h: 0.4,
      fontSize: SIZES.body, color: c(IA.textCaption),
      fontFace: FONTS.body, align: "center",
    })

    // Value
    pptSlide.addText(item.value, {
      x, y: y + 1.0, w: cardW, h: 1,
      fontSize: SIZES.kpi, bold: true, color: c(accent),
      fontFace: FONTS.kpi, align: "center",
    })

    // Delta
    if (item.delta) {
      const deltaColor = item.deltaPositive === false ? IA.deltaNeg :
        item.deltaPositive === true ? IA.deltaPos : IA.textCaption
      pptSlide.addText(item.delta, {
        x, y: y + 2.2, w: cardW, h: 0.5,
        fontSize: 14, bold: true, color: c(deltaColor),
        fontFace: FONTS.body, align: "center",
      })
    }
  })
}

function renderKPITable(pptSlide: PptxSlide, slide: Slide) {
  if (!slide.tableData) return
  renderTableWithImpulseStyling(pptSlide, slide.tableData, LAYOUT.contentY + 0.2)
}

function renderGenericTable(pptSlide: PptxSlide, slide: Slide) {
  if (!slide.tableData) return
  renderTableWithImpulseStyling(pptSlide, slide.tableData, LAYOUT.contentY + 0.2)
}

function renderTableWithImpulseStyling(pptSlide: PptxSlide, td: TableData, startY: number) {
  const { headers, rows } = td
  const colW = Math.min(12.5 / headers.length, 2.0)

  const tableRows = [
    headers.map(h => ({
      text: h,
      options: {
        bold: true, color: c(IA.textWhite),
        fill: { color: c(IA.tableHeader) },
        fontSize: SIZES.tableHeader, fontFace: FONTS.body,
        align: "center" as const,
      },
    })),
    ...rows.map((row, idx) => {
      const isTotal = row[0]?.toLowerCase() === "total"
      return row.map(cell => ({
        text: cell,
        options: {
          color: isTotal ? c(IA.tableTotalText) : c(IA.textBlack),
          bold: isTotal,
          fill: isTotal
            ? { color: c(IA.tableTotal) }
            : idx % 2 === 1
              ? { color: c(IA.bgRowAlt) }
              : { color: c(IA.bgWhite) },
          fontSize: SIZES.tableBody, fontFace: FONTS.body,
          align: "center" as const,
        },
      }))
    }),
  ]

  pptSlide.addTable(tableRows, {
    x: LAYOUT.marginX + 0.2, y: startY,
    w: headers.length * colW,
    colW: Array(headers.length).fill(colW),
    rowH: 0.4,
    border: { type: "solid", pt: 0.5, color: c(IA.bgRowAlt) },
    autoPage: true,
  })
}

function renderNextSteps(pptSlide: PptxSlide, slide: Slide, section: SectionId) {
  const items = slide.items || []
  const accent = section === "meta" ? IA.violet : IA.blue

  items.forEach((item, i) => {
    const y = LAYOUT.contentY + 0.3 + i * 0.7
    // Bullet
    pptSlide.addShape("rect", {
      x: LAYOUT.marginX + 0.5, y: y + 0.1, w: 0.15, h: 0.15,
      fill: { color: c(accent) },
      line: { width: 0 },
    })
    // Text
    pptSlide.addText(item, {
      x: LAYOUT.marginX + 0.9, y, w: 11, h: 0.5,
      fontSize: SIZES.body, color: c(IA.textBlack),
      fontFace: FONTS.body,
    })
  })
}

function renderBudget(pptSlide: PptxSlide, slide: Slide) {
  const data = slide.budgetData || []
  const headers = ["Plateforme", "Budget", "Part"]
  const rows = data.map(d => [d.platform, d.amount, d.percentage])
  renderTableWithImpulseStyling(pptSlide, { headers, rows }, LAYOUT.contentY + 0.5)
}

function renderImage(pptSlide: PptxSlide, slide: Slide) {
  if (slide.imageUrl) {
    try {
      pptSlide.addImage({
        path: slide.imageUrl,
        x: 1, y: LAYOUT.contentY + 0.2, w: 8, h: 5,
        sizing: { type: "contain", w: 8, h: 5 },
      })
    } catch {
      pptSlide.addText("Image non disponible", {
        x: 1, y: 3, w: 8, h: 1,
        fontSize: 14, color: c(IA.textCaption),
        fontFace: FONTS.body, align: "center",
      })
    }
  }
  if (slide.creativeName) {
    pptSlide.addText(slide.creativeName, {
      x: 1, y: 6.2, w: 8, h: 0.4,
      fontSize: SIZES.caption, color: c(IA.textCaption),
      fontFace: FONTS.body, align: "center",
    })
  }
}

function renderTitle(pptSlide: PptxSlide, slide: Slide) {
  pptSlide.addText(slide.title || "", {
    x: 0.5, y: 2, w: 12, h: 1.5,
    fontSize: 36, bold: true, color: c(IA.textBlack),
    fontFace: FONTS.title, align: "center",
  })
  if (slide.subtitle) {
    pptSlide.addText(slide.subtitle, {
      x: 0.5, y: 3.5, w: 12, h: 1,
      fontSize: SIZES.subtitle, color: c(IA.textCaption),
      fontFace: FONTS.body, align: "center",
    })
  }
}

function renderMarkdown(pptSlide: PptxSlide, slide: Slide) {
  const text = slide.content
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\|/g, "  ")
    .replace(/---+/g, "")
    .replace(/\n{3,}/g, "\n\n")

  pptSlide.addText(text, {
    x: LAYOUT.marginX + 0.3, y: LAYOUT.contentY + 0.2, w: 12, h: 5.5,
    fontSize: SIZES.body, color: c(IA.textBlack),
    fontFace: FONTS.body, valign: "top",
    lineSpacingMultiple: 1.4,
  })
}
