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
 * C'est aussi ici que l'appel prend sa forme définitive : les arguments sont
 * relus en JSON strict, et seul l'objet relu est transmis. n8n lit plus
 * largement que JSON (notation objet, bloc de code) : une entrée que ce module
 * ne sait pas lire n'est jamais laissée à son interprétation.
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

/**
 * Dimensions d'un rapport BASIC : identifiants et temps. Toute autre dimension
 * (âge, genre, pays, placement…) relève du rapport AUDIENCE de TikTok.
 * D'après la documentation de l'API ; pas encore constaté sur un compte réel.
 */
const BASIC_DIMENSIONS = new Set(["advertiser_id", "campaign_id", "adgroup_id", "ad_id", "stat_time_day", "stat_time_hour"]);

/** Outils dont `filtering` est exigé par n8n alors qu'il est facultatif pour TikTok. */
const FILTERED = new Set(["get_adgroups", "get_ads"]);

const PAGE_SIZE = 1000;
const DATA_LEVELS = new Set(["AUCTION_ADVERTISER", "AUCTION_CAMPAIGN", "AUCTION_ADGROUP", "AUCTION_AD"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Nom d'une dimension ou d'une métrique TikTok. */
const FIELD = /^[a-z0-9_]+$/;

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const refuse = (what) => ({ error: `Appel refusé : ${what}.` });

/** Une liste de noms (tableau, tableau JSON en chaîne, ou « a,b ») → tableau ; null si absente, "invalid" si ce ne sont pas des noms. */
function fieldList(v) {
  let list = null;
  if (Array.isArray(v)) list = v;
  else if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (t.startsWith("[")) {
      try { list = JSON.parse(t); } catch { return "invalid"; }
    } else {
      list = t.split(",").map((x) => x.trim()).filter(Boolean);
    }
  } else if (v !== undefined && v !== null && v !== "") return "invalid";
  if (list === null) return null;
  if (!Array.isArray(list) || !list.length) return "invalid";
  const names = list.map((x) => (typeof x === "string" ? x.trim() : ""));
  return names.every((x) => FIELD.test(x)) ? names : "invalid";
}

/** Un rapport : les paramètres que le flux déclare, et eux seuls. */
function reportArgs(name, given) {
  const fixed = REPORTS[name];
  const out = { advertiser_id: given.advertiser_id };

  for (const key of ["start_date", "end_date"]) {
    const day = typeof given[key] === "string" ? given[key].trim() : "";
    if (!DAY.test(day)) return refuse("start_date et end_date s'écrivent AAAA-MM-JJ");
    out[key] = day;
  }

  const level = fixed.data_level ?? (typeof given.data_level === "string" ? given.data_level.trim().toUpperCase() : "");
  if (!DATA_LEVELS.has(level)) return refuse(`data_level est l'un de ${[...DATA_LEVELS].join(", ")}`);
  out.data_level = level;

  let dimensions = fixed.dimensions;
  if (!dimensions) {
    dimensions = fieldList(given.dimensions);
    if (!dimensions || dimensions === "invalid") return refuse('dimensions est un tableau JSON de noms de dimensions, par exemple ["campaign_id","age"]');
  }
  let metrics = fixed.metrics;
  if (!metrics) {
    metrics = fieldList(given.metrics);
    if (!metrics || metrics === "invalid") return refuse('metrics est un tableau JSON de noms de métriques, par exemple ["spend","impressions","clicks"]');
  }
  out.dimensions = JSON.stringify(dimensions);
  out.metrics = JSON.stringify(metrics);
  out.report_type = dimensions.some((d) => !BASIC_DIMENSIONS.has(d)) ? "AUDIENCE" : "BASIC";

  const page = Number(given.page);
  out.page = Number.isInteger(page) && page >= 1 && page <= 9999 ? String(page) : "1";
  const size = Number(given.page_size);
  out.page_size = Number.isInteger(size) && size >= 1 && size <= PAGE_SIZE ? String(size) : String(PAGE_SIZE);
  return out;
}

/** Identifiants donnés en texte (un seul, un tableau, ou un tableau JSON en chaîne) → tableau ; null pour toute autre forme. */
function idList(v) {
  let list = v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t.startsWith("[")) return t ? [t] : null;
    try { list = JSON.parse(t); } catch { return null; }
  }
  // Un nombre de 19 chiffres a déjà perdu ses derniers chiffres : il n'est pas repris.
  return Array.isArray(list) && list.length > 0 && list.every((x) => typeof x === "string") ? list.map((x) => x.trim()) : null;
}

function advertiserInfoArgs(given) {
  // Le modèle donne volontiers `advertiser_id`, comme aux autres outils.
  const asked = given.advertiser_ids !== undefined ? given.advertiser_ids : given.advertiser_id;
  const ids = idList(asked);
  // Une forme illisible est gardée telle quelle : le contrôle du compte la refuse, elle ne part pas.
  return { advertiser_ids: ids ? JSON.stringify(ids) : asked };
}

function filteredArgs(given) {
  let filtering = given.filtering;
  if (typeof filtering === "string" && filtering.trim()) {
    try { filtering = JSON.parse(filtering); } catch { filtering = "invalid"; }
  }
  if (filtering === undefined || filtering === null || filtering === "") filtering = {};
  if (!isObject(filtering)) return refuse('filtering est un objet JSON, par exemple {"campaign_ids":["CAMPAIGN_ID"]}');
  return { advertiser_id: given.advertiser_id, filtering: JSON.stringify(filtering) };
}

const UNREADABLE = "Appel refusé : les arguments doivent être un objet JSON strict (guillemets doubles, sans bloc de code ni commentaire) dans `input`.";

