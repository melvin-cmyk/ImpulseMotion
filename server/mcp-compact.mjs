/**
 * Compaction déterministe des résultats d'outils MCP (Meta Ads, Google Ads,
 * GA4, TikTok Ads via n8n) avant qu'ils n'atteignent le modèle.
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
 * Étapes (tout ce qui est retiré ou agrégé est annoncé au modèle) :
 *  1. minifier ; extraire les lignes (data / results / rows GA4) et l'enveloppe
 *  2. retirer l'enveloppe inutile (paging, requestId, fieldMask, kind…)
 *  3. aplatir chaque ligne (campaign.name), retirer les champs sans valeur
 *     d'analyse (resourceName, policySummaryInfo…), convertir les micros en
 *     unités, mapper les tableaux d'actions Meta en colonnes
 *  4. remonter en en-tête les colonnes constantes ; fusionner les colonnes
 *     strictement identiques (doublons pixel Meta) ; partager les tableaux
 *     identiques (headlines RSA) entre lignes
 *  5. sous le plafond de lignes de l'outil : détail, regroupé en blocs quand
 *     une colonne texte se répète (jour × campagne), colonnes recalculables
 *     retirées des tableaux de plus de RECALC_MIN_ROWS lignes
 *  6. au-delà du plafond : synthèse d'une série jour × campagne en trois
 *     tableaux (par campagne, par jour, par campagne et par semaine), sommes
 *     des métriques additives, ratios recalculés sur les sommes ; à défaut
 *     (autre dimension, page partielle, métrique inconnue), plafond v1 (top
 *     dépense, ou dates les plus récentes)
 *  7. rendre en TSV, en-têtes raccourcis, nombres arrondis au rendu seulement
 *     (les sommes se font sur les valeurs exactes) ; la forme sans fusion ni
 *     abréviation est gardée quand elle est plus courte
 *
 * v2 (2026-09-29) : étapes 4 (fusion), 5 (blocs, recalculables), 6 et 7
 * (en-têtes). Les outils `fieldDrop: false` ne reçoivent que les
 * transformations sans perte. Une page partielle (paging.next) est annoncée
 * en première ligne et n'est jamais résumée.
 */

