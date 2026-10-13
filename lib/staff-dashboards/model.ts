/**
 * « Mes dashboards » (staff) — modèle et helpers purs.
 *
 * Un dashboard = des jeux de données (chacun UN appel d'outil du relay), des
 * paramètres (filtres) et une page HTML rendue dans un cadre isolé avec le
 * runtime public/dash-runtime.js. Même forme que le type « Dashboard » de
 * Claude : une page écrite là-bas se colle ici telle quelle.
 */

import { GENERATED_TEMPLATES } from "./templates/generated";

import { connectorServer, DATASET_ID_RE, PARAM_NAME_RE } from "./connectors";

export { connectorServer, DATASET_ID_RE, PARAM_NAME_RE };
export const MAX_DATASETS = 40;
export const MAX_HTML_CHARS = 256 * 1024;
export const MAX_TITLE_CHARS = 120;

export type ParamValue = string | number | boolean | null | Array<string | number>;

export interface DatasetSource {
  kind: "query";
  /** Nom du connecteur tel que le consultant l'appelle (« n8n google ads », « mcp facebook »…) ou nom du serveur du relay. */
  connector: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface Dataset {
  title: string;
  description?: string;
  source: DatasetSource;
}

export interface DashboardDefinition {
  datasets: Record<string, Dataset>;
  params: Record<string, ParamValue>;
}

function text(v: unknown, max = 500): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Lit et nettoie `datasetsJson` ; une entrée illisible est écartée (et nommée dans `errors`). */
export function parseDatasets(raw: unknown): { datasets: Record<string, Dataset>; errors: string[] } {
  const errors: string[] = [];
  const datasets: Record<string, Dataset> = {};
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return { datasets, errors: ["JSON des jeux de données illisible"] }; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { datasets, errors: ["Les jeux de données doivent être un objet { id: { title, source } }"] };
  for (const [id, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!DATASET_ID_RE.test(id)) { errors.push(`Identifiant de jeu invalide : « ${id} »`); continue; }
    if (!v || typeof v !== "object") { errors.push(`${id} : entrée invalide`); continue; }
    const d = v as Record<string, unknown>;
    const src = d.source as Record<string, unknown> | undefined;
    if (!src || typeof src !== "object") { errors.push(`${id} : source manquante`); continue; }
    const kind = src.kind ?? "query";
    if (kind !== "query") { errors.push(`${id} : source « ${String(kind)} » non prise en charge (seulement query)`); continue; }
    const connector = text(src.connector, 80);
    const tool = text(src.tool, 120);
    if (!connector || !tool) { errors.push(`${id} : connector et tool requis`); continue; }
    if (!connectorServer(connector)) { errors.push(`${id} : connecteur inconnu « ${connector} »`); continue; }
    const args = src.args && typeof src.args === "object" && !Array.isArray(src.args) ? (src.args as Record<string, unknown>) : {};
    datasets[id] = { title: text(d.title, 120) ?? id, description: text(d.description, 1000), source: { kind: "query", connector, tool, args } };
    if (Object.keys(datasets).length > MAX_DATASETS) { errors.push(`${MAX_DATASETS} jeux de données au plus`); break; }
  }
  return { datasets, errors };
}

export function parseParams(raw: unknown): Record<string, ParamValue> {
  let obj: unknown = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { return {}; } }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!PARAM_NAME_RE.test(k)) continue;
    const pv = paramValue(v);
    if (pv !== undefined) out[k] = pv;
  }
  return out;
}

export function paramValue(v: unknown): ParamValue | undefined {
  if (v === null) return null;
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return v.replace(/[\r\n]+/g, " ").slice(0, 500);
  if (Array.isArray(v)) return v.filter((x): x is string | number => typeof x === "string" || typeof x === "number").slice(0, 100);
  return undefined;
}

/**
 * Remplace `{{name}}` dans les arguments : une chaîne entière « {{x}} » prend
 * la valeur typée ; au milieu d'un texte, la valeur en texte (un tableau → a, b).
 * Un paramètre inconnu vaut null (chaîne entière) ou vide (dans un texte).
 */
export function substituteParams<T>(args: T, params: Record<string, ParamValue>): T {
  const one = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = v.match(/^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/);
      if (whole) return params[whole[1]] ?? null;
      return v.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name: string) => {
        const p = params[name];
        return p == null ? "" : Array.isArray(p) ? p.join(", ") : String(p);
      });
    }
    if (Array.isArray(v)) return v.map(one);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = one(x);
      return out;
    }
    return v;
  };
  return one(args) as T;
}

/** Comptes nommés par les arguments d'un appel (pour le contrôle de périmètre). */
export function accountsOfCall(server: string, args: Record<string, unknown>): { platform: "meta" | "google" | "tiktok"; id: string }[] {
  const out: { platform: "meta" | "google" | "tiktok"; id: string }[] = [];
  const push = (platform: "meta" | "google" | "tiktok", v: unknown) => {
    if (typeof v === "number") v = String(v);
    if (typeof v !== "string") return;
    const id = v.trim().replace(/-/g, "");
    if (id) out.push({ platform, id });
  };
  if (server === "mcp-google-ads") {
    push("google", args.customer_id ?? args.customerId);
  } else if (server === "meta-ads-impulse") {
    let input: unknown = args.input;
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = null; } }
    const i = (input && typeof input === "object" ? input : args) as Record<string, unknown>;
    push("meta", i.ad_account_id ?? i.account_id ?? i.adAccountId);
  } else if (server === "mcp-tiktok-ads") {
    let input: unknown = args.input;
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = null; } }
    const i = (input && typeof input === "object" ? input : args) as Record<string, unknown>;
    push("tiktok", i.advertiser_id);
    let ids: unknown = i.advertiser_ids;
    if (typeof ids === "string") { try { ids = JSON.parse(ids); } catch { ids = [ids]; } }
    if (Array.isArray(ids)) ids.forEach((x) => push("tiktok", x));
  }
  return out;
}

// ── Modèles livrés avec l'application ───────────────────────────────────────

export interface TemplateInfo { key: string; title: string; description: string }

export const TEMPLATES: TemplateInfo[] = [
  {
    key: "cours-legendre",
    title: "Cours Legendre – Pilotage budget par verticale",
    description: "Pacing mensuel Google + Meta + Bing par verticale : rythme de dépense, projection, alertes, conseils par campagne. Budgets et règles dans deux Google Sheets.",
  },
  {
    key: "liferay",
    title: "Liferay – Pilotage budget par marché",
    description: "Pacing mensuel Google Ads (USD) par marché : rythme de dépense, projection, alertes, leads et CPL, QMB par trimestre (Sicentric), conseils par campagne. Budgets et règles dans trois Google Sheets.",
  },
];

/** Un modèle livré (généré par scripts/build-dashboard-templates.mjs) ; null si inconnu. */
export function loadTemplate(key: string): { title: string; description: string; datasets: Record<string, Dataset>; params: Record<string, ParamValue>; html: string } | null {
  const info = TEMPLATES.find((t) => t.key === key);
  const gen = GENERATED_TEMPLATES[key];
  if (!info || !gen) return null;
  return { title: info.title, description: info.description, datasets: parseDatasets(gen.datasets).datasets, params: parseParams(gen.params), html: gen.html };
}
