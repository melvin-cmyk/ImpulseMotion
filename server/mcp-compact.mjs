/**
 * Compaction déterministe des résultats d'outils MCP (Meta Ads, Google Ads,
 * GA4 via n8n) avant qu'ils n'atteignent le modèle.
 *
 * Pourquoi : une session d'analyse type injecte ~160 k tokens de JSON
 * (mesuré le 2026-09-22 : n8n indente tout, Google répète un `resourceName`
 * de 100+ caractères par ligne, Meta renvoie 20 types d'actions par ligne,
 * GA4 emballe chaque cellule dans {value}). Les mêmes appels compactés
 * pèsent ~15-20 k tokens, pour la même lecture d'analyste.
 *
 * Ce module ne dépend d'aucun réseau : `compactText(text, {server, tool})`
 * est pur, testé dans lib/__tests__/mcp-compact.test.ts, et branché par
 * server/mcp-scoped-ads.mjs sur chaque `tools/call`.
 *
 * Étapes (les deux dernières sont les seules avec perte, et sont annoncées) :
 *  1. minifier ; extraire les lignes (data / results / rows GA4) et l'enveloppe
 *  2. retirer l'enveloppe inutile (paging, requestId, fieldMask, kind…)
 *  3. aplatir chaque ligne (campaign.name), retirer les champs sans valeur
 *     d'analyse (resourceName, policySummaryInfo…), convertir les micros en
 *     unités, arrondir, mapper les tableaux d'actions Meta en colonnes
 *  4. remonter en en-tête les colonnes constantes ; partager les tableaux
 *     identiques (headlines RSA) entre lignes
 *  5. plafonner le nombre de lignes (top dépense, ou dates les plus récentes)
 *  6. rendre en tableau TSV : une ligne d'en-tête, une ligne par élément
 */

const ENVELOPE_DROP = new Set([
  "paging", "next", "previous", "cursors", "requestId", "fieldMask",
  "queryResourceConsumption", "kind", "metadata", "summary_row_count", "__debug",
  "dimensionHeaders", "metricHeaders", "totals", "maximums", "minimums",
]);

// Champs sans valeur d'analyse, quel que soit le serveur (chemin aplati).
const FIELD_DROP_GENERIC = [
  /(^|\.)policySummaryInfo$/, /(^|\.)assetPerformanceLabel$/,
  /(^|\.)(createTime|updateTime)$/, /(^|\.)(serviceLevel|propertyType|industryCategory|parent|gmpOrganization)$/,
  /brand_safety_content_filter_levels$/, /targeting_relaxation_types/, /targeting_automation/, /(^|\.)locales$/,
  /geo_locations\.location_types$/, /(^|\.)hasRecommendedBudget$/, /(^|\.)viewThroughConversions$/,
];

// Meta : types d'actions conservés (les autres sont du bruit d'engagement ou
// des doublons omni_*). cost_per_action_type n'est gardé que pour les conversions.
const META_ACTION_KEEP = /^(link_click|landing_page_view|purchase|lead|add_to_cart|initiate_checkout|complete_registration|subscribe|schedule|contact|offsite_conversion\.|onsite_conversion\.(lead|purchase|messaging)|custom)/;
const META_CONVERSION_ACTION = /^(purchase|lead|add_to_cart|initiate_checkout|complete_registration|subscribe|schedule|contact|offsite_conversion\.|onsite_conversion\.(lead|purchase|messaging)|custom)/;

const MICROS = /Micros$|^(averageCpc|costPerConversion|averageCpm|costPerAllConversions|averageCost)$/;
const ID_KEY = /(^|[._])id$|resourceName|cursor|(^|\.)name$/i;

/** Réglages par outil : plafond et tri. Absent = 100 lignes, tri dépense. */
const TOOL_OPTS = {
  "meta-ads-impulse": {
    Daily_Performance1: { cap: 400, order: "date" },
    Campaign_Daily_Trend1: { cap: 400, order: "date" },
    Get_Campaigns1: { cap: 60 },
    Get_Ad_Creatives1: { cap: 60 },
  },
  "mcp-google-ads": {
    Daily_Performance: { cap: 400, order: "date" },
    Custom_GAQL_Query: { cap: 500, fieldDrop: false },
  },
  "mcp-google-analytics": {
    run_report: { cap: 300, order: "date" },
    run_pivot_report: { cap: 500, fieldDrop: false },
    run_realtime_report: { cap: 300, fieldDrop: false },
    get_metadata: { cap: 1000, fieldDrop: false },
  },
};