const ENVELOPE_DROP = new Set([
  "paging", "next", "previous", "cursors", "requestId", "fieldMask",
  "queryResourceConsumption", "kind", "metadata", "summary_row_count", "__debug",
  "dimensionHeaders", "metricHeaders", "totals", "maximums", "minimums",
  "request_id",
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

const TIKTOK = "mcp-tiktok-ads";

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
  [TIKTOK]: {
    get_report_integrated: { cap: 400, order: "date" },
    get_breakdown_report: { cap: 300 },
    // Une page de liste (taille fixée par server/mcp-tiktok-args.mjs) est rendue en entier.
    get_campaigns: { cap: 100 },
    get_adgroups: { cap: 100 },
    get_ads: { cap: 100 },
    search_ad_videos: { cap: 40 },
    search_ad_images: { cap: 40 },
    list_custom_audiences: { cap: 40 },
  },
};

// TikTok, fiche d'un compte : seuls ces champs passent. Le reste (solde,
// e-mail, téléphone et adresse du contact, licence) n'a rien à faire dans une
// conversation, encore moins dans celle d'un bot client.
const TIKTOK_ADVERTISER_FIELDS = ["advertiser_id", "name", "company", "currency", "timezone", "display_timezone", "status", "country", "industry", "role"];

const MAX_PROSE_CHARS = 12_000;

// Au-delà, les colonnes recalculables (ctr, cpc…) sont retirées, formule annoncée.
const RECALC_MIN_ROWS = 40;
// Le regroupement en blocs doit faire gagner au moins 15 % du tableau.
const GROUP_MIN_GAIN = 0.15;

// Métriques sommables d'un jour à l'autre et d'une campagne à l'autre.
const ADDITIVE_COL = /^(metrics\.)?(impressions|clicks|cost|spend|conversions|conversion|complete_payment|purchase|total_purchase|total_purchase_value|video_play_actions|video_watched_2s|video_watched_6s|video_views_p(25|50|75|100)|conversionsValue|allConversions|allConversionsValue|interactions|engagements|videoViews|inline_link_clicks|sessions|engagedSessions|screenPageViews|eventCount|keyEvents|transactions|ecommercePurchases|purchaseRevenue|totalRevenue|addToCarts|checkouts)$|^(actions|action_values)\./;

// Métriques connues pour ne pas se sommer : retirées des agrégats, et nommées.
const NON_ADDITIVE_COL = /(^|\.)(ctr|cpc|cpm|cpp|reach|frequency|unique_\w+|totalUsers|activeUsers|averageCpc|averageCpm|averageCpv|averageCost|costPerConversion|costPerAllConversions|valuePerConversion|\w*Rate|\w*Share|\w+_rate|cost_per_conversion|\w+_roas)$|^(cost_per_\w+|\w*purchase_roas)\./;
// Dimensions qui peuvent arriver sous forme de nombre (heure, date GA4 20260601) : jamais des métriques.
const DIMENSION_COL = /(^|[._])(hour|day|date|week|month|quarter|year|dayOfWeek|day_of_week|isoWeek|isoYear|id)$/i;

// Ratios recalculables : [colonne, numérateurs possibles, dénominateurs possibles].
// L'échelle (1, 100 ou 1000) est constatée sur les lignes, pas supposée :
// le ctr est une fraction chez Google, un pourcentage chez Meta.
const RATIO_FORMULAS = [
  [/^(ctr)$/, ["clicks"], ["impressions"]],
  [/^(averageCpc|cpc)$/, ["cost", "spend"], ["clicks"]],
  [/^(averageCpm|cpm)$/, ["cost", "spend"], ["impressions"]],
  [/^(costPerConversion)$/, ["cost"], ["conversions"]],
  [/^(cost_per_conversion)$/, ["spend"], ["conversion"]],
  [/^(conversion_rate)$/, ["conversion"], ["clicks"]],
  [/^(costPerAllConversions)$/, ["cost"], ["allConversions"]],
  [/^(averageCost)$/, ["cost"], ["interactions"]],
  [/^(frequency)$/, ["impressions"], ["reach"]],
];

// En-têtes Meta raccourcis (avec légende) quand le gain dépasse le coût de la légende.
const HEADER_ABBREV = [
  [/^actions\./, "act.", "actions."],
  [/^action_values\./, "val.", "action_values."],
  [/^cost_per_action_type\./, "cpa.", "cost_per_action_type."],
  [/(?<=\.)offsite_conversion\.fb_pixel_/, "pixel_", "offsite_conversion.fb_pixel_"],
  [/(?<=\.)offsite_conversion\.custom\./, "custom.", "offsite_conversion.custom."],
];
const HEADER_MIN_GAIN = 40; // caractères gagnés, légende déduite
// Préfixes Google retirés sans légende (le nom restant est sans ambiguïté).
const HEADER_STRIP = ["metrics.", "segments."];
// Seules les variantes d'un même événement, dans une même famille, sont fusionnées (pixel contre générique).
const MERGE_FAMILY = /^(actions|action_values|cost_per_action_type)$/;
const META_VARIANT = /^(offsite_conversion\.fb_pixel_|offsite_conversion\.|omni_|onsite_web_app_|onsite_web_|onsite_app_|web_in_store_)/;

// Décisions par nom de champ, mémorisées : les mêmes clés reviennent à chaque ligne.
const memo = (fn, cache = new Map()) => (k) => {
  let v = cache.get(k);
  if (v === undefined) { if (cache.size > 5000) cache.clear(); v = fn(k); cache.set(k, v); }
  return v;
};
const isDropped = memo((key) => FIELD_DROP_GENERIC.some((r) => r.test(key)));

const isEmpty = (v) =>
  v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Normalise une valeur numérique : chaînes → nombres (sauf identifiants), micros → unités. L'arrondi se fait au rendu. */
function num(v, key, opts) {
  const leaf = key.split(".").pop();
  if (typeof v === "string") {
    if (!/^-?\d+(\.\d+)?$/.test(v)) return v;
    if (ID_KEY.test(key)) return v;
    if (!v.includes(".") && v.replace("-", "").length > 15) return v; // ids Meta > 2^53
    v = Number(v);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return v;
  if (MICROS.test(leaf)) { v = v / 1e6; if (opts) opts.micros = true; }
  return v;
}

/** Arrondi d'affichage (règle v1 : 2 décimales, 4 sous 1) ; une valeur non nulle n'est jamais rendue 0. */
function roundNum(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || Number.isInteger(v)) return v;
  const r = Math.abs(v) >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000;
  return r === 0 ? Number(v.toPrecision(2)) : r;
}
function roundDeep(v) {
  if (typeof v === "number") return roundNum(v);
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundDeep(x)]));
  return v;
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
    if (opts.fieldDrop && isDropped(key)) continue;
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
          const nv = num(x.value, "value", opts);
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
    out[renameKey(key)] = num(raw, key, opts);
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

/** Réponse de l'API TikTok : { code, message, request_id, data }. */
const isTikTok = (o) => !!o && typeof o === "object" && !Array.isArray(o) && typeof o.code === "number" && "request_id" in o && "message" in o;

