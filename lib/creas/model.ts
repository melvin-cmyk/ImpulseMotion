/**
 * Créas par client — swipe file of templates and the visuals made from them.
 * Client-safe types and parsing (storage and AI in ./templates, ./analysis).
 */

export const TEMPLATE_SOURCES = ["competitor", "own", "upload"] as const;
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number];
export const SOURCE_LABEL: Record<TemplateSource, string> = { competitor: "Concurrent", own: "Gagnante du client", upload: "Importé" };

/** What the AI reads in a template (lib/creas/analysis.ts). Every field may be empty. */
export interface TemplateAnalysis {
  /** Visual hook in one line ("avant / après", "produit géant", "témoignage"…). */
  hook: string;
  /** Layout, in reading order ("titre en haut, produit centré, bouton en bas"). */
  structure: string;
  /** Text zones, in order, with what they say. */
  textZones: Array<{ role: string; text: string }>;
  /** Style: photo, 3D, flat, UGC, typographic… and the mood. */
  style: string;
  /** Main colours (hex or names). */
  palette: string[];
  /** Call to action, if any. */
  cta: string;
  /** Why the ad works (2–3 lines). */
  whyItWorks: string;
  /** A ready-to-use brief to reproduce the template for another brand. */
  brief: string;
}

const EMPTY: TemplateAnalysis = { hook: "", structure: "", textZones: [], style: "", palette: [], cta: "", whyItWorks: "", brief: "" };
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function parseAnalysis(json: string | null | undefined): TemplateAnalysis {
  if (!json) return { ...EMPTY };
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(json) as Record<string, unknown>; } catch { return { ...EMPTY }; }
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  return {
    hook: str(raw.hook, 200),
    structure: str(raw.structure, 600),
    textZones: (Array.isArray(raw.textZones) ? raw.textZones : []).slice(0, 8).map((z) => ({ role: str((z as Record<string, unknown>)?.role, 40), text: str((z as Record<string, unknown>)?.text, 200) })).filter((z) => z.role || z.text),
    style: str(raw.style, 300),
    palette: (Array.isArray(raw.palette) ? raw.palette : []).slice(0, 6).map((c) => str(c, 30)).filter(Boolean),
    cta: str(raw.cta, 80),
    whyItWorks: str(raw.whyItWorks, 600),
    brief: str(raw.brief, 1500),
  };
}

export const analysisIsEmpty = (a: TemplateAnalysis) => !a.hook && !a.structure && !a.brief;

export interface TemplateView {
  id: string;
  name: string;
  source: TemplateSource;
  brand: string;
  clientId: string | null;
  clientName: string;
  sourceRef: string | null;
  sourceUrl: string | null;
  /** Picture to show (signed link to the relay's copy, else the platform link). */
  image: string | null;
  title: string | null;
  body: string | null;
  analysis: TemplateAnalysis;
  tags: string[];
  createdByName: string;
  createdAt: string;
  mine: boolean;
  /** Visuals generated from it. */
  uses: number;
}

export const parseTags = (s: string | null | undefined) => (s ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 12);

/** Size of the Studio ratio closest to a width × height, for the generated copies. */
export function ratioFor(width: number | null, height: number | null): string {
  if (!width || !height) return "1:1";
  const r = width / height;
  const candidates: Array<[string, number]> = [["1:1", 1], ["4:5", 0.8], ["3:4", 0.75], ["9:16", 9 / 16], ["16:9", 16 / 9], ["4:3", 4 / 3], ["2:3", 2 / 3], ["3:2", 1.5]];
  return candidates.reduce((best, c) => (Math.abs(c[1] - r) < Math.abs(best[1] - r) ? c : best))[0];
}
