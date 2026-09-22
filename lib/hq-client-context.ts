/**
 * "What does the agency already know about this client?" — read from HQ
 * (hqforwork.com, the agency memory) BEFORE an AI report is written, so the
 * report is judged against the client's real objectives (KPI cible, modèle,
 * saisonnalité, décisions et tests récents) instead of the numbers alone.
 *
 * How it reads HQ: through the relay, the same read-only HQ tools the staff
 * console uses (server/relay.mjs HQ_READ_TOOLS). The CLI is told exactly
 * which files of projects/{slug}/ to open (client.yaml is the source of truth,
 * prose files are context) and to answer with one JSON fence — a short,
 * low-effort session, not an open-ended exploration.
 *
 * Token discipline: the brief is cached on the Dashboard (hqContextMd /
 * hqContextAt) for HQ_CONTEXT_TTL_MS. Weekly reports therefore cost one HQ
 * session per client per week at most; the report chat reuses the brief
 * stored in the report snapshot for free.
 */

import { prisma } from "@/lib/prisma";
import { relayComplete, extractFence, parseLooseJson } from "@/lib/relay-chat";
import { HQ_CONTEXT_PROFILE } from "@/lib/ai-profiles";
import { HQ_SERVER } from "@/lib/mcp-whitelist";

export interface HqClientContext {
  /** projects/{slug} in HQ. */
  slug: string;
  /** Compact Markdown brief (≤ ~500 words) with fixed headings. */
  brief: string;
  /** Files actually read (relative to the HQ company root). */
  sources: string[];
  fetchedAt: string;
}

export interface HqContextLookupResult {
  found: boolean;
  slug?: string;
  brief?: string;
  sources?: string[];
  reason?: string;
}

export const HQ_CONTEXT_TTL_MS = Number(process.env.HQ_CONTEXT_TTL_MS || 7 * 24 * 3600 * 1000);
const MAX_BRIEF_CHARS = 6000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** "Saveurs & Vie" → "saveursvie", used to shortlist a project slug. */
export function normalizeClientName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function isValidHqSlug(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG_RE.test(slug);
}

export const HQ_CONTEXT_SYSTEM_PROMPT = `Tu es l'assistant de lecture d'HQ (mémoire de l'agence Impulse Analytics, company "impulse-analytics"). Ta seule tâche : retrouver le dossier d'un client dans HQ et en tirer un brief court pour le consultant qui va rédiger son rapport de performance. Tu n'écris rien dans HQ.

PROCÉDURE (pas d'exploration au-delà)
1. Identifier le slug du client dans projects/ :
   - si un slug est fourni (SLUG HQ), utilise-le tel quel ;
   - sinon lis le fichier "clients.yaml" (hq_files_read) : la clé de la section "clients" dont "nom" correspond au client, ou dont le dossier projects/{slug}/client.yaml porte le même account_id Meta / customer_id Google que ceux fournis. En cas de doute, hq_files_list sur "projects".
2. Lire, avec hq_files_read, ces fichiers de projects/{slug}/ — ignore silencieusement ceux qui n'existent pas, ne cherche rien d'autre :
   client.yaml, README.md, contexte.md, historique.md, brain/strategie/strategie.md, brain/analyse/tests.md, brain/equipe/interlocuteurs.md
3. Répondre UNIQUEMENT par un bloc \`\`\`json (aucun texte autour) :
{"found": true, "slug": "…", "sources": ["projects/…/client.yaml", …], "brief": "…"}
ou, si aucun dossier ne correspond : {"found": false, "reason": "…"}

CONTENU DU BRIEF (Markdown, 500 mots maximum, titres de niveau 3 exactement ainsi, une section absente = omise) :
### Client
Secteur, pays, site, modèle (lead_gen | ecommerce | notoriete), consultant référent.
### Objectifs & KPI cible
KPI principal, événement de conversion piloté (nom exact), cibles chiffrées (CPL max, ROAS min, CPM max…), budget si indiqué.
### Saisonnalité & contexte marché
Périodes et effets attendus, concurrents, contraintes.
### Décisions & historique
Décisions structurantes datées, les plus récentes d'abord (10 max).
### Tests en cours
Hypothèses, variantes, résultats, décisions du journal de tests (les plus récents, 8 max).
### Règles & points d'attention
Règles non négociables du compte, anomalies connues (ex. fuseau horaire du compte, accès partiel), exclusions.

RÈGLES
- Uniquement ce que disent les fichiers : n'invente rien, ne complète pas avec des généralités. Une valeur absente = ne pas la mentionner.
- Aucun secret, aucun token, aucun identifiant technique autre que les ids de comptes publicitaires.
- Reste factuel et compact : phrases courtes, puces, dates au format AAAA-MM-JJ.`;

export function buildHqContextUserPrompt(input: { name: string; metaAccountId: string | null; googleCustomerId: string | null; slug?: string | null }): string {
  const lines = [`CLIENT : ${input.name}`];
  if (input.slug) lines.push(`SLUG HQ : ${input.slug}`);
  if (input.metaAccountId) lines.push(`COMPTE META ADS : ${input.metaAccountId} (act_${input.metaAccountId})`);
  if (input.googleCustomerId) lines.push(`COMPTE GOOGLE ADS : ${input.googleCustomerId}`);
  lines.push("", "Retrouve le dossier de ce client dans HQ et renvoie le brief JSON.");
  return lines.join("\n");
}