const MAX_PROSE_CHARS = 12_000;

const isEmpty = (v) =>
  v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Normalise une valeur numérique : chaînes → nombres (sauf identifiants), micros → unités, arrondi. */
function num(v, key) {
  const leaf = key.split(".").pop();
  if (typeof v === "string") {
    if (!/^-?\d+(\.\d+)?$/.test(v)) return v;
    if (ID_KEY.test(key)) return v;
    if (!v.includes(".") && v.replace("-", "").length > 15) return v; // ids Meta > 2^53
    v = Number(v);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return v;
  if (MICROS.test(leaf)) v = v / 1e6;
  if (Number.isInteger(v)) return v;
  return Math.abs(v) >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000;
}
const renameKey = (k) => k.replace(/Micros$/, "");

/** `customers/1/campaigns/123` → "123" ; composites (a~b~c) → null. */
function idFromResourceName(v) {
  if (typeof v !== "string") return null;
  const last = v.split("/").pop() || "";
  return last && !last.includes("~") ? last : null;
}

function isActionList(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && "action_type" in x && "value" in x);
}

function flatten(obj, opts, prefix = "", out = {}) {
  for (const [k, raw] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isEmpty(raw)) continue;
    if (opts.fieldDrop && FIELD_DROP_GENERIC.some((r) => r.test(key))) continue;
    if (/(^|\.)resourceName$/.test(key)) {
      // Remplacé par l'id court quand l'objet n'a ni id ni name (Daily_Performance Google).
      if (opts.fieldDrop) {
        const parent = prefix ? obj : null;
        if (parent && !("id" in parent) && !("name" in parent)) {
          const id = idFromResourceName(raw);
          if (id) out[`${prefix}.id`] = id;
        }
        continue;
      }
    }
    if (Array.isArray(raw)) {
      if (isActionList(raw)) {
        const conversionOnly = /^(cost_per_action_type|cost_per_conversion)$/.test(k);
        for (const x of raw) {
          const type = String(x.action_type);
          if (opts.fieldDrop && !(conversionOnly ? META_CONVERSION_ACTION : META_ACTION_KEEP).test(type)) continue;
          if (opts.fieldDrop && /^omni_/.test(type) && raw.some((y) => y.action_type === type.slice(5))) continue;
          const nv = num(x.value, "value");
          if (nv === 0 || nv === "0") continue;
          out[`${key}.${type}`] = nv;
        }
        continue;
      }
      if (raw.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
        // [{text, …}] / [{id, name}] → ["text"] / ["name"] quand une seule valeur utile reste.
        out[key] = raw.map((x) => {
          const y = flatten(x, opts);
          const ks = Object.keys(y).filter((kk) => !/(^|[._])id$/i.test(kk));
          return ks.length === 1 ? y[ks[0]] : y;
        });
        continue;
      }
      out[key] = raw;
      continue;
    }
    if (raw && typeof raw === "object") { flatten(raw, opts, key, out); continue; }
    out[renameKey(key)] = num(raw, key);
  }
  return out;
}

/** GA4 runReport → lignes {dimension: valeur, métrique: valeur}. */
function ga4Rows(o) {
  if (!o || !Array.isArray(o.rows) || !Array.isArray(o.dimensionHeaders)) return null;
  const dh = o.dimensionHeaders.map((h) => h.name);
  const mh = (o.metricHeaders || []).map((h) => h.name);
  const rows = o.rows.map((r) => {
    const x = {};
    (r.dimensionValues || []).forEach((d, i) => { x[dh[i] ?? `dim${i}`] = d?.value; });
    (r.metricValues || []).forEach((m, i) => { x[mh[i] ?? `metric${i}`] = m?.value; });
    return x;
  });
  const env = {};
  if (o.rowCount !== undefined) env.rowCount = o.rowCount;
  if (o.metadata?.currencyCode) env.currency = o.metadata.currencyCode;
  if (o.metadata?.timeZone) env.timeZone = o.metadata.timeZone;
  return { rows, env };
}