/**
 * TikTok → lignes à plat. Un rapport rend { dimensions, metrics } par ligne,
 * fusionnés ici ; « - » (métrique sans objet) est une absence ; la date d'un
 * jour arrive en « AAAA-MM-JJ 00:00:00 ». Une page qui n'est pas la dernière
 * est annoncée (has_more), avec le numéro de page à demander.
 */
function tiktokRows(o) {
  if (!isTikTok(o)) return null;
  if (o.code !== 0) return { rows: null, env: null, value: { erreur_tiktok: o.code, message: o.message } };
  const data = o.data && typeof o.data === "object" ? o.data : {};
  if (!Array.isArray(data.list)) {
    // Pas de liste : on rend `data` seul, sans l'enveloppe (code, message, request_id).
    const found = findRows(data);
    return found.rows ? found : { rows: null, env: null, value: data };
  }

  const rows = data.list.filter((r) => r && typeof r === "object").map((r) => {
    const merged = r.dimensions || r.metrics ? { ...(r.dimensions || {}), ...(r.metrics || {}) } : r;
    const x = {};
    for (const [k, v] of Object.entries(merged)) {
      if (v === "-") continue;
      x[k] = /^stat_time_day$/.test(k) && typeof v === "string" ? v.slice(0, 10) : v;
    }
    return x;
  });

  // Une page parmi plusieurs — la dernière comprise — n'est pas la période : dite, et jamais résumée en totaux.
  const env = {};
  const p = data.page_info;
  const paged = !!p && typeof p === "object" && Number(p.total_page) > 1;
  if (paged) {
    if (Number(p.total_page) > Number(p.page)) env.has_more = true;
    env.page = p.page;
    env.total_page = p.total_page;
    if (p.total_number !== undefined) env.total_number = p.total_number;
  }
  return { rows, env, partial: paged };
}

/** Every object that carries an `advertiser_id`, wherever it sits: wrapped, listed, or JSON inside a string. */
function advertiserCards(v, depth = 0, out = []) {
  if (depth > 8 || v === null || v === undefined) return out;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { advertiserCards(JSON.parse(t), depth + 1, out); } catch { /* texte ordinaire */ }
    }
    return out;
  }
  if (Array.isArray(v)) { for (const x of v) advertiserCards(x, depth + 1, out); return out; }
  if (typeof v !== "object") return out;
  if ("advertiser_id" in v) {
    out.push(Object.fromEntries(TIKTOK_ADVERTISER_FIELDS.filter((k) => k in v && typeof v[k] !== "object").map((k) => [k, v[k]])));
    return out;
  }
  for (const x of Object.values(v)) advertiserCards(x, depth + 1, out);
  return out;
}

/**
 * La fiche d'un compte TikTok, quelle que soit la forme de la réponse : seuls
 * les champs de la liste passent. Une réponse où aucun compte n'est reconnu
 * n'est jamais rendue telle quelle — elle pourrait porter le solde ou les
 * coordonnées du contact.
 */
function tiktokAdvertiserText(text) {
  let o = null;
  try { o = JSON.parse(text); } catch { /* rien de lisible */ }
  const cards = advertiserCards(o);
  if (cards.length) return JSON.stringify(cards.length === 1 ? cards[0] : cards);
  if (Array.isArray(o) && o.length === 1) o = o[0];
  if (isTikTok(o) && o.code !== 0) return JSON.stringify({ erreur_tiktok: o.code, message: String(o.message).slice(0, 300) });
  return JSON.stringify({ erreur: "fiche du compte illisible : réponse de TikTok non reconnue" });
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

const cell = (v) => {
  v = roundDeep(v);
  return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v).replace(/[\t\n\r]+/g, " ");
};

const sig = (v) => (v === undefined ? "" : JSON.stringify(v));
const columnsOf = (rows) => [...new Set(rows.flatMap((r) => Object.keys(r)))];
const isNumCol = (rows, c) => !ID_KEY.test(c) && rows.every((r) => r[c] === undefined || typeof r[c] === "number");

/**
 * Colonnes en double : variantes d'un même événement Meta, dans une même
 * famille, strictement identiques sur toutes les lignes (`purchase` et
 * `offsite_conversion.fb_pixel_purchase`). Deux colonnes sans lien qui se
 * trouvent égales ne sont pas fusionnées. Seule autre paire admise :
 * date_stop quand il répète date_start sur chaque ligne (série quotidienne).
 * @returns {Array<[string, string]>} paires [retirée, gardée]
 */
