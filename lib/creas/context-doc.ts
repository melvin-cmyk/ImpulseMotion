/**
 * Fabrique de statics — the client's context document, pure part (the I/O
 * lives in ./context.ts). What the copywriter-AI reads before proposing
 * copies, in the order of the spec: HQ brief → HQ files (personas, customer
 * language, brand voice, competitors) → what wins in the client's own ads
 * (warehouse, 90 days) and the angles never tried → comments under the ads
 * (when Meta lets us read them) → the consultants' past feedback. Every
 * section is capped and traced (kind, ref, size) so the consultant sees what
 * the AI was given.
 */

import type { ContextSource, ContextSourceKind } from "@/lib/creas/model";

export const CLIENT_DOC_MAX = 14_000;
const CAP = { brief: 1800, hqFile: 2600, warehouse: 2600, comments: 2400, feedback: 1400 } as const;
/** The customers' words weigh more than the rest: personas and customer language get more room. */
const HQ_CAP: Record<string, number> = { personas: 4200, langage_client: 4200 };

// ── What wins in the client's own ads ──────────────────────────────────────

export interface WarehouseAdInput {
  name: string; title: string | null; body: string | null;
  spend: number; conversions: number; cpa: number; ctr: number; roas: number | null;
  tags: Record<string, string>;
}

/** The fixed vocabularies of the AI tags (lib/ads-warehouse/ai-tags.ts): what « never tried » can be measured against. */
export const TAG_VOCAB: Record<"ai:hook" | "ai:format" | "ai:offer", string[]> = {
  "ai:hook": ["Question", "Affirmation forte", "Problème", "Preuve sociale", "Curiosité", "Chiffre", "Avant / après", "Injonction", "Humour", "Histoire"],
  "ai:format": ["Titre en gros", "Split screen", "Avant / après", "Témoignage", "Liste de bénéfices", "Comparatif", "Démo produit", "Face caméra", "Meme", "Offre encadrée", "Sans texte"],
  "ai:offer": ["Aucune", "Remise", "Code promo", "Essai gratuit", "Livraison offerte", "Lot", "Offre limitée", "Inscription gratuite", "Devis gratuit"],
};
const ANGLE_KEYS = ["ai:hook", "ai:format", "ai:theme", "ai:offer"] as const;
const KEY_LABEL: Record<(typeof ANGLE_KEYS)[number], string> = { "ai:hook": "accroche", "ai:format": "format", "ai:theme": "thème", "ai:offer": "offre" };

export interface AngleShare { key: string; value: string; winners: number; rest: number }
export interface WinningAngles {
  /** How the winners were chosen: by cost per result, or by CTR when nothing converts. */
  basis: "cpa" | "ctr" | "none";
  winners: WarehouseAdInput[];
  /** Tag values over-represented in the winners (share of their spend vs the rest's). */
  winning: AngleShare[];
  /** Values of the fixed vocabularies never seen in any ad of the period. */
  untested: Array<{ key: string; value: string }>;
  /** Ads analysed, ads tagged by the AI. */
  ads: number;
  tagged: number;
}

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
const isReal = (v: string | undefined) => !!v && !/^(ind[ée]termin[ée]|aucune?|—|-)$/i.test(v.trim());

/**
 * The winners of a period and the angles that make them: ads with a real
 * spend (≥ 2 % of the total, ≥ 10), best cost per result when the account
 * converts, else best CTR; 10 at most. Tag shares are by spend.
 */