/** Localise le tableau de lignes principal et l'enveloppe qui l'entoure. */
function findRows(o) {
  if (Array.isArray(o) && o.length === 1 && o[0] && typeof o[0] === "object" && !Array.isArray(o[0])) o = o[0];
  if (Array.isArray(o)) return o.every((x) => x && typeof x === "object") ? { rows: o, env: {} } : { rows: null, env: null, value: o };
  if (!o || typeof o !== "object") return { rows: null, env: null, value: o };
  let best = null;
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object") && (!best || v.length > best.arr.length)) best = { k, arr: v };
  }
  if (!best) return { rows: null, env: o };
  const env = {};
  for (const [k, v] of Object.entries(o)) if (k !== best.k) env[k] = v;
  return { rows: best.arr, env };
}

const cell = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v).replace(/[\t\n\r]+/g, " "));

/**
 * @typedef {{ server?: string, tool?: string, cap?: number }} CompactContext
 * @typedef {{ raw: number, out: number, mode: string, minified?: number, truncated?: { shown: number, total: number, kept: string } | null }} CompactStats
 */

/**
 * Compacte le texte d'un résultat d'outil. Renvoie { text, stats } ; `text`
 * est inchangé (ou juste tronqué) quand ce n'est pas du JSON.
 * @param {string} text
 * @param {CompactContext} [ctx]
 * @returns {{ text: string, stats: CompactStats }}
 */