function findDuplicates(rows) {
  const bySig = new Map();
  for (const c of columnsOf(rows)) {
    const i = c.indexOf(".");
    if (i < 0 || !MERGE_FAMILY.test(c.slice(0, i))) continue;
    const key = `${c.slice(0, i)}\u0002${c.slice(i + 1).replace(META_VARIANT, "")}\u0002${rows.map((r) => sig(r[c])).join("\u0001")}`;
    if (!bySig.has(key)) bySig.set(key, []);
    bySig.get(key).push(c);
  }
  const pairs = [];
  for (const cols of bySig.values()) {
    if (cols.length < 2) continue;
    const depth = (c) => c.split(".").length;
    const kept = cols.reduce((a, b) => (depth(b) < depth(a) ? b : a));
    for (const c of cols) if (c !== kept) pairs.push([c, kept]);
  }
  if (rows.length > 0 && rows.every((r) => typeof r.date_stop === "string" && r.date_stop === r.date_start)) pairs.push(["date_stop", "date_start"]);
  return pairs;
}

/**
 * Noms de colonnes raccourcis : { name(col), legend[], stripped[] }. Aucun
 * renommage s'il crée une collision ; les abréviations Meta sont prises en
 * bloc, et seulement si elles font gagner plus que la légende ne coûte.
 */
function shortNames(cols, abbreviations) {
  const steps = [];
  const stripped = [];
  let names = cols;
  const attempt = (step) => {
    const next = names.map(step);
    if (new Set(next).size !== next.length) return false;
    names = next;
    steps.push(step);
    return true;
  };
  for (const p of HEADER_STRIP) {
    if (names.some((n) => n.startsWith(p)) && attempt((n) => (n.startsWith(p) ? n.slice(p.length) : n))) stripped.push(p);
  }
  const used = abbreviations ? HEADER_ABBREV.filter(([re]) => names.some((n) => re.test(n))) : [];
  const abbreviate = (n) => used.reduce((x, [re, short]) => x.replace(re, short), n);
  const legend = used.map(([, short, long]) => `${short}=${long}`);
  const gain = names.reduce((s, n) => s + n.length - abbreviate(n).length, 0) - legend.join(" ; ").length - 9;
  const kept = used.length > 0 && gain >= HEADER_MIN_GAIN && attempt(abbreviate);
  return { name: memo((c) => steps.reduce((n, step) => step(n), c)), legend: kept ? legend : [], stripped };
}

/**
 * Annonce des colonnes fusionnées. Une paire sans préfixe de famille
 * (« pixel_purchase=purchase ») vaut pour act., val. et cpa. à la fois : elle
 * n'est employée que si aucune colonne affichée ne porte encore ce nom.
 */
function mergedNote(merged, name, cols) {
  const family = /^(actions|action_values|cost_per_action_type)\./;
  const bare = (c) => name(c).replace(/^(act|val|cpa|actions|action_values|cost_per_action_type)\./, "");
  const shown = new Set(cols.filter((c) => family.test(c)).map(bare));
  const pairs = [...new Set(merged.map(([a, b]) => (family.test(a) && !shown.has(bare(a)) ? `${bare(a)}=${bare(b)}` : `${name(a)}=${name(b)}`)))];
  return `_doublons: colonnes retirées car identiques à une colonne gardée (retirée=gardée) : ${pairs.join(" ; ")}`;
}

/**
 * Formule d'un ratio à partir des autres colonnes. Elle n'est retenue que si
 * elle se vérifie (à 0,5 % près) sur toutes les lignes où le ratio est
 * présent : une seule ligne qui s'en écarte, et la colonne n'est pas réputée
 * recalculable.
 * @returns {{ col: string, num: string, den: string, k: number } | null}
 */
function ratioFormula(col, rows, cols) {
  const prefix = col.startsWith("metrics.") ? "metrics." : "";
  const leaf = col.slice(prefix.length);
  let nums = null;
  let dens = null;
  const cpa = /^cost_per_action_type\.(.+)$/.exec(col);
  const roas = /^\w*purchase_roas\.(.+)$/.exec(col);
  if (cpa) { nums = ["spend"]; dens = [`actions.${cpa[1]}`]; }
  else if (roas) { nums = [`action_values.${roas[1]}`, `action_values.${roas[1].replace(/^omni_/, "")}`]; dens = ["spend"]; }
  else {
    const f = RATIO_FORMULAS.find(([re]) => re.test(leaf));
    if (!f) return null;
    nums = f[1].map((n) => prefix + n);
    dens = f[2].map((n) => prefix + n);
  }
  const n = nums.find((c) => cols.includes(c));
  const d = dens.find((c) => cols.includes(c));
  if (!n || !d) return null;
  const holds = (k) => {
    let seen = 0;
    for (const r of rows) {
      if (r[col] === undefined) continue;
      seen++;
      if (!r[d]) { if (r[col]) return false; continue; }
      if (Math.abs((k * (r[n] ?? 0)) / r[d] - r[col]) > Math.abs(r[col]) * 0.005 + 1e-6) return false;
    }
    return seen > 0;
  };
  const k = [1, 100, 1000].find(holds);
  return k ? { col, num: n, den: d, k } : null;
}
const formulaText = (f, name) => `${name(f.col)}=${f.k > 1 ? `${f.k}×` : ""}${name(f.num)}/${name(f.den)}`;

