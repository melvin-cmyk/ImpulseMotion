/**
 * Fabrique de statics — the pure parts: the context document of a run, the
 * prompt asking the model for copy proposals and its strict parser, the plan
 * of a generation (which copy gets how many visuals, batches of 4, passes of
 * 12), the price, the state machine of a run. No I/O, fully testable; the
 * server side (relay, Prisma, Drive) lives in ./factory.ts.
 */

import { BATCH_SIZE, PASS_SIZE, type ContextSource, type FactoryKind, type RunStatus, type TemplateAnalysis } from "@/lib/creas/model";

export interface CopyTemplateInput { id: string; name: string; brand: string; source: string; analysis: TemplateAnalysis }
export interface CopyProposal { templateId: string; order: number; headline: string; subline: string; cta: string; angle: string; persona: string; voiceSource: string }

const MAX_BRIEF = 1800;
const MAX_REVIEWS = 6000;
const MAX_FEEDBACK = 1200;
/** The client's context document inside a run's context (the copy prompt stays under ~6 k tokens with the templates). */
export const MAX_CLIENT_DOC = 14_000;

/**
 * The context the model reads for one run (lot 1: the client's cached HQ
 * brief, what the templates say in their text zones, the reviews the
 * consultant pasted, the feedback of past runs). Each source is capped and
 * traced with its size, so the consultant sees what the AI was given.
 */
