/**
 * Propositions du copilote d'un dashboard du staff — protocole partagé entre
 * le navigateur (panneau, application après « Appliquer ») et le serveur
 * (prompt, tests). Sans dépendance Node : importable côté client.
 *
 * L'IA émet des blocs ```action contenant UN objet JSON :
 *   {"action":"set_title","title":"…","description":"…"}
 *   {"action":"set_dataset","id":"g_spend","dataset":{"title":"…","description":"…","source":{"connector":"…","tool":"…","args":{…}}}}
 *   {"action":"remove_dataset","id":"g_spend"}
 *   {"action":"set_params","params":{…}}                       (remplace tous les paramètres)
 *   {"action":"set_sources","sources":[{"kind":"google","accounts":[{"id":"…","name":"…"}],"detail":"…"}]} (remplace les sources cochées)
 *   {"action":"edit_html","find":"…","replace":"…","all":false} (remplacement exact, unique sauf all)
 *   {"action":"set_html"}  suivi d'un bloc ```html = la page entière (ou {"action":"set_html","html":"…"})
 * Rien n'est appliqué sans un clic du consultant : le navigateur calcule le
 * nouvel état avec applyProposal puis l'envoie à PUT /api/staff-dashboards/[id],
 * qui revalide tout (parseDatasets, tailles, droits).
 */

import { connectorServer, DATASET_ID_RE, PARAM_NAME_RE } from "./connectors";
import { parseSources, sourceSummary, type StaffSource } from "./sources";

export interface ProposalDataset {
  title: string;
  description?: string;
  source: { kind?: "query"; connector: string; tool: string; args: Record<string, unknown> };
}

export type StaffProposal =
  | { action: "set_title"; title?: string; description?: string }
  | { action: "set_dataset"; id: string; dataset: ProposalDataset }
  | { action: "remove_dataset"; id: string }
  | { action: "set_params"; params: Record<string, unknown> }
  | { action: "set_sources"; sources: StaffSource[] }
  | { action: "edit_html"; find: string; replace: string; all?: boolean }
  | { action: "set_html"; html: string };

/** L'état d'un dashboard tel que les propositions le transforment. */
export interface StaffDashboardState {
  title: string;
  description: string;
  datasets: Record<string, ProposalDataset>;
  params: Record<string, unknown>;
  html: string;
  /** Sources cochées par le consultant (absent sur un état ancien = aucune). */
  sources?: StaffSource[];
}

export interface ExtractedProposal {
  /** Rang du bloc dans le message (clé stable : `${message}-${index}`). */
  index: number;
  proposal: StaffProposal;
}

export const MAX_HTML_CHARS = 256 * 1024;
export const MAX_DATASETS = 40;

/** Empreinte courte et stable (FNV-1a 32 bits, en hexadécimal) — la même dans le navigateur et sur le serveur. */
export function htmlHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(16).padStart(8, "0")}`;
}

// Un bloc ``` : le mot après les accents est le langage (vide pour un bloc nu).
const FENCE_RE = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

function parseActionJson(inner: string): Record<string, unknown> | null {
  const text = inner.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.action === "string") return parsed as Record<string, unknown>;
  } catch { /* pas une proposition */ }
  return null;
}

/** Lit les blocs d'un message : chaque bloc JSON à `action` (```action, ```json ou nu) ; set_html sans `html` prend le bloc suivant. */
export function extractProposals(content: string): ExtractedProposal[] {
  const fences: Array<{ lang: string; inner: string }> = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(content))) fences.push({ lang: m[1].toLowerCase(), inner: m[2] });
  const out: ExtractedProposal[] = [];
  for (let i = 0; i < fences.length; i++) {
    const raw = parseActionJson(fences[i].inner);
    if (!raw) continue;
    if (raw.action === "set_html" && typeof raw.html !== "string") {
      const next = fences[i + 1];
      if (!next || parseActionJson(next.inner)) continue; // set_html sans page : ignoré
      out.push({ index: i, proposal: { action: "set_html", html: next.inner.replace(/\s+$/, "") } });
      i++;
      continue;
    }
    const p = coerceProposal(raw);
    if (p) out.push({ index: i, proposal: p });
  }
  return out;
}