/**
 * Colonnes texte candidates au regroupement, par gain décroissant : présentes
 * sur chaque ligne, au moins 2 lignes par valeur en moyenne.
 */
function groupCandidates(rows, exclude) {
  const out = [];
  for (const c of columnsOf(rows)) {
    if (exclude.includes(c) || !rows.every((r) => typeof r[c] === "string")) continue;
    const distinct = new Set(rows.map((r) => r[c]));
    if (distinct.size < 2 || distinct.size > rows.length / 2) continue;
    const gain = rows.reduce((s, r) => s + r[c].length + 1, 0) - [...distinct].reduce((s, v) => s + v.length + 3, 0);
    out.push({ col: c, gain });
  }
  return out.sort((a, b) => b.gain - a.gain);
}

/** Répartit les lignes par valeur de `key` (ordre d'apparition) et liste les colonnes constantes dans chaque groupe. */
function groupBy(rows, key, isDim = (c) => !isNumCol(rows, c)) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r[key])) groups.set(r[key], []);
    groups.get(r[key]).push(r);
  }
  const attrs = columnsOf(rows).filter((c) => c !== key && isDim(c) &&
    [...groups.values()].every((g) => g.every((r) => sig(r[c]) === sig(g[0][c]))));
  return { groups, attrs };
}

/** Lignes TSV ; les cellules vides de fin de ligne sont omises. */
function tsv(rows, cols, name) {
  const lines = [cols.map(name).join("\t")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join("\t").replace(/\t+$/, ""));
  return lines;
}
const groupTitle = (v, first, attrs, name) =>
  `# ${[cell(v), ...attrs.filter((a) => first[a] !== undefined).map((a) => `${name(a)}=${cell(first[a])}`)].join(" ; ")}`;

/** Lundi (AAAA-MM-JJ) de la semaine d'une date AAAA-MM-JJ ou AAAAMMJJ ; null si illisible. */
function mondayOf(date) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(date));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(t)) return null;
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Synthèse d'une longue série datée × groupe : total par groupe, total par
 * jour, total par groupe et par semaine. Renvoie null quand la forme ne s'y
 * prête pas : pas de colonne de groupe, date illisible, autre dimension qui
 * varie dans un groupe (texte, heure, identifiant…), ou nombre dont on ne
 * sait pas s'il se somme. Rien n'est écarté qui ne soit une métrique connue.
 */
