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

// ── Fabrique de statics (lib/creas/factory.ts, lib/creas/copy.ts) ────────────

export const FACTORY_KINDS = ["offer", "evergreen", "iteration", "variation"] as const;
export type FactoryKind = (typeof FACTORY_KINDS)[number];
export const FACTORY_KIND_LABEL: Record<FactoryKind, string> = { offer: "Offre", evergreen: "Evergreen", iteration: "Itération", variation: "Variation" };

export const RUN_STATUSES = ["draft", "copy_review", "approved", "generating", "review", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  draft: "Brouillon", copy_review: "Copys à valider", approved: "Prête à générer", generating: "Génération en cours", review: "À trier", done: "Terminée", failed: "Échec",
};

export const COPY_STATUSES = ["proposed", "approved", "rejected"] as const;
export type CopyStatus = (typeof COPY_STATUSES)[number];

export const FEEDBACK_LEVELS = ["asset", "template", "run", "client"] as const;
export type FeedbackLevel = (typeof FEEDBACK_LEVELS)[number];
export const FEEDBACK_LEVEL_LABEL: Record<FeedbackLevel, string> = { asset: "cette pub", template: "ce template", run: "cette fabrique", client: "ce client" };

/** Where a piece of the run's context comes from (traced in FactoryRun.sourcesJson). */
export const CONTEXT_SOURCE_KINDS = ["hq_brief", "personas", "langage_client", "voix", "concurrents", "warehouse", "comments", "client_doc", "templates", "reviews", "feedback", "instructions"] as const;
export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];
export interface ContextSource { kind: ContextSourceKind; ref: string; chars: number; /** e.g. « hypothèse » for personas not confirmed in HQ. */ note?: string }
export const CONTEXT_SOURCE_LABEL: Record<ContextSourceKind, string> = {
  hq_brief: "Brief HQ", personas: "Personas HQ", langage_client: "Langage client HQ", voix: "Voix de la marque HQ", concurrents: "Concurrents HQ", warehouse: "Gagnantes de l'entrepôt",
  comments: "Commentaires des pubs", client_doc: "Document de contexte du client", templates: "Templates", reviews: "Avis collés", feedback: "Retours passés", instructions: "Consignes",
};

/** The client's statics context document (FactoryContext), as the UI shows it. */
export interface FactoryContextView {
  clientId: string;
  md: string;
  sources: ContextSource[];
  /** Stored (edited by a consultant) or freshly assembled. */
  stored: boolean;
  updatedAt: string | null;
  hqPath: string | null;
  /** Where the mirror would be written in HQ (null: no HQ folder). */
  hqTarget: string | null;
  warnings: string[];
}

export interface FactorySettings {
  /** Visuals wanted in all. */
  n: number;
  engine: string;
  ratio: string;
  textless: boolean;
  perTemplate: number;
  persona?: string;
  season?: string;
  instructions?: string;
  /** Progress of the generation: slots tried so far (success + failure) and failures. */
  attempted: number;
  failed: number;
  /** Last error worth showing (a failed batch, Drive unreachable…). */
  error?: string;
}

export interface FactoryCopyView {
  id: string; runId: string; templateId: string | null; order: number;
  headline: string; subline: string; cta: string; angle: string; persona: string; voiceSource: string;
  status: CopyStatus; editedByHuman: boolean;
}

export interface FactoryRunView {
  id: string; clientId: string; clientName: string; kind: FactoryKind; status: RunStatus;
  templateIds: string[]; contextMd: string; sources: ContextSource[]; settings: FactorySettings;
  estimatedUsd: number; costUsd: number; generated: number; kept: number; cut: number;
  /** Visuals still to make (settings.n − attempted). */
  remaining: number;
  driveLink: string | null; createdByName: string; createdAt: string; updatedAt: string;
  copies: FactoryCopyView[];
}

export interface FeedbackView { id: string; level: FeedbackLevel; clientId: string | null; assetId: string | null; templateId: string | null; runId: string | null; text: string; createdByName: string; createdAt: string }

export const DEFAULT_FACTORY_ENGINE = "fal-ai/nano-banana-2/edit";
export const DEFAULT_PER_TEMPLATE = 4;
/** Images one HTTP call generates at most (Vercel 300 s), and one fal call (its own cap). */
export const PASS_SIZE = 12;
export const BATCH_SIZE = 4;
export const PARALLEL_BATCHES = 3;
export const MAX_RUN_IMAGES = 40;

export function parseSettings(json: string | null | undefined): FactorySettings {
  let raw: Record<string, unknown> = {};
  try { raw = json ? (JSON.parse(json) as Record<string, unknown>) : {}; } catch { raw = {}; }
  const int = (v: unknown, d: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : d);
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return {
    n: int(raw.n, 0, 1000), engine: s(raw.engine, 80) || DEFAULT_FACTORY_ENGINE, ratio: s(raw.ratio, 8) || "1:1", textless: raw.textless === true,
    perTemplate: int(raw.perTemplate, DEFAULT_PER_TEMPLATE, 12) || DEFAULT_PER_TEMPLATE,
    ...(s(raw.persona, 200) ? { persona: s(raw.persona, 200) } : {}), ...(s(raw.season, 200) ? { season: s(raw.season, 200) } : {}), ...(s(raw.instructions, 1500) ? { instructions: s(raw.instructions, 1500) } : {}),
    attempted: int(raw.attempted, 0, 100000), failed: int(raw.failed, 0, 100000), ...(s(raw.error, 500) ? { error: s(raw.error, 500) } : {}),
  };
}

export function parseSources(json: string | null | undefined): ContextSource[] {
  try {
    const raw = json ? JSON.parse(json) : [];
    return (Array.isArray(raw) ? raw : []).filter((x) => x && typeof x === "object" && typeof x.kind === "string").map((x) => ({ kind: x.kind, ref: String(x.ref ?? ""), chars: Number(x.chars) || 0, ...(typeof x.note === "string" && x.note ? { note: x.note.slice(0, 80) } : {}) }));
  } catch { return []; }
}

export const parseIdList = (json: string | null | undefined): string[] => { try { const raw = json ? JSON.parse(json) : []; return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
