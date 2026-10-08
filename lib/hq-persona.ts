/**
 * Personas of a client, the way HQ (the agency memory) documents them.
 *
 * HQ's method (skill `client-brain`, grid of skill `analyse-avatar`): the
 * personas of a client live in ONE file, projects/{slug}/brain/recherche/personas.md,
 * with a frontmatter of state (statut manquant | brouillon | a_confirmer |
 * confirme, source, maj, confirme_par, rafraichir_tous_les). They derive from
 * what the customers SAY (reviews → langage client → 5 to 7 prioritised
 * avatars → matrix persona × message × proof × objection). Two rules we keep:
 * without reviews there is no persona, only a clearly marked hypothesis; and
 * only a human confirms (`confirme` always carries `confirme_par`).
 *
 * This module: reads that file through the relay (deterministic, from code),
 * assembles what the AI is given (reviews pasted by the consultant, the HQ
 * folder, the ads copy of the Meta account), asks the relay for a draft, and
 * writes the confirmed file back to HQ under the ETag lock of the relay.
 */

import { prisma } from "@/lib/prisma";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { relayComplete, extractFence } from "@/lib/relay-chat";
import { PERSONA_PROFILE } from "@/lib/ai-profiles";
import { recordAiUsage, type UsageContext } from "@/lib/ai-usage";
import { HQ_PROJECT_RE } from "@/lib/hq-journal";
import { loadCreativeRows } from "@/lib/creatives-server";
import { lastFullDays } from "@/lib/date-ranges";

export const PERSONA_STATUSES = ["manquant", "brouillon", "a_confirmer", "confirme"] as const;
export type PersonaStatus = (typeof PERSONA_STATUSES)[number];

export interface PersonaFrontmatter {
  statut: PersonaStatus;
  source: string;
  maj: string;
  confirme_par: string;
  rafraichir_tous_les: string;
}

/** Default cadence of the artefact in HQ (knowledge/client-folder-spec.md). */
export const PERSONA_REFRESH_DAYS = 180;
/** Minimum amount of review text before the AI is allowed to call its output a persona. */
export const MIN_REVIEW_CHARS = 1500;
const MAX_REVIEW_CHARS = 60_000;
const MAX_HQ_FILE_CHARS = 12_000;
const MAX_ADS = 40;

export function personaPath(slug: string): string {
  return `projects/${slug}/brain/recherche/personas.md`;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

const DEFAULT_FM: PersonaFrontmatter = { statut: "manquant", source: "", maj: "", confirme_par: "", rafraichir_tous_les: `${PERSONA_REFRESH_DAYS}j` };

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Splits an HQ artefact into its frontmatter of state and its Markdown body. */
export function parsePersonaFile(text: string): { frontmatter: PersonaFrontmatter; body: string; hasFrontmatter: boolean } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: { ...DEFAULT_FM, statut: "brouillon" }, body: text.trim(), hasFrontmatter: false };
  const fm: PersonaFrontmatter = { ...DEFAULT_FM };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rawValue = kv[2].trim();
    // A quoted value keeps everything (a « # » inside is not a comment).
    const value = /^["']/.test(rawValue) ? unquote(rawValue) : rawValue.replace(/\s+#.*$/, "").trim();
    if (key === "statut") fm.statut = (PERSONA_STATUSES as readonly string[]).includes(value) ? (value as PersonaStatus) : "brouillon";
    else if (key === "source") fm.source = value;
    else if (key === "maj") fm.maj = value;
    else if (key === "confirme_par") fm.confirme_par = value;
    else if (key === "rafraichir_tous_les") fm.rafraichir_tous_les = value;
  }
  return { frontmatter: fm, body: text.slice(m[0].length).trim(), hasFrontmatter: true };
}