function summarize(rows, dateKey, name, cap, exclude = []) {
  if (rows.some((r) => mondayOf(r[dateKey]) === null)) return null;
  const cols = columnsOf(rows);
  const numeric = cols.filter((c) => c !== dateKey && isNumCol(rows, c) && !DIMENSION_COL.test(c));
  const additive = numeric.filter((c) => ADDITIVE_COL.test(c));
  if (!additive.length) return null;
  const formulas = numeric.filter((c) => !additive.includes(c)).map((c) => ratioFormula(c, rows, additive)).filter(Boolean);
  const dropped = numeric.filter((c) => !additive.includes(c) && !formulas.some((f) => f.col === c));
  if (dropped.some((c) => !NON_ADDITIVE_COL.test(c))) return null;

  const isDim = (c) => !numeric.includes(c);
  let key = null;
  let attrs = [];
  for (const cand of groupCandidates(rows, [dateKey, ...exclude])) {
    const g = groupBy(rows, cand.col, isDim);
    // Toute autre dimension doit être constante par groupe, sinon l'agrégat la perdrait sans le dire.
    if (cols.every((c) => c === dateKey || c === cand.col || !isDim(c) || g.attrs.includes(c))) { key = cand.col; attrs = g.attrs; break; }
  }
  if (!key) return null;

  const aggregate = (keyOf) => {
    const acc = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (!acc.has(k)) acc.set(k, { first: r, days: new Set(), sums: {} });
      const a = acc.get(k);
      a.days.add(r[dateKey]);
      for (const c of additive) if (r[c] !== undefined) a.sums[c] = (a.sums[c] ?? 0) + r[c];
    }
    return [...acc.values()].map((a) => {
      const row = { ...a.sums, jours: a.days.size };
      for (const f of formulas) if (row[f.den]) row[f.col] = (f.k * (row[f.num] ?? 0)) / row[f.den];
      return { row, first: a.first };
    });
  };
  const spendKey = ["metrics.cost", "cost", "spend"].find((c) => additive.includes(c)) ?? additive[0];
  const ratios = formulas.map((f) => f.col);
  const metrics = (n) => (n > RECALC_MIN_ROWS ? additive : [...additive, ...ratios]);

  const byGroup = aggregate((r) => r[key]).sort((a, b) => (b.row[spendKey] ?? 0) - (a.row[spendKey] ?? 0));
  const byDay = aggregate((r) => r[dateKey]).sort((a, b) => String(a.first[dateKey]).localeCompare(String(b.first[dateKey])));
  const byWeek = aggregate((r) => `${r[key]}\u0001${mondayOf(r[dateKey])}`);
  const dates = byDay.map((d) => d.first[dateKey]);

  const lines = [];
  lines.push(`## A. Total par ${name(key)} sur la période`);
  lines.push(...tsv(byGroup.map((g) => ({ ...g.row, [key]: g.first[key], ...Object.fromEntries(attrs.map((a) => [a, g.first[a]])) })),
    [key, ...attrs, "jours", ...metrics(byGroup.length)], name));
  lines.push("## B. Total par jour, tous groupes confondus");
  lines.push(...tsv(byDay.map((d) => ({ ...d.row, [dateKey]: d.first[dateKey] })), [dateKey, ...metrics(byDay.length)], name));
  lines.push(`## C. Par ${name(key)} (titre « # ») et par semaine (semaine = date du lundi)`);
  lines.push(["semaine", "jours", ...metrics(byWeek.length).map(name)].join("\t"));
  for (const g of byGroup) {
    lines.push(`# ${cell(g.first[key])}`);
    const weeks = byWeek.filter((w) => w.first[key] === g.first[key])
      .map((w) => ({ ...w.row, semaine: mondayOf(w.first[dateKey]) }))
      .sort((a, b) => a.semaine.localeCompare(b.semaine));
    lines.push(...tsv(weeks, ["semaine", "jours", ...metrics(byWeek.length)], name).slice(1));
  }

  const notes = [`du ${dates[0]} au ${dates[dates.length - 1]}, résumées en 3 tableaux (plus de ${cap} lignes) : sommes sur toutes les lignes, jours = jours avec données`];
  if (formulas.length) {
    const partial = [byGroup, byDay, byWeek].some((t) => t.length > RECALC_MIN_ROWS);
    notes.push(`ratios recalculés sur les sommes${partial ? `, omis des tableaux de plus de ${RECALC_MIN_ROWS} lignes` : ""} (${formulas.map((f) => formulaText(f, name)).join(" ; ")})`);
  }
  if (dropped.length) notes.push(`retirés car non additifs : ${dropped.map(name).join(", ")}`);
  notes.push(`détail jour par jour d'un groupe : refaire l'appel sur une période de ${Math.max(1, Math.floor(cap / byGroup.length))} jours ou moins`);
  return { lines, notes, key, info: { rows: rows.length, groups: byGroup.length, days: byDay.length } };
}

/**
 * Le résultat de la fiche d'un compte, reconstruit : un bloc texte par bloc
 * texte de l'amont, filtré. Tout ce qui pourrait porter la fiche entière par
 * un autre chemin (contenu structuré, bloc d'un autre type, résultat en erreur
 * rendu tel quel) n'est pas transmis.
 */
function tiktokAdvertiserResult(result) {
  const texts = (Array.isArray(result?.content) ? result.content : []).filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text);
  const structured = result?.structuredContent !== undefined && result?.structuredContent !== null ? [JSON.stringify(result.structuredContent)] : [];
  const sources = texts.length ? texts : structured;
  const content = (sources.length ? sources : [""]).map((text) => ({ type: "text", text: tiktokAdvertiserText(text) }));
  const raw = sources.reduce((n, text) => n + text.length, 0);
  return { result: { content, ...(result?.isError ? { isError: true } : {}) }, stats: { raw, out: content.reduce((n, c) => n + c.text.length, 0) } };
}

