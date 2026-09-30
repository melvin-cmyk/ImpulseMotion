/**
 * Arguments des outils TikTok Ads (serveur MCP n8n « TikTok Ads MCP v2.1 »),
 * complétés par le proxy de périmètre avant l'envoi.
 *
 * Pourquoi : dans le flux n8n, les paramètres « fixes » des rapports
 * (report_type, data_level, dimensions, metrics, page, page_size) sont en
 * réalité demandés au modèle, sans description — constaté par appel le
 * 2026-09-30 : un rapport sans eux est rejeté avant d'atteindre TikTok. Un
 * modèle qui les devine obtient une erreur, ou un rapport qui n'est pas celui
 * que l'outil annonce. Ici les valeurs prévues par le flux sont posées par le
 * serveur, et la description rendue au modèle dit ce qu'il reste à fournir.
 *
 * Pur, sans réseau : testé dans lib/__tests__/mcp-tiktok-args.test.ts.
 */

const BASE_METRICS = [
  "spend", "impressions", "reach", "frequency", "clicks", "ctr", "cpc", "cpm",
  "conversion", "cost_per_conversion", "conversion_rate",
  "video_play_actions", "video_watched_2s", "video_watched_6s", "video_views_p100",
  "complete_payment", "complete_payment_roas",
];

/** Ce que le serveur fixe, par outil de rapport. Une clé absente reste au modèle. */
const REPORTS = {
  get_campaign_performance: {
    data_level: "AUCTION_CAMPAIGN",
    dimensions: ["campaign_id"],
    metrics: ["campaign_name", "objective_type", ...BASE_METRICS],
  },
  get_adgroup_performance: {
    data_level: "AUCTION_ADGROUP",
    dimensions: ["adgroup_id"],
    metrics: ["campaign_name", "adgroup_name", "objective_type", ...BASE_METRICS],
  },
  get_ad_performance: {
    data_level: "AUCTION_AD",
    dimensions: ["ad_id"],
    metrics: ["campaign_name", "adgroup_name", "ad_name", "objective_type", ...BASE_METRICS],
  },
  get_breakdown_report: {
    data_level: "AUCTION_CAMPAIGN",
    metrics: ["spend", "impressions", "reach", "clicks", "ctr", "cpc", "cpm", "conversion", "cost_per_conversion", "conversion_rate"],
  },
  get_report_integrated: {},
};

/** Outils dont `filtering` est exigé par n8n alors qu'il est facultatif pour TikTok. */
const FILTERED = new Set(["get_adgroups", "get_ads"]);

const PAGE_SIZE = 1000;

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Une liste (tableau, tableau JSON en chaîne, ou « a,b ») → tableau JSON en chaîne ; null si vide. */
function jsonList(v) {
  let list = null;
  if (Array.isArray(v)) list = v;
  else if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (t.startsWith("[")) {
      try { const p = JSON.parse(t); if (Array.isArray(p)) list = p; } catch { /* rendu tel quel plus bas */ }
      if (!list) return t;
    } else {
      list = t.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!list) return null;
  const items = list.filter((x) => typeof x === "string" || typeof x === "number").map((x) => String(x).trim()).filter(Boolean);
  return items.length ? JSON.stringify(items) : null;
}

function reportArgs(name, given) {
  const fixed = REPORTS[name];
  const out = { ...given, report_type: "BASIC" };
  if (fixed.data_level) out.data_level = fixed.data_level;
  else if (typeof out.data_level === "string") out.data_level = out.data_level.trim().toUpperCase();

  for (const key of ["dimensions", "metrics"]) {
    const value = fixed[key] ? JSON.stringify(fixed[key]) : jsonList(given[key]);
    if (value) out[key] = value;
    else delete out[key];
  }

  const page = Number(given.page);
  out.page = Number.isInteger(page) && page >= 1 && page <= 9999 ? String(page) : "1";
  const size = Number(given.page_size);
  out.page_size = Number.isInteger(size) && size >= 1 && size <= PAGE_SIZE ? String(size) : String(PAGE_SIZE);
  return out;
}

function advertiserInfoArgs(given) {
  const out = { ...given };
  // Le modèle donne volontiers `advertiser_id`, comme aux autres outils.
  const ids = jsonList(out.advertiser_ids) ?? jsonList(out.advertiser_id);
  delete out.advertiser_id;
  if (ids) out.advertiser_ids = ids;
  return out;
}

