/**
 * Deck theme — shared color palette + typography applied across all slides
 * and overlay blocks for a single deck (keyed by client + period draft).
 */

export interface DeckTheme {
  id: string;
  name: string;
  primary: string;      // main brand color (buttons, headings, dark accent)
  accent: string;       // bright accent (links, highlights)
  accentAlt: string;    // tertiary accent (gradients, hover)
  fontFamily: string;   // CSS font-family string
  tableHeaderColor: string;
  darkGradient: string; // linear-gradient for cover / section divider slides
}

export const DECK_THEMES: DeckTheme[] = [
  {
    id: "impulse",
    name: "Impulse (défaut)",
    primary: "#0944A1",
    accent: "#2CA6F9",
    accentAlt: "#7F5AFD",
    fontFamily: "'Open Sans', Calibri, sans-serif",
    tableHeaderColor: "#0070C0",
    darkGradient: "linear-gradient(135deg, #0944A1 0%, #1a6dd4 30%, #2CA6F9 55%, #7F5AFD 100%)",
  },
  {
    id: "sunset",
    name: "Sunset",
    primary: "#A8201A",
    accent: "#E4572E",
    accentAlt: "#F3A712",
    fontFamily: "'Open Sans', Calibri, sans-serif",
    tableHeaderColor: "#A8201A",
    darkGradient: "linear-gradient(135deg, #A8201A 0%, #E4572E 50%, #F3A712 100%)",
  },
  {
    id: "forest",
    name: "Forest",
    primary: "#1B4332",
    accent: "#40916C",
    accentAlt: "#95D5B2",
    fontFamily: "'Open Sans', Calibri, sans-serif",
    tableHeaderColor: "#1B4332",
    darkGradient: "linear-gradient(135deg, #1B4332 0%, #2D6A4F 50%, #40916C 100%)",
  },
  {
    id: "mono",
    name: "Monochrome",
    primary: "#111827",
    accent: "#374151",
    accentAlt: "#6B7280",
    fontFamily: "'Inter', system-ui, sans-serif",
    tableHeaderColor: "#111827",
    darkGradient: "linear-gradient(135deg, #111827 0%, #1F2937 50%, #374151 100%)",
  },
];

export const DEFAULT_THEME: DeckTheme = DECK_THEMES[0];

export function getTheme(id: string | undefined | null): DeckTheme {
  if (!id) return DEFAULT_THEME;
  return DECK_THEMES.find(t => t.id === id) ?? DEFAULT_THEME;
}