/**
 * @typedef {{ server?: string, tool?: string, cap?: number }} CompactContext
 * @typedef {{ raw: number, out: number, mode: string, minified?: number, truncated?: { shown: number, total: number, kept: string } | null, summary?: { rows: number, groups: number, days: number } | null }} CompactStats
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
  if (server === TIKTOK && tool === "get_advertiser_info") {
    const out = tiktokAdvertiserText(text);
    return { text: out, stats: { ...stats, out: out.length, mode: "object", truncated: null } };
  }
  let j;
  try { j = JSON.parse(text); } catch {
    const out = text.length > MAX_PROSE_CHARS ? `${text.slice(0, MAX_PROSE_CHARS)}\n…[tronqué : ${text.length} caractères au total]` : text;
    return { text: out, stats: { ...stats, out: out.length, mode: "prose" } };
  }
  const minified = JSON.stringify(j);
  stats.minified = minified.length;

  const tuning = { cap: 100, order: "spend", fieldDrop: true, summary: true, ...(TOOL_OPTS[server]?.[tool] ?? {}) };
  if (capOverride) tuning.cap = capOverride;

  const unwrapped = Array.isArray(j) && j.length === 1 && j[0] && typeof j[0] === "object" && !Array.isArray(j[0]) ? j[0] : j;
  const located = ga4Rows(unwrapped) || (server === TIKTOK ? tiktokRows(unwrapped) : null) || findRows(j);
  const env = {};
  for (const [k, v] of Object.entries(located.env || {})) {
    if (ENVELOPE_DROP.has(k) || isEmpty(v)) continue;
    env[k] = v;
  }
  if (located.env?.paging?.next) env.has_more = true;

  if (!located.rows) {
    // Objet simple (Account_Overview…) ou scalaire : aplatir seulement.
    const flat = located.value !== undefined ? located.value : roundDeep(flatten(unwrapped && typeof unwrapped === "object" ? unwrapped : {}, tuning));
    const out = JSON.stringify(flat);
    return finish(out, minified, stats, "object");
  }

  const total = located.rows.length;
  const rows = located.rows.map((r) => flatten(r, tuning));

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
  const sharedCols = new Set(); // des références, pas des dimensions : jamais clé de regroupement
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (!Array.isArray(v)) continue;
      const s = JSON.stringify(roundDeep(v));
      if (s.length < 40) continue;
      // Déjà référencé : la dernière occurrence ne se compte plus elle-même (elle restait en clair en v1).
      if (!seen.has(s) && rows.filter((x) => Array.isArray(x[k]) && JSON.stringify(roundDeep(x[k])) === s).length < 2) continue;
      let ref = seen.get(s);
      if (!ref) { ref = `#${seen.size + 1}`; seen.set(s, ref); shared[ref] = roundDeep(v); }
      r[k] = ref;
      sharedCols.add(k);
    }
  }

  const dateKey = ["date", "date_start", "segments.date", "day", "stat_time_day"].find((k) => rows.some((r) => k in r));
  const spendKey = ["spend", "cost", "metrics.cost", "sessions", "impressions", "metrics.impressions", "contacts"].find((k) => rows.some((r) => k in r));
  // Page partielle : dite en première ligne, et jamais résumée (les sommes seraient prises pour des totaux).
  const partial = env.has_more === true || located.partial === true;
  const commonNumbers = Object.keys(common).filter((k) => typeof common[k] === "number");

  /** Rendu complet, avec ou sans fusion des doublons et abréviations. */
  const render = (compress) => {
    const merged = compress ? findDuplicates(rows) : [];
    const gone = new Set(merged.map(([c]) => c));
    const view = gone.size ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !gone.has(k)))) : rows;
    const { name, legend, stripped } = shortNames([...Object.keys(common), ...columnsOf(view)], compress);

    const head = (first, notes, hoisted) => {
      const lines = partial ? ["_attention: page partielle : les totaux ci-dessous sont incomplets, demande la suite ou réduis la période"] : [];
      const units = `${tuning.micros ? "montants en unités (micros convertis), " : ""}nombres arrondis`;
      // Une métrique en en-tête vaut pour chaque ligne : le dire, pour qu'elle ne soit pas lue comme un total.
      const constants = !hoisted.length ? "" : ` ; colonnes constantes en en-tête${hoisted.some((k) => commonNumbers.includes(k)) ? " (valeur de chaque ligne, pas un total)" : ""}`;
      lines.push(`_compact: ${first} ; ${[...notes, units].join(" ; ")}${constants}${stripped.length ? ` ; préfixes ${stripped.join(" ")} omis` : ""}`);
      if (legend.length) lines.push(`_abrév: ${legend.join(" ; ")}`);
      if (merged.length) lines.push(mergedNote(merged, name, columnsOf(view)));
      const header = [...Object.entries(env), ...hoisted.map((k) => [k, common[k]])].map(([k, v]) => `${name(k)}=${cell(v)}`);
      if (header.length) lines.push(header.join(" ; "));
      if (Object.keys(shared).length) lines.push(`_shared: ${JSON.stringify(shared)}`);
      return lines;
    };

    // Rendu en lignes : plafond, colonnes recalculables, blocs par groupe.
    let shown = view;
    let truncated = null;
    // Plafond de lignes : dates les plus récentes, sinon top dépense.
    if (view.length > tuning.cap) {
      const sorted = [...view];
      if (tuning.order === "date" && dateKey) {
        sorted.sort((a, b) => String(b[dateKey]).localeCompare(String(a[dateKey])));
        truncated = { shown: tuning.cap, total, kept: `dates les plus récentes (${dateKey})` };
      } else if (spendKey) {
        sorted.sort((a, b) => (Number(b[spendKey]) || 0) - (Number(a[spendKey]) || 0));
        truncated = { shown: tuning.cap, total, kept: `top ${spendKey}` };
      } else {
        truncated = { shown: tuning.cap, total, kept: "ordre d'origine" };
      }
      shown = sorted.slice(0, tuning.cap);
      if (tuning.order === "date" && dateKey) shown.reverse(); // chronologique à l'affichage
    }

    // Colonnes denses d'abord, puis ordre d'apparition (dimensions avant métriques) ; la date en tête.
    const freq = {};
    const firstSeen = {};
    shown.forEach((r) => Object.keys(r).forEach((k) => { freq[k] = (freq[k] || 0) + 1; if (!(k in firstSeen)) firstSeen[k] = Object.keys(firstSeen).length; }));
    let cols = Object.keys(freq).sort((a, b) => (b === dateKey) - (a === dateKey) || freq[b] - freq[a] || firstSeen[a] - firstSeen[b]);

    const notes = [];
    if (tuning.fieldDrop && shown.length > RECALC_MIN_ROWS) {
      const formulas = cols.filter((c) => isNumCol(shown, c)).map((c) => ratioFormula(c, shown, cols)).filter(Boolean);
      if (formulas.length) {
        cols = cols.filter((c) => !formulas.some((f) => f.col === c));
        notes.push(`colonnes recalculables retirées (${formulas.map((f) => formulaText(f, name)).join(" ; ")})`);
      }
    }

    let body = tsv(shown, cols, name);
    const cand = groupCandidates(shown, [...sharedCols])[0];
    if (cand) {
      const { groups, attrs } = groupBy(shown, cand.col);
      const rest = cols.filter((c) => c !== cand.col && !attrs.includes(c));
      const blocks = [rest.map(name).join("\t")];
      for (const [v, g] of groups) blocks.push(groupTitle(v, g[0], attrs, name), ...tsv(g, rest, name).slice(1));
      if (blocks.join("\n").length <= body.join("\n").length * (1 - GROUP_MIN_GAIN)) {
        body = blocks;
        notes.unshift(`regroupées par ${name(cand.col)} (titre « # » avant les lignes de chaque groupe)`);
      }
    }
    // Lignes cachées par le plafond : leurs sommes restent lisibles. Sans elles, un
    // total recompté sur les lignes affichées passe pour celui du rapport (constaté
    // le 2026-10-01 : valeur des achats TikTok de Jow lue 106 k€ au lieu de 691 k€).
    if (truncated) {
      const sums = Object.keys(freq).filter((c) => ADDITIVE_COL.test(c) && isNumCol(view, c)).map((c) => {
        const sum = view.reduce((acc, r) => acc + (Number(r[c]) || 0), 0);
        return `${name(c)}=${Math.round(sum * 100) / 100}`;
      });
      if (sums.length) notes.unshift(`totaux sur les ${total} lignes, cachées comprises : ${sums.join(" ; ")}`);
    }
    const first = `${total} ligne${total > 1 ? "s" : ""}${truncated ? `, ${truncated.shown} affichées (${truncated.kept}) — affine la période ou le filtre pour le reste` : ""}`;
    const table = { text: [...head(first, notes, Object.keys(common)), ...body].join("\n"), mode: "table", truncated, summary: null };

    // Au-delà du plafond, la synthèse couvre toute la période là où le détail est tronqué. Les
    // métriques constantes reviennent dans les lignes : en en-tête, leur total serait perdu.
    if (!truncated || partial || !tuning.fieldDrop || !tuning.summary || !dateKey) return table;
    const full = commonNumbers.length ? view.map((r) => ({ ...Object.fromEntries(commonNumbers.map((k) => [k, common[k]])), ...r })) : view;
    const s = summarize(full, dateKey, name, tuning.cap, [...sharedCols]);
    if (!s) return table;
    const hoisted = Object.keys(common).filter((k) => !commonNumbers.includes(k));
    const out = [...head(`${total} lignes jour × ${name(s.key)}`, s.notes, hoisted), ...s.lines].join("\n");
    // Pas de comparaison de taille ici : le détail tronqué ne couvre pas la même période.
    return { text: out, mode: "summary", truncated: null, summary: s.info };
  };

  // Sur un petit tableau, annoncer une fusion ou une abréviation coûte plus qu'elle ne rapporte.
  const compressed = render(true);
  const plain = render(false);
  const best = plain.text.length < compressed.text.length ? plain : compressed;
  return finish(best.text, minified, best.summary ? { ...stats, summary: best.summary } : stats, best.mode, best.truncated);
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
  if (ctx?.server === TIKTOK && ctx?.tool === "get_advertiser_info") return tiktokAdvertiserResult(result);
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