export function winningAngles(ads: WarehouseAdInput[], max = 10): WinningAngles {
  const total = ads.reduce((s, a) => s + Math.max(0, a.spend), 0);
  const floor = Math.max(10, total * 0.02);
  const eligible = ads.filter((a) => a.spend >= floor);
  const converting = eligible.filter((a) => a.conversions >= 1 && a.cpa > 0);
  let basis: WinningAngles["basis"] = "none";
  let winners: WarehouseAdInput[] = [];
  if (converting.length >= 2) { basis = "cpa"; winners = [...converting].sort((a, b) => a.cpa - b.cpa).slice(0, Math.min(max, Math.max(2, Math.ceil(converting.length / 3)))); }
  else if (eligible.length >= 2) { basis = "ctr"; winners = [...eligible].sort((a, b) => b.ctr - a.ctr).slice(0, Math.min(max, Math.max(2, Math.ceil(eligible.length / 3)))); }
  const winSet = new Set(winners);
  const rest = ads.filter((a) => !winSet.has(a) && a.spend > 0);
  const tagged = ads.filter((a) => Object.keys(a.tags).some((k) => k.startsWith("ai:")));
  const shareOf = (list: WarehouseAdInput[], key: string) => {
    const sp = list.reduce((s, a) => s + a.spend, 0) || 1;
    const by = new Map<string, number>();
    for (const a of list) { const v = a.tags[key]; if (isReal(v)) by.set(v!, (by.get(v!) ?? 0) + a.spend); }
    return new Map([...by].map(([v, s]) => [v, s / sp]));
  };
  const winning: AngleShare[] = [];
  if (winners.length && tagged.length) {
    for (const key of ANGLE_KEYS) {
      const w = shareOf(winners, key); const r = shareOf(rest, key);
      for (const [value, share] of w) {
        const other = r.get(value) ?? 0;
        if (share >= 0.25 && share > other + 0.05) winning.push({ key, value, winners: Math.round(share * 100), rest: Math.round(other * 100) });
      }
    }
    winning.sort((a, b) => (b.winners - b.rest) - (a.winners - a.rest));
  }
  const untested: Array<{ key: string; value: string }> = [];
  if (tagged.length >= 5) {
    for (const [key, vocab] of Object.entries(TAG_VOCAB)) {
      const seen = new Set(tagged.map((a) => a.tags[key]).filter(Boolean).map((v) => v.toLowerCase()));
      for (const v of vocab) if (v !== "Aucune" && !seen.has(v.toLowerCase())) untested.push({ key, value: v });
    }
  }
  return { basis, winners, winning: winning.slice(0, 8), untested, ads: ads.length, tagged: tagged.length };
}

const pct = (n: number) => `${n} %`;
const money = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;