export function assembleContext(input: { clientName: string; brief: string; templates: CopyTemplateInput[]; reviews: string; feedback: Array<{ level: string; text: string }>; instructions?: string; client?: { md: string; sources: ContextSource[] } | null }): { md: string; sources: ContextSource[] } {
  const sources: ContextSource[] = [];
  const parts: string[] = [`# Contexte statics — ${input.clientName}`];
  const clientDoc = (input.client?.md ?? "").trim().replace(/^#\s[^\n]*\n+/, "").slice(0, MAX_CLIENT_DOC);
  if (clientDoc) {
    // The client's context document (lib/creas/context.ts: HQ brief and files, warehouse winners, comments, past feedback), as the consultant left it.
    parts.push(clientDoc);
    sources.push(...(input.client?.sources.length ? input.client.sources : [{ kind: "client_doc" as const, ref: "FactoryContext", chars: clientDoc.length }]));
  } else {
    const brief = input.brief.trim().slice(0, MAX_BRIEF);
    if (brief) { parts.push(`## Brief de marque (mémoire HQ, en cache)\n${brief}`); sources.push({ kind: "hq_brief", ref: "Dashboard.hqContextMd", chars: brief.length }); }
    else parts.push("## Brief de marque\n(aucun brief HQ en cache pour ce client : reste générique et prudent, pas de promesse ni de prix.)");
  }
  const tpl = input.templates.map((t, i) => {
    const a = t.analysis;
    const zones = a.textZones.length ? a.textZones.map((z) => `${z.role}${z.text ? ` : « ${z.text} »` : ""}`).join(" ; ") : "aucune zone de texte lue";
    return `- T${i + 1} « ${t.name} »${t.brand ? ` (${t.source === "own" ? "gagnante du client" : `marque d'origine ${t.brand}`})` : ""} — accroche : ${a.hook || "—"} ; zones : ${zones}${a.cta ? ` ; CTA : ${a.cta}` : ""}${a.whyItWorks ? ` ; pourquoi ça marche : ${a.whyItWorks.slice(0, 240)}` : ""}`;
  });
  if (tpl.length) { const text = tpl.join("\n"); parts.push(`## Templates choisis (ce qu'ils disent)\n${text}`); sources.push({ kind: "templates", ref: input.templates.map((t) => t.id).join(","), chars: text.length }); }
  const reviews = input.reviews.trim().slice(0, MAX_REVIEWS);
  if (reviews) { parts.push(`## Avis clients collés par le consultant (la voix des clients — à reprendre mot pour mot quand c'est possible)\n${reviews}`); sources.push({ kind: "reviews", ref: "collés", chars: reviews.length }); }
  const fb = input.feedback.map((f) => `- [${f.level}] ${f.text.trim()}`).filter((l) => l.length > 6).join("\n").slice(0, MAX_FEEDBACK);
  if (fb) { parts.push(`## Retours des consultants sur les fabriques passées (à respecter)\n${fb}`); sources.push({ kind: "feedback", ref: "CreativeFeedback", chars: fb.length }); }
  const instr = (input.instructions ?? "").trim().slice(0, 1500);
  if (instr) { parts.push(`## Consignes du consultant pour cette fabrique\n${instr}`); sources.push({ kind: "instructions", ref: "consultant", chars: instr.length }); }
  return { md: parts.join("\n\n"), sources };
}

const KIND_GOAL: Record<FactoryKind, string> = {
  offer: "une OFFRE : chaque copy doit mettre l'offre en avant, telle que le consultant l'a décrite dans ses consignes (jamais une offre inventée).",
  evergreen: "des publicités EVERGREEN : bénéfice produit, preuve, usage — sans promo ni date, réutilisables toute l'année.",
  iteration: "des ITÉRATIONS d'angles qui ont déjà marché pour la marque : même promesse, formulations nouvelles.",
  variation: "des VARIATIONS d'une fabrique précédente : même marque, autre persona ou autre saison, selon les consignes.",
};

/** Length allowed in a text zone: about the template's own text, never below a floor the model can write in. */
export function zoneLengthHint(zones: TemplateAnalysis["textZones"]): string {
  if (!zones.length) return "titre ≤ 45 caractères, sous-titre ≤ 90, bouton ≤ 20";
  const limit = (roles: RegExp, floor: number) => { const z = zones.filter((x) => roles.test(x.role)); const m = Math.max(0, ...z.map((x) => x.text.length)); return Math.max(floor, Math.round(m * 1.3)); };
  return `titre ≤ ${limit(/^(titre|headline|accroche|promo|prix|badge)/i, 30)} caractères, sous-titre ≤ ${limit(/^(sous|sub|mention|desc)/i, 60)}, bouton ≤ ${limit(/^(bouton|cta)/i, 16)}`;
}

/** The prompt (system + user) asking Sonnet for `perTemplate` copies per template, as strict JSON. */
export function buildCopyProposalPrompt(input: { clientName: string; kind: FactoryKind; contextMd: string; templates: CopyTemplateInput[]; perTemplate: number; persona?: string; season?: string }): { system: string; user: string } {
  const system = [
    `Tu es concepteur-rédacteur senior dans une agence de publicité digitale française. On te donne le contexte d'une marque et des TEMPLATES de publicités (des mises en page qui marchent). Tu écris, pour chaque template, ${input.perTemplate} propositions de copy pour la marque « ${input.clientName} ».`,
    "Règles :",
    "- Écris en français, naturel, sans anglicisme inutile, sans point d'exclamation en rafale.",
    "- Reprends les MOTS DES CLIENTS quand le contexte en donne (avis collés, langage client, brief) et cite la source dans voiceSource (« avis collé : “…” », « brief HQ », « template T2 », « règle de la marque »). Si tu n'as pas de source, écris « proposition » — n'invente jamais une citation.",
    "- Jamais d'offre chiffrée (-30 %, 2 pour 1, prix, « gratuit ») sauf si les règles de la marque du contexte l'autorisent explicitement ou si le consultant l'a écrite dans ses consignes.",
    "- Pas de promesse de santé, de résultat garanti, de superlatif invérifiable, pas de comparaison nommée avec un concurrent.",
    "- Chaque proposition d'un même template doit porter un ANGLE différent (bénéfice, preuve, objection levée, usage, émotion, identité…) et viser une persona du contexte quand il y en a.",
    "- Respecte la longueur des zones de texte de chaque template (indiquée) : le texte doit tenir dans l'image.",
    `Réponds UNIQUEMENT par un objet JSON, sans texte autour : {"copies":[{"template":1,"headline":"…","subline":"…","cta":"…","angle":"…","persona":"…","voiceSource":"…"}]} — "template" est le numéro T1, T2… du template ; subline, cta, persona peuvent être vides.`,
  ].join("\n");
  const tpl = input.templates.map((t, i) => `T${i + 1} « ${t.name} » — accroche : ${t.analysis.hook || "—"} ; structure : ${t.analysis.structure || "—"} ; longueurs : ${zoneLengthHint(t.analysis.textZones)}${t.analysis.brief ? ` ; brief : ${t.analysis.brief.slice(0, 400)}` : ""}`);
  const user = [
    `Objectif de cette fabrique : ${KIND_GOAL[input.kind]}`,
    input.persona ? `Persona visée : ${input.persona}.` : "",
    input.season ? `Saison / moment : ${input.season}.` : "",
    `Templates (${input.templates.length}) :\n${tpl.join("\n")}`,
    `Contexte :\n${input.contextMd}`,
    `Écris ${input.perTemplate} propositions par template (${input.perTemplate * input.templates.length} en tout).`,
  ].filter(Boolean).join("\n\n");
  return { system, user };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * The model's JSON → proposals, capped per template, deduplicated on the
 * headline, numbered. Lenient on the shape (an array at the top level, a
 * template given as "T2", a missing field), strict on what is kept.
 */
export function parseCopyProposals(raw: unknown, templates: Array<{ id: string }>, perTemplate: number): CopyProposal[] {
  const list: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { copies?: unknown }).copies) ? (raw as { copies: unknown[] }).copies : [];
  const perTpl = new Map<string, number>();
  const seen = new Set<string>();
  const out: CopyProposal[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const idx = typeof o.template === "number" ? o.template : typeof o.template === "string" ? Number(o.template.replace(/^t/i, "")) : typeof o.templateId === "string" ? templates.findIndex((t) => t.id === o.templateId) + 1 : NaN;
    const template = templates[idx - 1];
    if (!template) continue;
    const headline = str(o.headline ?? o.titre ?? o.title, 120);
    if (!headline) continue;
    const key = `${template.id}|${headline.toLowerCase()}`;
    if (seen.has(key)) continue;
    const count = perTpl.get(template.id) ?? 0;
    if (count >= perTemplate) continue;
    seen.add(key); perTpl.set(template.id, count + 1);
    out.push({ templateId: template.id, order: out.length, headline, subline: str(o.subline ?? o.sousTitre ?? o.subtitle, 200), cta: str(o.cta, 40), angle: str(o.angle, 120), persona: str(o.persona, 120), voiceSource: str(o.voiceSource ?? o.source, 240) || "proposition" });
  }
  return out;
}

