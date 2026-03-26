/**
 * MBR Template Generator — creates the skeleton of a 30-slide Monthly Business Review.
 */

import type { Slide } from "./deck-store"
import type { MBRConfig, SectionId } from "./impulse-theme"

let slideCounter = 0
function sid(): string {
  slideCounter++
  return `mbr-${Date.now()}-${slideCounter}`
}

function mkSlide(partial: Omit<Slide, "id">): Slide {
  return { id: sid(), ...partial }
}

export function generateMBRSkeleton(cfg: MBRConfig): Slide[] {
  const { clientName, periodLabel, periodPrevLabel } = cfg
  const slides: Slide[] = []

  // ── COVER ─────────────────────────────────────────────────────────────
  slides.push(mkSlide({
    type: "cover",
    content: "",
    title: `Monthly Business Review`,
    subtitle: `${clientName} — ${periodLabel}`,
    isDark: true,
    section: "global",
  }))

  // ── AGENDA ────────────────────────────────────────────────────────────
  slides.push(mkSlide({
    type: "agenda",
    content: "",
    title: "Agenda",
    items: [
      "Global Overview — Highlights & KPIs",
      "Focus Google Ads — Campagnes & Performance",
      "Focus Meta Ads — Campagnes & Top Créas",
      "Next Steps & Budget",
    ],
    section: "global",
  }))

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 1 — GLOBAL OVERVIEW
  // ═══════════════════════════════════════════════════════════════════════
  slides.push(mkSectionDivider("global", "01", "Global Overview"))

  // Highlights — 4 insight cards
  slides.push(mkSlide({
    type: "highlights",
    content: "",
    title: "Highlights du mois",
    section: "global",
    highlights: [
      { label: "Spend Total", value: "—", delta: "—" },
      { label: "ROAS Global", value: "—", delta: "—" },
      { label: "Conversions", value: "—", delta: "—" },
      { label: "CPA Moyen", value: "—", delta: "—" },
    ],
  }))

  // Global KPI table
  slides.push(mkSlide({
    type: "kpi-table",
    content: "",
    title: `Performance Globale — ${periodLabel} vs ${periodPrevLabel}`,
    section: "global",
    tableData: {
      headers: ["Plateforme", "Impressions", "Clics", "CTR", "CPC", "Spend", "Conversions", "CPA", "Revenue", "ROAS"],
      rows: [
        ["Google Ads", "—", "—", "—", "—", "—", "—", "—", "—", "—"],
        ["Meta Ads", "—", "—", "—", "—", "—", "—", "—", "—", "—"],
        ["Total", "—", "—", "—", "—", "—", "—", "—", "—", "—"],
      ],
    },
  }))

  // NC / CP-NC
  slides.push(mkSlide({
    type: "kpi-table",
    content: "",
    title: "Nouveaux Clients — NC / CP-NC / %NC",
    section: "global",
    tableData: {
      headers: ["Plateforme", "NC", "CP-NC", "%NC", "Δ NC", "Δ CP-NC"],
      rows: [
        ["Google Ads", "—", "—", "—", "—", "—"],
        ["Meta Ads", "—", "—", "—", "—", "—"],
        ["Total", "—", "—", "—", "—", "—"],
      ],
    },
  }))

  // Learnings Global
  slides.push(mkSlide({
    type: "learnings",
    content: "Remplir avec les insights clés du mois — à générer par l'IA.",
    title: "// LEARNINGS",
    section: "global",
    isDark: true,
  }))

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 2 — FOCUS GOOGLE ADS
  // ═══════════════════════════════════════════════════════════════════════
  slides.push(mkSectionDivider("google", "02", "Focus Google Ads"))

  // Google — Global view
  slides.push(mkSlide({
    type: "highlights",
    content: "",
    title: "Google Ads — Vue Globale",
    section: "google",
    highlights: [
      { label: "Spend", value: "—", delta: "—" },
      { label: "ROAS", value: "—", delta: "—" },
      { label: "Conversions", value: "—", delta: "—" },
      { label: "CPA", value: "—", delta: "—" },
    ],
  }))

  // Google — Campaign table
  slides.push(mkSlide({
    type: "kpi-table",
    content: "",
    title: "Google Ads — Performance par Campagne",
    section: "google",
    tableData: {
      headers: ["Campagne", "Impressions", "Clics", "CTR", "CPC", "Spend", "Conv.", "CPA", "Revenue", "ROAS"],
      rows: [
        ["Campagne 1", "—", "—", "—", "—", "—", "—", "—", "—", "—"],
        ["Campagne 2", "—", "—", "—", "—", "—", "—", "—", "—", "—"],
        ["Total", "—", "—", "—", "—", "—", "—", "—", "—", "—"],
      ],
    },
  }))

  // Google — Brand Search
  slides.push(mkSlide({
    type: "kpi-table",
    content: "",
    title: "Google Ads — Brand Search",
    section: "google",
    tableData: {
      headers: ["Campagne", "Impressions", "Clics", "CTR", "CPC", "Spend", "Conv.", "CPA", "ROAS"],
      rows: [
        ["Brand Search", "—", "—", "—", "—", "—", "—", "—", "—"],
      ],
    },
  }))

  // Google — Pmax / Shopping
  slides.push(mkSlide({
    type: "kpi-table",
    content: "",
    title: "Google Ads — Pmax Shopping & Top Produits",
    section: "google",
    tableData: {
      headers: ["Produit / Campagne", "Impressions", "Clics", "Spend", "Conv.", "CPA", "ROAS"],
      rows: [
        ["Pmax Shopping", "—", "—", "—", "—", "—", "—"],
        ["Top Produit 1", "—", "—", "—", "—", "—", "—"],
        ["Top Produit 2", "—", "—", "—", "—", "—", "—"],
      ],
    },
  }))

  // Google Learnings
  slides.push(mkSlide({
    type: "learnings",
    content: "Insights Google Ads — à générer par l'IA.",
    title: "// LEARNINGS",
    section: "google",
    isDark: true,
  }))

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 3 — FOCUS META ADS
  // ═══════════════════════════════════════════════════════════════════════
  slides.push(mkSectionDivider("meta", "03", "Focus Meta Ads"))

  // Meta — Global view
  slides.push(mkSlide({
    type: "highlights",
    content: "",
    title: "Meta Ads — Vue Globale",
    section: "meta",
    highlights: [
      { label: "Spend", value: "—", delta: "—" },
      { label: "ROAS", value: "—", delta: "—" },
      { label: "Conversions", value: "—", delta: "—" },
      { label: "CPM", value: "—", delta: "—" },
    ],
  }))

  // Meta — Campaign table
  slides.push(mkSlide({
    type: "kpi-table",
    content: "",
    title: "Meta Ads — Performance par Campagne",
    section: "meta",
    tableData: {
      headers: ["Campagne", "Impressions", "Clics", "CTR", "CPM", "Spend", "Conv.", "CPA", "Revenue", "ROAS"],
      rows: [
        ["Campagne 1", "—", "—", "—", "—", "—", "—", "—", "—", "—"],
        ["Campagne 2", "—", "—", "—", "—", "—", "—", "—", "—", "—"],
        ["Total", "—", "—", "—", "—", "—", "—", "—", "—", "—"],
      ],
    },
  }))

  // Meta — Top Créas
  slides.push(mkSlide({
    type: "creative",
    content: "",
    title: "Meta Ads — Top Créas",
    section: "meta",
    creativeName: "Top créatives du mois",
    creativeMetrics: { "Spend": "—", "ROAS": "—", "CTR": "—", "CPA": "—" },
  }))

  // Meta — Top Créas detail (placeholder for additional creative slides)
  slides.push(mkSlide({
    type: "markdown",
    content: "## Top Créatives Meta Ads\n\nDemandez à l'IA de récupérer les top créatives avec :\n\n> *\"Top 5 créatives Meta Ads ce mois avec les images\"*\n\nPuis ajoutez les résultats au deck.",
    title: "Top Créas — Détail",
    section: "meta",
  }))

  // Meta — Next steps créatifs
  slides.push(mkSlide({
    type: "next-steps",
    content: "",
    title: "Next Steps Créatifs",
    section: "meta",
    items: [
      "Tester de nouveaux formats vidéo courtes",
      "Itérer sur les top créas du mois",
      "Ajouter des variantes UGC",
    ],
  }))

  // Meta Learnings
  slides.push(mkSlide({
    type: "learnings",
    content: "Insights Meta Ads — à générer par l'IA.",
    title: "// LEARNINGS",
    section: "meta",
    isDark: true,
  }))

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 4 — NEXT STEPS & BUDGET
  // ═══════════════════════════════════════════════════════════════════════
  slides.push(mkSectionDivider("next", "04", "Next Steps & Budget"))

  // Next Steps — Global
  slides.push(mkSlide({
    type: "next-steps",
    content: "",
    title: "Actions — Global",
    section: "next",
    items: [
      "Action globale 1 — à compléter",
      "Action globale 2 — à compléter",
    ],
  }))

  // Next Steps — Google
  slides.push(mkSlide({
    type: "next-steps",
    content: "",
    title: "Actions — Google Ads",
    section: "next",
    items: [
      "Optimiser les enchères Brand Search",
      "Tester de nouveaux assets Pmax",
    ],
  }))

  // Next Steps — Meta
  slides.push(mkSlide({
    type: "next-steps",
    content: "",
    title: "Actions — Meta Ads",
    section: "next",
    items: [
      "Scaler les audiences Lookalike performantes",
      "Renouveler les créatives fatiguées",
    ],
  }))

  // Budget
  slides.push(mkSlide({
    type: "budget",
    content: "",
    title: `Budget — ${periodLabel}`,
    section: "next",
    budgetData: [
      { platform: "Google Ads", amount: "—", percentage: "—" },
      { platform: "Meta Ads", amount: "—", percentage: "—" },
      { platform: "Total", amount: "—", percentage: "100%" },
    ],
  }))

  // Closing
  slides.push(mkSlide({
    type: "cover",
    content: "",
    title: "Merci.",
    subtitle: `${clientName} — Impulse Analytics`,
    isDark: true,
    section: "next",
  }))

  return slides
}

function mkSectionDivider(section: SectionId, num: string, label: string): Slide {
  return mkSlide({
    type: "section-divider",
    content: "",
    title: label,
    subtitle: num,
    section,
    isDark: true,
  })
}

// ── Utility: month helpers ─────────────────────────────────────────────────
const MONTH_NAMES_FR = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]

export function getMonthLabel(monthStr: string): string {
  const [year, month] = monthStr.split("-").map(Number)
  return `${MONTH_NAMES_FR[month - 1]} ${year}`
}

export function getPreviousMonth(monthStr: string): string {
  const [year, month] = monthStr.split("-").map(Number)
  if (month === 1) return `${year - 1}-12`
  return `${year}-${String(month - 1).padStart(2, "0")}`
}