/** The warehouse section: the winners with their words, the angles that win, the ones never tried. Empty string when there is nothing to say. */
export function renderWarehouseSection(w: WinningAngles, period: string): string {
  if (!w.winners.length) return "";
  const lines = [`## Ce qui gagne dans les pubs du client (${period}, ${w.ads} annonces, classées par ${w.basis === "cpa" ? "coût par résultat" : "taux de clic"})`];
  for (const a of w.winners) {
    const words = [clean(a.title), clean(a.body).slice(0, 220)].filter(Boolean).join(" — ");
    const tags = ANGLE_KEYS.map((k) => (isReal(a.tags[k]) ? `${KEY_LABEL[k]} ${a.tags[k]}` : "")).filter(Boolean).join(", ");
    lines.push(`- « ${clean(a.name).slice(0, 60)} » : ${money(a.spend)} dépensés${w.basis === "cpa" ? `, CPA ${a.cpa.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} €` : `, CTR ${a.ctr.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`}${tags ? ` (${tags})` : ""}${words ? `\n  Texte : ${words}` : ""}`);
  }
  if (w.winning.length) lines.push(`Angles qui gagnent (part de dépense des gagnantes vs le reste) : ${w.winning.map((x) => `${KEY_LABEL[x.key as keyof typeof KEY_LABEL] ?? x.key} « ${x.value} » ${pct(x.winners)} vs ${pct(x.rest)}`).join(" ; ")}.`);
  if (w.untested.length) {
    const by = new Map<string, string[]>();
    for (const u of w.untested) by.set(u.key, [...(by.get(u.key) ?? []), u.value]);
    lines.push(`Angles jamais testés sur la période : ${[...by].map(([k, vs]) => `${KEY_LABEL[k as keyof typeof KEY_LABEL] ?? k} : ${vs.join(", ")}`).join(" ; ")}.`);
  }
  if (!w.tagged) lines.push("(Annonces pas encore étiquetées par l'IA : angles non calculés.)");
  return lines.join("\n");
}

// ── The document ───────────────────────────────────────────────────────────

export interface HqFileInput { kind: Extract<ContextSourceKind, "personas" | "langage_client" | "voix" | "concurrents">; path: string; content: string; statut: string | null }

const HQ_LABEL: Record<HqFileInput["kind"], string> = {
  personas: "Personas (HQ)", langage_client: "Langage client — les mots des clients (HQ)", voix: "Voix de la marque (HQ)", concurrents: "Concurrents (HQ)",
};
export const HQ_CONTEXT_FILES: Array<{ kind: HqFileInput["kind"]; file: string }> = [
  { kind: "personas", file: "brain/recherche/personas.md" },
  { kind: "langage_client", file: "brain/recherche/langage-client.md" },
  { kind: "voix", file: "brain/contenu/voix.md" },
  { kind: "concurrents", file: "brain/recherche/concurrents.md" },
];

export interface ClientContextInput {
  clientName: string;
  brief: string;
  hqFiles: HqFileInput[];
  warehouse: { section: string; ref: string } | null;
  comments: string[];
  feedback: Array<{ level: string; text: string }>;
  verdictNotes: string[];
}

/** The client's context document (Markdown) and its sources. */
export function renderClientContext(i: ClientContextInput): { md: string; sources: ContextSource[] } {
  const sources: ContextSource[] = [];
  const parts: string[] = [`# Contexte statics — ${i.clientName}`];
  const brief = clean(i.brief) ? i.brief.trim().slice(0, CAP.brief) : "";
  if (brief) { parts.push(`## Brief de marque (mémoire HQ)\n${brief}`); sources.push({ kind: "hq_brief", ref: "Dashboard.hqContextMd", chars: brief.length }); }
  else parts.push("## Brief de marque\n(aucun brief HQ en cache pour ce client : reste générique et prudent, pas de promesse ni de prix.)");
  for (const f of HQ_CONTEXT_FILES.map((d) => i.hqFiles.find((x) => x.kind === d.kind)).filter((x): x is HqFileInput => !!x)) {
    const body = f.content.trim().slice(0, HQ_CAP[f.kind] ?? CAP.hqFile);
    if (body.length < 40) continue;
    const hypothesis = f.kind === "personas" && f.statut !== "confirme";
    parts.push(`## ${HQ_LABEL[f.kind]}${hypothesis ? " — HYPOTHÈSE, non confirmée par un consultant" : ""}\n${body}`);
    sources.push({ kind: f.kind, ref: f.path, chars: body.length, ...(hypothesis ? { note: "hypothèse" } : {}) });
  }
  if (i.warehouse?.section) { const s = i.warehouse.section.slice(0, CAP.warehouse); parts.push(s); sources.push({ kind: "warehouse", ref: i.warehouse.ref, chars: s.length }); }
  const comments = i.comments.map((c) => `- « ${clean(c).slice(0, 240)} »`).join("\n").slice(0, CAP.comments);
  if (comments) { parts.push(`## Commentaires sous les pubs (mots des clients, à reprendre tels quels)\n${comments}`); sources.push({ kind: "comments", ref: "Meta", chars: comments.length }); }
  const fb = [...i.feedback.map((f) => `- [${f.level === "client" ? "client" : f.level === "run" ? "fabrique" : f.level}] ${clean(f.text)}`), ...i.verdictNotes.map((n) => `- [verdict] ${clean(n)}`)].filter((l) => l.length > 8).join("\n").slice(0, CAP.feedback);
  if (fb) { parts.push(`## Retours des consultants (à respecter)\n${fb}`); sources.push({ kind: "feedback", ref: "CreativeFeedback + verdicts", chars: fb.length }); }
  return { md: parts.join("\n\n").slice(0, CLIENT_DOC_MAX), sources };
}

/** The HQ mirror of the document: frontmatter of state (same keys as HQ's brain files) then the body. */
export function hqMirrorContent(md: string, by: string, now = new Date()): string {
  const q = (v: string) => (/[:#"']/.test(v) ? JSON.stringify(v) : v);
  return ["---", "statut: brouillon", `source: ${q("ImpulseMotion — fabrique de statics")}`, `maj: ${now.toISOString().slice(0, 10)}`, `confirme_par: ${q(by)}`, "rafraichir_tous_les: 30j", "---", "", md.trim(), ""].join("\n");
}

/** A consultant's edit, cleaned: no frontmatter pasted back, bounded. */
export function cleanEditedDoc(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/\r\n/g, "\n").trim().slice(0, CLIENT_DOC_MAX);
}