/** Writes the artefact back in HQ's format (same keys, same order as brain.sh). */
export function serializePersonaFile(fm: PersonaFrontmatter, body: string): string {
  const q = (v: string) => (v === "" ? '""' : /[:#"']/.test(v) ? JSON.stringify(v) : v);
  const lines = [
    "---",
    `statut: ${fm.statut}`,
    `source: ${q(fm.source)}`,
    `maj: ${fm.maj}`,
    `confirme_par: ${q(fm.confirme_par)}`,
    `rafraichir_tous_les: ${fm.rafraichir_tous_les || `${PERSONA_REFRESH_DAYS}j`}`,
    "---",
    "",
    body.trim(),
    "",
  ];
  return lines.join("\n");
}

/** Days since `maj` compared with the artefact's cadence; null when unknown. */
export function personaAgeDays(fm: Pick<PersonaFrontmatter, "maj">, now = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fm.maj)) return null;
  const t = Date.parse(`${fm.maj}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function personaIsStale(fm: PersonaFrontmatter, now = new Date()): boolean {
  const age = personaAgeDays(fm, now);
  const days = Number((fm.rafraichir_tous_les || "").replace(/j$/i, ""));
  if (age === null || !Number.isFinite(days) || days <= 0) return false;
  return age > days;
}

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// HQ through the relay
// ---------------------------------------------------------------------------

export interface HqFile { found: true; path: string; content: string; etag: string | null; lastModified: string | null }
export type HqFileResult = HqFile | { found: false };

/** One file of a client folder in HQ; throws when the relay or HQ is down. */
export async function readHqFile(path: string): Promise<HqFileResult> {
  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/hq/file?path=${encodeURIComponent(path)}`, { headers: relayHeaders(), signal: AbortSignal.timeout(40_000) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { lastError = json.error ?? `relay ${res.status}`; continue; }
      if (json.found !== true) return { found: false };
      return { found: true, path, content: String(json.content ?? ""), etag: json.etag ?? null, lastModified: json.lastModified ?? null };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`HQ inaccessible (${lastError})`);
}

export interface HqPersona {
  slug: string;
  path: string;
  frontmatter: PersonaFrontmatter;
  body: string;
  etag: string | null;
  lastModified: string | null;
  stale: boolean;
}

export async function readHqPersona(slug: string): Promise<HqPersona | null> {
  if (!HQ_PROJECT_RE.test(slug)) return null;
  const file = await readHqFile(personaPath(slug));
  if (!file.found) return null;
  const { frontmatter, body } = parsePersonaFile(file.content);
  return { slug, path: file.path, frontmatter, body, etag: file.etag, lastModified: file.lastModified, stale: personaIsStale(frontmatter) };
}

export type WriteOutcome = { ok: true; etag: string | null; created: boolean } | { ok: false; error: string; conflict?: boolean };

/**
 * Writes personas.md in HQ. `etag` = the one read just before (null for a
 * creation): the relay refuses when the file changed in between.
 */
export async function writeHqPersona(slug: string, content: string, etag: string | null): Promise<WriteOutcome> {
  if (!HQ_PROJECT_RE.test(slug)) return { ok: false, error: "Dossier HQ invalide." };
  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/hq/persona`, {
        method: "PUT",
        headers: relayHeaders(),
        body: JSON.stringify({ project: slug, content, etag }),
        signal: AbortSignal.timeout(60_000),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) return { ok: false, error: json.error ?? "Le fichier a changé dans HQ.", conflict: true };
      if (!res.ok) { lastError = json.error ?? `relay ${res.status}`; continue; }
      // Cached briefs predate this file: force a fresh read next time.
      await prisma.dashboard.updateMany({ where: { hqSlug: slug }, data: { hqContextAt: null } }).catch(() => {});
      return { ok: true, etag: json.etag ?? null, created: json.created === true };
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        return { ok: false, error: "HQ n'a pas répondu à temps : le fichier a peut-être été écrit. Relisez-le avant de réessayer." };
      }
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: `Écriture dans HQ impossible (${lastError})` };
}

// ---------------------------------------------------------------------------
// What the AI is given
// ---------------------------------------------------------------------------

/** HQ artefacts worth reading before writing personas, in the order they are shown. */
export const PERSONA_HQ_SOURCES = [
  { file: "brain/recherche/langage-client.md", label: "Langage client (sortie de l'analyse d'avis)" },
  { file: "brain/recherche/avis-sources.md", label: "Sources d'avis" },
  { file: "contexte.md", label: "Contexte du client" },
  { file: "brain/contenu/voix.md", label: "Voix de la marque" },
  { file: "brain/recherche/concurrents.md", label: "Concurrents" },
  { file: "brain/strategie/strategie.md", label: "Stratégie et contraintes business" },
] as const;

export interface PersonaInputs {
  clientName: string;
  hqSlug: string | null;
  hqBrief: string | null;
  /** HQ files actually read, with their content (trimmed). */
  hqFiles: Array<{ path: string; label: string; content: string; statut: PersonaStatus | null }>;
  existing: HqPersona | null;
  reviews: string;
  reviewsSource: string;
  notes: string;
  ads: Array<{ name: string; headline: string; body: string; landingUrl: string; spend: number; cpa: number | null; status: string }>;
  adsWarning: string | null;
}

export interface PersonaInputSummary {
  reviewsChars: number;
  reviewsSource: string;
  hqFiles: string[];
  ads: number;
  notes: string;
  hasExisting: boolean;
}

export function summarizeInputs(i: PersonaInputs): PersonaInputSummary {
  return {
    reviewsChars: i.reviews.length,
    reviewsSource: i.reviewsSource,
    hqFiles: i.hqFiles.map((f) => f.path),
    ads: i.ads.length,
    notes: i.notes.slice(0, 500),
    hasExisting: !!i.existing,
  };
}

/** True when the consultant gave enough customer words for a real persona (HQ rule). */
export function hasEnoughReviews(i: Pick<PersonaInputs, "reviews" | "hqFiles">): boolean {
  if (i.reviews.trim().length >= MIN_REVIEW_CHARS) return true;
  const langage = i.hqFiles.find((f) => f.path.endsWith("langage-client.md"));
  return !!langage && langage.content.length >= MIN_REVIEW_CHARS && langage.statut !== "manquant";
}

export async function collectPersonaInputs(args: {
  dashboard: { id: string; name: string; metaAccountId: string | null; hqSlug: string | null; hqContextMd: string | null };
  reviews?: string;
  reviewsSource?: string;
  notes?: string;
}): Promise<PersonaInputs> {
  const d = args.dashboard;
  const inputs: PersonaInputs = {
    clientName: d.name,
    hqSlug: d.hqSlug,
    hqBrief: d.hqContextMd,
    hqFiles: [],
    existing: null,
    reviews: (args.reviews ?? "").trim().slice(0, MAX_REVIEW_CHARS),
    reviewsSource: (args.reviewsSource ?? "").trim().slice(0, 200),
    notes: (args.notes ?? "").trim().slice(0, 4000),
    ads: [],
    adsWarning: null,
  };

  const jobs: Array<Promise<void>> = [];

  if (d.hqSlug && HQ_PROJECT_RE.test(d.hqSlug)) {
    const slug = d.hqSlug;
    jobs.push(
      readHqPersona(slug).then((p) => { inputs.existing = p; }).catch(() => { /* HQ down: the draft is still possible */ }),
      ...PERSONA_HQ_SOURCES.map((src) =>
        readHqFile(`projects/${slug}/${src.file}`)
          .then((f) => {
            if (!f.found) return;
            const parsed = parsePersonaFile(f.content);
            // A skeleton (statut manquant, no body) says nothing: skip it.
            if (parsed.hasFrontmatter && parsed.frontmatter.statut === "manquant" && parsed.body.length < 200) return;
            if (parsed.body.length < 40) return;
            inputs.hqFiles.push({ path: f.path, label: src.label, content: parsed.body.slice(0, MAX_HQ_FILE_CHARS), statut: parsed.hasFrontmatter ? parsed.frontmatter.statut : null });
          })
          .catch(() => { /* one file missing or HQ down is not fatal */ }),
      ),
    );
  }

  if (d.metaAccountId) {
    const accountId = d.metaAccountId;
    jobs.push(
      loadCreativeRows(accountId, lastFullDays(90))
        .then((payload) => {
          const rows = [...payload.creatives]
            .filter((c) => (c.headline || c.body) && c.spend > 0)
            .sort((a, b) => b.spend - a.spend)
            .slice(0, MAX_ADS);
          inputs.ads = rows.map((c) => ({
            name: c.name,
            headline: (c.headline ?? "").slice(0, 200),
            body: (c.body ?? "").slice(0, 600),
            landingUrl: (c.landingUrl ?? "").slice(0, 200),
            spend: Math.round(c.spend),
            cpa: c.cpa > 0 ? Math.round(c.cpa * 100) / 100 : null,
            status: c.status,
          }));
        })
        .catch((e) => { inputs.adsWarning = `Créas Meta non lues (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`; }),
    );
  }

  await Promise.all(jobs);
  // Keep the HQ files in the documented order.
  inputs.hqFiles.sort((a, b) => PERSONA_HQ_SOURCES.findIndex((s) => a.path.endsWith(s.file)) - PERSONA_HQ_SOURCES.findIndex((s) => b.path.endsWith(s.file)));
  return inputs;
}

// ---------------------------------------------------------------------------
// Prompt (the grid of HQ's skill analyse-avatar, written for the consultant)
// ---------------------------------------------------------------------------

export const PERSONA_SYSTEM_PROMPT = `Tu es stratège senior en réponse directe chez Impulse Analytics (agence paid media). Tu rédiges, pour UN client, le fichier « Personas et matrice de messages » tel qu'HQ (la mémoire de l'agence) le documente : skill client-brain, grille du skill analyse-avatar. Ce fichier sert ensuite aux copywriters et aux consultants pour écrire des ads, des landing pages et des briefs sans repartir de zéro. Tu écris en français (sauf verbatims : langue d'origine), sans tics d'écriture IA.

RÈGLE FONDATRICE D'HQ — « vide et marqué plutôt que plausible et faux » :
- Un persona se déduit de ce que les CLIENTS DISENT (avis, verbatims, langage client). Sans avis lisibles en quantité suffisante, tu ne produis PAS de persona : tu produis des HYPOTHÈSES DE PERSONAS, clairement intitulées ainsi, déduites du site, des ads et des concurrents, et tu listes ce qu'il faudrait collecter pour les confirmer. Le mode à appliquer t'est indiqué (MODE : persona | hypothese).
- Chaque affirmation porte sa source : un verbatim cite l'avis, une déduction est marquée [INFÉRÉ], un chiffre vient des données fournies ou n'existe pas. N'invente ni chiffre ni verbatim.
- Tu ne recopies pas de chiffres de performance au-delà de ce qui t'est donné (dépense, CPA) ; tu n'inventes jamais d'identifiant.

GRILLE (analyse-avatar) — produire 5 à 7 avatars (4 minimum si le marché est étroit, le dire), puis les prioriser.
Pour chaque avatar :
- Nom évocateur + archétype (ex. « Hélène, la stratège des concours »)
- Démographie : âge, genre, étape de vie, CSP si déductible
- Psychographie : valeurs, motivations, peurs
- Frictions du quotidien : ce qui rend sa vie difficile par rapport au problème que résout le produit
- Émotion dominante
- Identité désirée : comment il/elle veut être perçu(e)
- Image du succès : la « victoire » avec ses propres mots
- Douleurs principales
- Résultats attendus
- Déclencheurs d'achat et objections probables
- Niveau de conscience (Schwartz, 1 à 5)
- Verbatims « Voice » : 2 à 4 phrases clients brutes (seulement si des avis sont fournis)
Puis :
- Priorisation explicite (biais de marché, potentiel CPA/LTV, poids dans les avis), justifiée en une phrase par avatar
- Angles de message : au moins 3 par avatar, typés (peur, commodité, preuve scientifique, mode de vie, identité, prix, urgence…)
- Drivers émotionnels et hooks : 15 à 20 amorces de titres, < 15 mots, étiquetées par driver (peur, désir, identité, aspiration, frustration)
- Positionnement de l'offre par avatar : niveau de valeur (premium, budget, raccourci, choix le plus sûr…), avantage concurrentiel, « pourquoi ce produit plutôt qu'un autre » en 1 à 2 phrases
- Banque de trames : 3 à 5 structures d'advertorial / vidéo (transformation personnelle, découverte d'expert, tendance culturelle, rapport problème/solution, accroche saisonnière…), 2 à 3 phrases chacune, pour CE produit
- MATRICE DE MESSAGES : un tableau Markdown persona × message principal × preuve (verbatim, chiffre fourni, garantie…) × objection à lever × réponse à l'objection

FORMAT DE SORTIE — un seul bloc \`\`\`markdown contenant le CORPS du fichier (sans frontmatter YAML, l'app l'ajoute) :
# Personas et matrice de messages
> une ligne : à quoi sert ce fichier pour ce client
**Sources :** liste des sources réellement utilisées (avis fournis : volume et provenance ; fichiers HQ lus ; ads lues ; site), rien d'autre.
**Pourquoi ces personas.** 3 à 6 lignes : comment ils ont été dérivés et priorisés.
**Règles d'usage :** 2 à 4 puces (garde-fous repris des fichiers HQ : voix, interdits, claims).
Tableau récapitulatif : | # | Persona | Segment / offre | Poids ou indice | Priorité |
---
## PERSONA n : « Nom »  (une section par avatar, sous-sections ### 1. Identité & psychologie, ### 2. Matrice de transformation (enfer → paradis), ### 3. Parcours client (trigger, points de contact, objections), ### 4. Angles de message, ### 5. Positionnement de l'offre)
---
## Drivers émotionnels et hooks
## Banque de trames
## Matrice de messages
## À collecter pour confirmer  (uniquement ce qui manque ; en mode hypothese, cette section est obligatoire et détaillée)

En mode hypothese, le titre devient « # Hypothèses de personas (à confirmer par des avis clients) » et chaque avatar porte la mention « Hypothèse » dans son titre.
Longueur : 1 500 à 3 500 mots. Pas de texte hors du bloc markdown.`;

export function buildPersonaUserPrompt(i: PersonaInputs, mode: "persona" | "hypothese"): string {
  const parts: string[] = [];
  parts.push(`CLIENT : ${i.clientName}${i.hqSlug ? ` (dossier HQ : projects/${i.hqSlug})` : " (pas de dossier HQ rattaché)"}`);
  parts.push(`MODE : ${mode}${mode === "hypothese" ? " — avis clients insuffisants : produire des HYPOTHÈSES de personas, pas des personas." : ""}`);
  if (i.notes) parts.push(`\nCONSIGNES DU CONSULTANT :\n${i.notes}`);
  if (i.hqBrief) parts.push(`\nBRIEF HQ DU CLIENT (objectifs, KPI, contexte) :\n${i.hqBrief.replace(/<\/?contexte_hq>/gi, "").trim().slice(0, 6000)}`);
  for (const f of i.hqFiles) {
    parts.push(`\nFICHIER HQ — ${f.label} (${f.path}${f.statut ? `, statut ${f.statut}` : ""}) :\n${f.content}`);
  }
  if (i.existing && i.existing.body.length > 200) {
    parts.push(`\nFICHIER PERSONAS EXISTANT DANS HQ (statut ${i.existing.frontmatter.statut}, maj ${i.existing.frontmatter.maj || "?"}) — à améliorer et compléter, en gardant ce qui est confirmé ou sourcé :\n${i.existing.body.slice(0, 20_000)}`);
  }
  if (i.reviews) {
    parts.push(`\nAVIS CLIENTS FOURNIS PAR LE CONSULTANT${i.reviewsSource ? ` (provenance : ${i.reviewsSource})` : ""} — ${i.reviews.length} caractères :\n<avis>\n${i.reviews}\n</avis>`);
  } else {
    parts.push("\nAVIS CLIENTS : aucun fourni.");
  }
  if (i.ads.length) {
    const lines = i.ads.map((a, n) => `${n + 1}. [${a.status}] ${a.name} — dépense ${a.spend} €${a.cpa !== null ? `, CPA ${a.cpa} €` : ""}\n   Titre : ${a.headline || "—"}\n   Texte : ${(a.body || "—").replace(/\s+/g, " ")}${a.landingUrl ? `\n   Lien : ${a.landingUrl}` : ""}`);
    parts.push(`\nADS META DU COMPTE (90 derniers jours, ${i.ads.length} créas les plus dépensées) — ce que la marque dit aujourd'hui, pas ce que les clients disent :\n${lines.join("\n")}`);
  } else if (i.adsWarning) {
    parts.push(`\nADS META : ${i.adsWarning}`);
  }
  parts.push("\nRédige le fichier.");
  return parts.join("\n");
}

export function parsePersonaOutput(raw: string): string | null {
  const fence = extractFence(raw, "markdown") ?? extractFence(raw, "md");
  const body = (fence ? fence.inner : raw).trim();
  if (body.length < 400 || !/^#\s/m.test(body)) return null;
  return body;
}

export async function generatePersonaDraft(
  inputs: PersonaInputs,
  opts: { maxMs?: number; usage?: { dashboardId: string; user?: UsageContext["user"] } },
): Promise<{ markdown: string; kind: "persona" | "hypothese" }> {
  const kind = hasEnoughReviews(inputs) ? "persona" : "hypothese";
  const raw = await relayComplete(
    {
      messages: [{ role: "user", content: buildPersonaUserPrompt(inputs, kind) }],
      systemPrompt: PERSONA_SYSTEM_PROMPT,
      allowedServers: [],
      accountScope: {},
      model: PERSONA_PROFILE.model,
      effort: PERSONA_PROFILE.effort,
      maxTurns: PERSONA_PROFILE.maxTurns,
    },
    {
      maxMs: opts.maxMs ?? 280_000,
      onUsage: (usage) => void recordAiUsage(usage, { feature: "persona", clientName: inputs.clientName, dashboardId: opts.usage?.dashboardId ?? null, user: opts.usage?.user }),
    },
  );
  const markdown = parsePersonaOutput(raw);
  if (!markdown) throw new Error("L'IA n'a pas rendu un fichier lisible : réessayez.");
  return { markdown, kind };
}