function filteredArgs(given) {
  const out = { ...given };
  if (isObject(out.filtering)) out.filtering = JSON.stringify(out.filtering);
  else if (typeof out.filtering !== "string" || !out.filtering.trim()) out.filtering = "{}";
  return out;
}

/**
 * Arguments réellement envoyés en amont. Les outils n8n d'ancienne génération
 * attendent `{ input: "<objet JSON en chaîne>" }` ; la forme reçue est lue
 * dans les deux cas et rendue sous la forme attendue (`legacy`).
 * Une entrée illisible est rendue telle quelle : l'amont la rejette.
 * @param {string} name
 * @param {unknown} args
 * @param {{ legacy?: boolean }} [opts]
 */
export function prepareTikTokArgs(name, args, { legacy = true } = {}) {
  const complete = REPORTS[name] ? (o) => reportArgs(name, o)
    : name === "get_advertiser_info" ? advertiserInfoArgs
    : FILTERED.has(name) ? filteredArgs
    : null;

  let given = args;
  if (isObject(args) && "input" in args) {
    if (isObject(args.input)) given = args.input;
    else if (typeof args.input === "string") {
      try { given = JSON.parse(args.input); } catch { return args; }
    } else return args;
  }
  if (!isObject(given)) return args;

  const out = complete ? complete(given) : given;
  return legacy ? { input: JSON.stringify(out) } : out;
}

const SHAPE = "Tool expects valid stringified JSON object";
const DATES = "start_date, end_date (required, YYYY-MM-DD, in the account timezone, 30 days at most)";
const PAGING = `page (optional, 1 by default; ${PAGE_SIZE} rows per page, read page_info.total_page in the answer)`;
const SERVER_SIDE = "Everything else (report_type, page_size…) is set by the server: do not send it.";

const PARAMS = {
  get_campaign_performance: `advertiser_id (required), ${DATES}, ${PAGING}. ${SERVER_SIDE}`,
  get_adgroup_performance: `advertiser_id (required), ${DATES}, ${PAGING}. ${SERVER_SIDE}`,
  get_ad_performance: `advertiser_id (required), ${DATES}, ${PAGING}. ${SERVER_SIDE}`,
  get_breakdown_report: `advertiser_id (required), dimensions (required: JSON array with campaign_id plus ONE breakdown, e.g. ["campaign_id","age"]), ${DATES}, ${PAGING}. ${SERVER_SIDE}`,
  get_report_integrated:
    `advertiser_id (required), data_level (required: AUCTION_ADVERTISER, AUCTION_CAMPAIGN, AUCTION_ADGROUP or AUCTION_AD), ` +
    `dimensions (required: JSON array), metrics (required: JSON array), ${DATES}, ${PAGING}. ${SERVER_SIDE} ` +
    `Daily series of the account: data_level AUCTION_ADVERTISER, dimensions ["advertiser_id","stat_time_day"]; ` +
    `by campaign and by day: AUCTION_CAMPAIGN, ["campaign_id","stat_time_day"] with campaign_name among the metrics.`,
  get_adgroups: `advertiser_id (required), filtering (optional: JSON object, e.g. {"campaign_ids":["CAMPAIGN_ID"]}).`,
  get_ads: `advertiser_id (required), filtering (optional: JSON object, e.g. {"adgroup_ids":["ADGROUP_ID"]}).`,
  get_advertiser_info: `advertiser_id (required: ONE TikTok advertiser ID).`,
};

/**
 * Description rendue au modèle : le texte de l'amont, dont le bloc de
 * paramètres généré par n8n (qui annonce comme obligatoires des paramètres
 * sans description) est remplacé par ce que le modèle doit vraiment fournir.
 * @param {string} name
 * @param {string | undefined} description
 */
export function describeTikTokTool(name, description) {
  const text = typeof description === "string" ? description : "";
  const params = PARAMS[name];
  if (!params) return text;
  const cut = text.indexOf(SHAPE);
  const head = (cut >= 0 ? text.slice(0, cut) : text).trim();
  return `${head}\n${SHAPE}. Properties: ${params}`;
}