export function compactText(text, { server = "", tool = "", cap: capOverride } = {}) {
  const stats = { raw: text.length };
  let j;
  try { j = JSON.parse(text); } catch {
    const out = text.length > MAX_PROSE_CHARS ? `${text.slice(0, MAX_PROSE_CHARS)}\n…[tronqué : ${text.length} caractères au total]` : text;
    return { text: out, stats: { ...stats, out: out.length, mode: "prose" } };
  }
  const minified = JSON.stringify(j);
  stats.minified = minified.length;

  const tuning = { cap: 100, order: "spend", fieldDrop: true, ...(TOOL_OPTS[server]?.[tool] ?? {}) };
  if (capOverride) tuning.cap = capOverride;

  const unwrapped = Array.isArray(j) && j.length === 1 && j[0] && typeof j[0] === "object" && !Array.isArray(j[0]) ? j[0] : j;
  const located = ga4Rows(unwrapped) || findRows(j);
  const env = {};
  for (const [k, v] of Object.entries(located.env || {})) {
    if (ENVELOPE_DROP.has(k) || isEmpty(v)) continue;
    env[k] = v;
  }
  if (located.env?.paging?.next) env.has_more = true;

  if (!located.rows) {
    // Objet simple (Account_Overview…) ou scalaire : aplatir seulement.
    const flat = located.value !== undefined ? located.value : flatten(unwrapped && typeof unwrapped === "object" ? unwrapped : {}, tuning);
    const out = JSON.stringify(flat);
    return finish(out, minified, stats, "object");
  }

  const total = located.rows.length;
  let rows = located.rows.map((r) => flatten(r, tuning));

  // Colonnes constantes → en-tête (≥ 3 lignes).
  const common = {};
  if (rows.length >= 3) {
    const keys = new Set(rows.flatMap((r) => Object.keys(r)));
    for (const k of keys) {
      const v0 = JSON.stringify(rows[0][k]);
      if (v0 !== undefined && rows.every((r) => JSON.stringify(r[k]) === v0)) {
        common[k] = rows[0][k];
        rows.forEach((r) => { delete r[k]; });
      }
    }
    if (common.status !== undefined && common.effective_status !== undefined && common.status === common.effective_status) delete common.effective_status;
  }
  for (const r of rows) if (r.status !== undefined && r.status === r.effective_status) delete r.effective_status;

  // Tableaux identiques répétés (headlines RSA…) → dictionnaire partagé.
  const shared = {};
  const seen = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (!Array.isArray(v)) continue;
      const sig = JSON.stringify(v);
      if (sig.length < 40) continue;
      const count = rows.filter((x) => JSON.stringify(x[k]) === sig).length;
      if (count < 2) continue;
      let ref = seen.get(sig);
      if (!ref) { ref = `#${seen.size + 1}`; seen.set(sig, ref); shared[ref] = v; }
      r[k] = ref;
    }
  }

  // Plafond de lignes : dates les plus récentes, sinon top dépense.
  const dateKey = ["date", "date_start", "segments.date", "day"].find((k) => rows.some((r) => k in r));
  const spendKey = ["spend", "cost", "metrics.cost", "sessions", "impressions", "metrics.impressions", "contacts"].find((k) => rows.some((r) => k in r));
  let truncated = null;
  if (rows.length > tuning.cap) {
    const sorted = [...rows];
    if (tuning.order === "date" && dateKey) {
      sorted.sort((a, b) => String(b[dateKey]).localeCompare(String(a[dateKey])));
      truncated = { shown: tuning.cap, total, kept: `dates les plus récentes (${dateKey})` };
    } else if (spendKey) {
      sorted.sort((a, b) => (Number(b[spendKey]) || 0) - (Number(a[spendKey]) || 0));
      truncated = { shown: tuning.cap, total, kept: `top ${spendKey}` };
    } else {
      truncated = { shown: tuning.cap, total, kept: "ordre d'origine" };
    }
    rows = sorted.slice(0, tuning.cap);
    if (tuning.order === "date" && dateKey) rows.reverse(); // chronologique à l'affichage
  }

  // Rendu TSV : colonnes denses d'abord, puis ordre d'apparition (dimensions avant métriques).
  const freq = {};
  const firstSeen = {};
  rows.forEach((r) => Object.keys(r).forEach((k) => { freq[k] = (freq[k] || 0) + 1; if (!(k in firstSeen)) firstSeen[k] = Object.keys(firstSeen).length; }));
  const cols = Object.keys(freq).sort((a, b) => freq[b] - freq[a] || firstSeen[a] - firstSeen[b]);
  const header = Object.entries({ ...env, ...common })
    .map(([k, v]) => `${k}=${cell(v)}`);
  const lines = [];
  lines.push(`_compact: ${total} ligne${total > 1 ? "s" : ""}${truncated ? `, ${truncated.shown} affichées (${truncated.kept}) — affine la période ou le filtre pour le reste` : ""} ; montants en unités (micros convertis), nombres arrondis${Object.keys(common).length ? " ; colonnes constantes en en-tête" : ""}`);
  if (header.length) lines.push(header.join(" ; "));
  if (Object.keys(shared).length) lines.push(`_shared: ${JSON.stringify(shared)}`);
  lines.push(cols.join("\t"));
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join("\t"));
  return finish(lines.join("\n"), minified, stats, "table", truncated);
}

function finish(out, minified, stats, mode, truncated = null) {
  // Garde-fou : jamais plus lourd que le JSON minifié.
  const text = out.length < minified.length ? out : minified;
  return { text, stats: { ...stats, out: text.length, mode: text === minified ? "minified" : mode, truncated } };
}

/**
 * Applique compactText à chaque bloc texte d'un résultat MCP (jamais aux erreurs).
 * @param {any} result
 * @param {CompactContext} ctx
 * @returns {{ result: any, stats: { raw: number, out: number } | null }}
 */
export function compactToolResult(result, ctx) {
  if (!result || result.isError || !Array.isArray(result.content)) return { result, stats: null };
  /** @type {{ raw: number, out: number } | null} */
  let stats = null;
  const content = result.content.map((c) => {
    if (!c || c.type !== "text" || typeof c.text !== "string") return c;
    const r = compactText(c.text, ctx);
    stats = stats ? { raw: stats.raw + r.stats.raw, out: stats.out + r.stats.out } : { raw: r.stats.raw, out: r.stats.out };
    return { ...c, text: r.text };
  });
  return { result: { ...result, content }, stats };
}