/** Parses the CLI answer; tolerant to prose around the fence, strict on shape. */
export function parseHqContextOutput(raw: string): HqContextLookupResult {
  const fence = extractFence(raw, "json");
  const parsed = parseLooseJson<Record<string, unknown>>(fence ? fence.inner : raw);
  if (!parsed || typeof parsed !== "object") return { found: false, reason: "réponse HQ illisible" };
  if (parsed.found !== true) {
    return { found: false, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "aucun dossier HQ trouvé" };
  }
  const slug = typeof parsed.slug === "string" ? parsed.slug.trim().toLowerCase() : "";
  const brief = typeof parsed.brief === "string" ? parsed.brief.trim() : "";
  if (!isValidHqSlug(slug) || brief.length < 40) return { found: false, reason: "brief HQ vide ou slug invalide" };
  const sources = Array.isArray(parsed.sources)
    ? parsed.sources.filter((s): s is string => typeof s === "string" && s.length < 200).slice(0, 12)
    : [];
  return { found: true, slug, brief: brief.slice(0, MAX_BRIEF_CHARS), sources };
}

type DashboardForHq = { id: string; name: string; metaAccountId: string | null; googleCustomerId: string | null; hqSlug: string | null; hqContextMd: string | null; hqContextAt: Date | null };

export function isHqContextFresh(d: Pick<DashboardForHq, "hqContextMd" | "hqContextAt">, now = Date.now()): boolean {
  return !!d.hqContextMd && !!d.hqContextAt && now - d.hqContextAt.getTime() < HQ_CONTEXT_TTL_MS;
}

/** One relay session with HQ read tools; throws when the relay is down. */
export async function lookupHqClientContext(
  input: { name: string; metaAccountId: string | null; googleCustomerId: string | null; slug?: string | null },
  opts: { maxMs?: number } = {},
): Promise<HqContextLookupResult> {
  const raw = await relayComplete(
    {
      messages: [{ role: "user", content: buildHqContextUserPrompt(input) }],
      systemPrompt: HQ_CONTEXT_SYSTEM_PROMPT,
      allowedServers: [HQ_SERVER],
      accountScope: {},
      model: HQ_CONTEXT_PROFILE.model,
      effort: HQ_CONTEXT_PROFILE.effort,
      maxTurns: HQ_CONTEXT_PROFILE.maxTurns,
    },
    { maxMs: opts.maxMs ?? 90_000 },
  );
  return parseHqContextOutput(raw);
}

/**
 * Cached brief for a dashboard. Refreshes through the relay when missing or
 * older than the TTL (or `force`), and never throws: a report without HQ
 * context is still a report — the caller reads `warning`.
 */
export async function getHqClientContext(
  dashboardId: string,
  opts: { force?: boolean; maxMs?: number } = {},
): Promise<{ context: HqClientContext | null; warning: string | null; cached: boolean }> {
  const d = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: { id: true, name: true, metaAccountId: true, googleCustomerId: true, hqSlug: true, hqContextMd: true, hqContextAt: true },
  });
  if (!d) return { context: null, warning: "dashboard introuvable", cached: false };

  if (!opts.force && isHqContextFresh(d) && d.hqSlug) {
    return { context: { slug: d.hqSlug, brief: d.hqContextMd!, sources: [], fetchedAt: d.hqContextAt!.toISOString() }, warning: null, cached: true };
  }

  try {
    const result = await lookupHqClientContext(
      { name: d.name, metaAccountId: d.metaAccountId, googleCustomerId: d.googleCustomerId, slug: d.hqSlug },
      { maxMs: opts.maxMs },
    );
    if (!result.found) {
      // Keep a stale brief rather than nothing; just say why it was not refreshed.
      const stale = d.hqSlug && d.hqContextMd && d.hqContextAt
        ? { slug: d.hqSlug, brief: d.hqContextMd, sources: [], fetchedAt: d.hqContextAt.toISOString() }
        : null;
      return { context: stale, warning: `HQ : ${result.reason ?? "dossier client introuvable"}`, cached: !!stale };
    }
    const fetchedAt = new Date();
    await prisma.dashboard.update({
      where: { id: d.id },
      data: { hqSlug: result.slug, hqContextMd: result.brief, hqContextAt: fetchedAt },
    });
    return { context: { slug: result.slug!, brief: result.brief!, sources: result.sources ?? [], fetchedAt: fetchedAt.toISOString() }, warning: null, cached: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stale = d.hqSlug && d.hqContextMd && d.hqContextAt
      ? { slug: d.hqSlug, brief: d.hqContextMd, sources: [], fetchedAt: d.hqContextAt.toISOString() }
      : null;
    return { context: stale, warning: `HQ indisponible (${msg.slice(0, 160)})${stale ? " — brief précédent utilisé" : ""}`, cached: !!stale };
  }
}