/** Retire du texte les blocs reconnus comme propositions (les autres restent visibles). */
export function stripProposalBlocks(content: string): string {
  const known = new Set<number>();
  const fences: string[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(content))) fences.push(m[2]);
  for (let i = 0; i < fences.length; i++) {
    const raw = parseActionJson(fences[i]);
    if (!raw) continue;
    known.add(i);
    if (raw.action === "set_html" && typeof raw.html !== "string" && fences[i + 1] !== undefined && !parseActionJson(fences[i + 1])) known.add(++i);
  }
  let k = 0;
  return content.replace(FENCE_RE, (full) => (known.has(k++) ? "" : full)).replace(/\n{3,}/g, "\n\n").trim();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Un objet JSON à `action` → une proposition typée, ou null si la forme n'est pas reconnue. */
export function coerceProposal(raw: Record<string, unknown>): StaffProposal | null {
  switch (raw.action) {
    case "set_title": {
      const title = str(raw.title), description = str(raw.description);
      return title === undefined && description === undefined ? null : { action: "set_title", ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}) };
    }
    case "set_dataset": {
      const id = str(raw.id);
      const d = raw.dataset && typeof raw.dataset === "object" ? (raw.dataset as Record<string, unknown>) : null;
      const src = d?.source && typeof d.source === "object" ? (d.source as Record<string, unknown>) : null;
      if (!id || !d || !src) return null;
      const connector = str(src.connector), tool = str(src.tool);
      if (!connector || !tool) return null;
      const args = src.args && typeof src.args === "object" && !Array.isArray(src.args) ? (src.args as Record<string, unknown>) : {};
      return { action: "set_dataset", id, dataset: { title: str(d.title) ?? id, ...(str(d.description) ? { description: str(d.description) } : {}), source: { kind: "query", connector, tool, args } } };
    }
    case "remove_dataset": {
      const id = str(raw.id);
      return id ? { action: "remove_dataset", id } : null;
    }
    case "set_params":
      return raw.params && typeof raw.params === "object" && !Array.isArray(raw.params) ? { action: "set_params", params: raw.params as Record<string, unknown> } : null;
    case "set_sources":
      return Array.isArray(raw.sources) ? { action: "set_sources", sources: parseSources(raw.sources) } : null;
    case "edit_html": {
      const find = str(raw.find), replace = str(raw.replace);
      return find !== undefined && replace !== undefined ? { action: "edit_html", find, replace, ...(raw.all === true ? { all: true } : {}) } : null;
    }
    case "set_html": {
      const html = str(raw.html);
      return html !== undefined ? { action: "set_html", html } : null;
    }
    default:
      return null;
  }
}

/** Libellé court d'une proposition, pour la carte et pour les retours faits à l'IA. */
export function proposalLabel(p: StaffProposal): string {
  switch (p.action) {
    case "set_title": return p.title !== undefined ? `Renommer en « ${p.title} »` : "Changer la description";
    case "set_dataset": return `Jeu de données « ${p.id} » (${p.dataset.source.connector} · ${p.dataset.source.tool})`;
    case "remove_dataset": return `Supprimer le jeu de données « ${p.id} »`;
    case "set_params": return `Paramètres : ${Object.keys(p.params).join(", ") || "aucun"}`;
    case "set_sources": return `Sources : ${p.sources.map(sourceSummary).join(", ") || "aucune"}`;
    case "edit_html": return `Modifier la page (${p.find.length} → ${p.replace.length} caractères${p.all ? ", toutes les occurrences" : ""})`;
    case "set_html": return `Remplacer la page entière (${p.html.length.toLocaleString("fr-FR")} caractères)`;
  }
}

function countOccurrences(text: string, find: string): number {
  if (!find) return 0;
  let n = 0, i = 0;
  while ((i = text.indexOf(find, i)) >= 0) { n++; i += find.length; }
  return n;
}