/** The generation brief of one visual: the template copy prompt, then the approved texts to write in the picture. */
export function buildFactoryImagePrompt(base: string, copy: Pick<CopyProposal, "headline" | "subline" | "cta">, textless: boolean): string {
  if (textless) return `${base}\nLes textes seront posés ensuite : garde libres les zones du template (titre « ${copy.headline} »).`;
  const lines = [`Titre : « ${copy.headline} »`, copy.subline ? `Sous-titre : « ${copy.subline} »` : "", copy.cta ? `Bouton : « ${copy.cta} »` : ""].filter(Boolean);
  return `${base}\nTEXTES À ÉCRIRE DANS L'IMAGE, exactement, en français, sans faute, lisibles, aux emplacements que le template donne à ces rôles : ${lines.join(" ; ")}. Aucun autre texte.`;
}

// ── Plan of a generation ───────────────────────────────────────────────────

export interface Slot { copyId: string; templateId: string }
export interface BatchPlan extends Slot { count: number }

/** `total` images in batches of `size` (4 at fal): [4, 4, 4] for 12, [4, 4, 2] for 10. */
export function splitBatches(total: number, size = BATCH_SIZE): number[] {
  const out: number[] = [];
  for (let left = Math.max(0, Math.round(total)); left > 0; left -= size) out.push(Math.min(size, left));
  return out;
}

/**
 * Which approved copy each of the `n` visuals is made for: round-robin over
 * the approved copies in their order, so every template × copy gets one
 * before any gets two. Empty when nothing is approved.
 */
export function planSlots(copies: Array<{ id: string; templateId: string | null }>, n: number): Slot[] {
  const usable = copies.filter((c): c is { id: string; templateId: string } => !!c.templateId);
  if (!usable.length || n <= 0) return [];
  return Array.from({ length: Math.round(n) }, (_, i) => { const c = usable[i % usable.length]; return { copyId: c.id, templateId: c.templateId }; });
}

/**
 * One HTTP pass: the next ≤ `passSize` slots after `attempted`, grouped by
 * copy into fal calls of ≤ BATCH_SIZE (one prompt per call, n images).
 */
export function passPlan(slots: Slot[], attempted: number, passSize = PASS_SIZE): BatchPlan[] {
  const next = slots.slice(Math.max(0, attempted), Math.max(0, attempted) + passSize);
  const groups = new Map<string, BatchPlan>();
  for (const s of next) { const g = groups.get(s.copyId); if (g) g.count += 1; else groups.set(s.copyId, { ...s, count: 1 }); }
  const out: BatchPlan[] = [];
  for (const g of groups.values()) for (const count of splitBatches(g.count)) out.push({ ...g, count });
  return out;
}

export const estimateUsd = (unitUsd: number, n: number) => Math.round(Math.max(0, unitUsd) * Math.max(0, n) * 1000) / 1000;

/** Count of visuals still to try: n − attempted, never negative. */
export const remainingOf = (s: { n: number; attempted: number }) => Math.max(0, s.n - s.attempted);

// ── State machine ──────────────────────────────────────────────────────────

export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  draft: ["copy_review", "failed"],
  copy_review: ["copy_review", "approved", "generating", "failed"],
  approved: ["generating", "copy_review", "failed"],
  generating: ["generating", "review", "failed"],
  review: ["review", "done", "generating"],
  done: ["done", "review"],
  failed: ["copy_review", "failed"],
};

export const canTransition = (from: RunStatus, to: RunStatus) => RUN_TRANSITIONS[from]?.includes(to) ?? false;

/** Status after a pass: still generating while slots remain, review when every slot was tried, failed when all of them failed. */
export function statusAfterPass(s: { n: number; attempted: number; failed: number }): RunStatus {
  if (s.attempted < s.n) return "generating";
  return s.failed >= s.n ? "failed" : "review";
}

/** « review » becomes « done » when every generated visual has a verdict; a new verdict removed reopens it. */
export const statusAfterVerdicts = (s: { status: RunStatus; generated: number; kept: number; cut: number }): RunStatus =>
  s.status === "review" || s.status === "done" ? (s.generated > 0 && s.kept + s.cut >= s.generated ? "done" : "review") : s.status;

/** The Drive sub-folder of a run, inside the client's « Créas »: « Fabrique 2026-10-29 offer ». */
export function factoryFolderName(kind: FactoryKind, date = new Date()): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return `Fabrique ${ymd} ${kind}`;
}

/** File name of one visual in Drive: run date, template, copy, index. */
export const factoryFileName = (i: number, templateName: string, headline: string, ext: string) =>
  `${String(i + 1).padStart(2, "0")} ${templateName.slice(0, 30)} — ${headline.slice(0, 40)}.${ext}`.replace(/[\\/:*?"<>|]+/g, "-");