/**
 * L'appel tel qu'il part en amont. Les outils n8n d'ancienne génération
 * attendent `{ input: "<objet JSON en chaîne>" }` : quand `input` est donné,
 * lui seul compte (n8n ignore le reste) ; sinon les arguments eux-mêmes.
 * L'objet envoyé ne porte que les paramètres que l'outil déclare, relus un à
 * un : rien de ce que le modèle écrit ne part sans avoir été reconnu.
 * Rend `{ object, args }` — l'objet relu et complété, et la forme à envoyer
 * (`legacy`) — ou `{ error }`.
 * @param {string} name
 * @param {unknown} args
 * @param {{ legacy?: boolean }} [opts]
 * @returns {{ object: Record<string, unknown>, args: Record<string, unknown> } | { error: string }}
 */
export function prepareTikTokArgs(name, args, { legacy = true } = {}) {
  let given = {};
  if (isObject(args) && args.input !== undefined && args.input !== null) {
    given = args.input;
    if (typeof given === "string") {
      try { given = JSON.parse(given); } catch { given = null; }
    }
    if (!isObject(given)) return { error: UNREADABLE };
  } else if (isObject(args)) {
    given = args;
  } else if (args !== undefined && args !== null) {
    return { error: UNREADABLE };
  }

  const object = REPORTS[name] ? reportArgs(name, given)
    : name === "get_advertiser_info" ? advertiserInfoArgs(given)
    : FILTERED.has(name) ? filteredArgs(given)
    : { advertiser_id: given.advertiser_id };
  if ("error" in object) return { error: object.error };
  if (typeof object.advertiser_id === "string") object.advertiser_id = object.advertiser_id.trim();
  return { object, args: legacy ? { input: JSON.stringify(object) } : object };
}

const ADVERTISER_ID = /^\d{5,25}$/;

/**
 * Les comptes qu'un appel nomme, lus là où TikTok les lit : `advertiser_id`
 * au premier niveau (`advertiser_ids` pour la fiche d'un compte), en chaîne de
 * chiffres. Toute autre forme est une erreur, jamais « aucun compte ».
 * @param {string} name
 * @param {Record<string, unknown>} object l'objet rendu par prepareTikTokArgs
 * @returns {{ ids: string[] } | { error: string }}
 */
export function accountsOfTikTokCall(name, object) {
  const quoted = "l'identifiant du compte TikTok Ads s'écrit entre guillemets (un nombre de 19 chiffres est arrondi en route)";
  if (name === "get_advertiser_info") {
    let ids = null;
    try { ids = typeof object.advertiser_ids === "string" ? JSON.parse(object.advertiser_ids) : null; } catch { /* refusé plus bas */ }
    if (Array.isArray(ids) && ids.length > 0 && ids.every((x) => typeof x === "string" && ADVERTISER_ID.test(x))) return { ids };
    return { error: `Appel refusé : "${name}" doit nommer le compte interrogé par advertiser_id ; ${quoted}.` };
  }
  const id = object.advertiser_id;
  if (typeof id === "string" && ADVERTISER_ID.test(id)) return { ids: [id] };
  if (typeof id === "number") return { error: `Appel refusé : ${quoted}.` };
  return { error: `Appel refusé : "${name}" doit nommer le compte TikTok Ads interrogé (advertiser_id, des chiffres entre guillemets).` };
}

const SHAPE = "Tool expects valid stringified JSON object";
const DATES = "start_date, end_date (required, YYYY-MM-DD, in the account timezone, 30 days at most)";
const PAGING = `page (optional, 1 by default; ${PAGE_SIZE} rows per page, read page_info.total_page in the answer)`;
const SERVER_SIDE = "Everything else (report_type, page_size…) is set by the server: do not send it.";
const ACCOUNT = "advertiser_id (required: the digits of the TikTok advertiser ID, as a string in double quotes)";

const PARAMS = {
  get_campaign_performance: `${ACCOUNT}, ${DATES}, ${PAGING}. ${SERVER_SIDE}`,
  get_adgroup_performance: `${ACCOUNT}, ${DATES}, ${PAGING}. ${SERVER_SIDE}`,
  get_ad_performance: `${ACCOUNT}, ${DATES}, ${PAGING}. ${SERVER_SIDE}`,
  get_breakdown_report: `${ACCOUNT}, dimensions (required: JSON array with campaign_id plus ONE breakdown, e.g. ["campaign_id","age"]), ${DATES}, ${PAGING}. ${SERVER_SIDE}`,
  get_report_integrated:
    `${ACCOUNT}, data_level (required: AUCTION_ADVERTISER, AUCTION_CAMPAIGN, AUCTION_ADGROUP or AUCTION_AD), ` +
    `dimensions (required: JSON array), metrics (required: JSON array), ${DATES}, ${PAGING}. ${SERVER_SIDE} ` +
    `Daily series of the account: data_level AUCTION_ADVERTISER, dimensions ["advertiser_id","stat_time_day"]; ` +
    `by campaign and by day: AUCTION_CAMPAIGN, ["campaign_id","stat_time_day"] with campaign_name among the metrics.`,
  get_adgroups: `${ACCOUNT}, filtering (optional: JSON object, e.g. {"campaign_ids":["CAMPAIGN_ID"]}).`,
  get_ads: `${ACCOUNT}, filtering (optional: JSON object, e.g. {"adgroup_ids":["ADGROUP_ID"]}).`,
  get_advertiser_info: `${ACCOUNT}.`,
  get_campaigns: `${ACCOUNT}.`,
  list_custom_audiences: `${ACCOUNT}.`,
  search_ad_videos: `${ACCOUNT}.`,
  search_ad_images: `${ACCOUNT}.`,
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