/**
 * Applique une proposition à un état et rend le nouvel état. Lève une erreur
 * (message en français) si la proposition ne peut pas s'appliquer : texte
 * introuvable ou ambigu, identifiant ou connecteur invalide, page trop grande.
 */
export function applyProposal(state: StaffDashboardState, p: StaffProposal): StaffDashboardState {
  switch (p.action) {
    case "set_title": {
      const title = p.title !== undefined ? p.title.trim().slice(0, 120) : state.title;
      if (!title) throw new Error("Le titre ne peut pas être vide.");
      return { ...state, title, description: p.description !== undefined ? p.description.trim().slice(0, 2000) : state.description };
    }
    case "set_dataset": {
      if (!DATASET_ID_RE.test(p.id)) throw new Error(`Identifiant de jeu invalide : « ${p.id} » (lettres, chiffres, _ ou -, 64 caractères au plus).`);
      if (!connectorServer(p.dataset.source.connector)) throw new Error(`Connecteur inconnu : « ${p.dataset.source.connector} ».`);
      const datasets = { ...state.datasets, [p.id]: p.dataset };
      if (Object.keys(datasets).length > MAX_DATASETS) throw new Error(`${MAX_DATASETS} jeux de données au plus.`);
      return { ...state, datasets };
    }
    case "remove_dataset": {
      if (!(p.id in state.datasets)) throw new Error(`Le jeu de données « ${p.id} » n'existe pas.`);
      const datasets = { ...state.datasets };
      delete datasets[p.id];
      return { ...state, datasets };
    }
    case "set_params": {
      const bad = Object.keys(p.params).filter((k) => !PARAM_NAME_RE.test(k));
      if (bad.length) throw new Error(`Nom de paramètre invalide : ${bad.join(", ")}.`);
      return { ...state, params: p.params };
    }
    case "set_sources":
      return { ...state, sources: parseSources(p.sources) };
    case "edit_html": {
      if (!p.find) throw new Error("edit_html : le texte à chercher est vide.");
      const n = countOccurrences(state.html, p.find);
      if (n === 0) throw new Error("Le texte à remplacer n'apparaît pas dans la page (elle a peut-être changé) : demandez à l'IA de relire la page.");
      if (n > 1 && !p.all) throw new Error(`Le texte à remplacer apparaît ${n} fois dans la page : la proposition est ambiguë, demandez une version plus précise.`);
      const html = p.all ? state.html.split(p.find).join(p.replace) : state.html.replace(p.find, () => p.replace);
      if (html.length > MAX_HTML_CHARS) throw new Error(`Page trop grande après modification (max ${MAX_HTML_CHARS.toLocaleString("fr-FR")} caractères).`);
      return { ...state, html };
    }
    case "set_html": {
      if (p.html.length > MAX_HTML_CHARS) throw new Error(`Page trop grande (max ${MAX_HTML_CHARS.toLocaleString("fr-FR")} caractères).`);
      return { ...state, html: p.html };
    }
  }
}

/** Vérifie qu'une proposition s'appliquerait à l'état donné ; null si oui, sinon le message. */
export function proposalProblem(state: StaffDashboardState, p: StaffProposal): string | null {
  try { applyProposal(state, p); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** Les champs changés entre deux états, pour PUT /api/staff-dashboards/[id]. */
export function stateDiff(before: StaffDashboardState, after: StaffDashboardState): Partial<Record<"title" | "description" | "datasets" | "params" | "html" | "sources", unknown>> {
  const out: Partial<Record<"title" | "description" | "datasets" | "params" | "html" | "sources", unknown>> = {};
  if (after.title !== before.title) out.title = after.title;
  if (after.description !== before.description) out.description = after.description;
  if (JSON.stringify(after.datasets) !== JSON.stringify(before.datasets)) out.datasets = after.datasets;
  if (JSON.stringify(after.params) !== JSON.stringify(before.params)) out.params = after.params;
  if (after.html !== before.html) out.html = after.html;
  if (JSON.stringify(after.sources ?? []) !== JSON.stringify(before.sources ?? [])) out.sources = after.sources ?? [];
  return out;
}
