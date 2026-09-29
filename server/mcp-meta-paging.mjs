/**
 * Suite automatique des séries quotidiennes Meta coupées par la pagination.
 *
 * Pourquoi : l'API Insights de Meta rend 25 lignes par page quand aucun
 * `limit` n'est passé, et les outils n8n n'exposent ni `limit` ni `after`.
 * Mesuré le 2026-09-29 : 30 jours demandés à Daily_Performance1, 25 reçus —
 * les 5 jours les plus récents manquaient, avec pour seul signal `paging.next`.
 *
 * Le proxy (server/mcp-scoped-ads.mjs) rappelle donc le même outil sur la
 * période restante et recolle les pages, tant que la série n'est pas complète.
 * Ce module est pur (aucun réseau) et testé dans
 * lib/__tests__/mcp-meta-paging.test.ts.
 */

/** Pages supplémentaires au plus par appel : borne le temps et le volume. */
export const MAX_EXTRA_PAGES = 8;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Date du jour à Paris (les comptes de l'agence sont en Europe/Paris). */
export function todayInParis(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(now);
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Les outils n8n retirés attendent `{input: "<json>"}`, les autres un objet. */
function readParams(args) {
  if (!args || typeof args !== "object") return null;
  if (typeof args.input === "string") {
    try {
      const p = JSON.parse(args.input);
      return p && typeof p === "object" && !Array.isArray(p) ? { params: p, legacy: true } : null;
    } catch { return null; }
  }
  return { params: args, legacy: false };
}

function readRange(v) {
  let r = v;
  if (typeof r === "string") {
    if (!r.trim()) return null;
    try { r = JSON.parse(r); } catch { return null; }
  }
  if (!r || typeof r !== "object") return null;
  return ISO_DAY.test(String(r.since)) && ISO_DAY.test(String(r.until)) ? { since: r.since, until: r.until } : null;
}

/** Dernier jour couvert par un `date_preset`, ou null quand on ne sait pas le dire. */
function presetUntil(preset, today) {
  if (typeof preset !== "string") return null;
  if (/^last_\d+d$/.test(preset) || preset === "yesterday") return addDays(today, -1);
  if (preset === "today" || preset === "this_month" || preset === "this_year" || preset === "this_quarter") return today;
  return null;
}

/** Texte d'un résultat MCP → { body, wrapped } (n8n emballe parfois dans un tableau d'un élément). */
export function readPage(result) {
  if (!result || result.isError || !Array.isArray(result.content)) return null;
  const texts = result.content.filter((c) => c && c.type === "text" && typeof c.text === "string");
  if (texts.length !== 1) return null;
  let j;
  try { j = JSON.parse(texts[0].text); } catch { return null; }
  const wrapped = Array.isArray(j) && j.length === 1 && j[0] && typeof j[0] === "object" && !Array.isArray(j[0]);
  const body = wrapped ? j[0] : j;
  if (!body || typeof body !== "object" || !Array.isArray(body.data)) return null;
  return { body, wrapped };
}

/**
 * Arguments de l'appel suivant, ou null quand il n'y a rien à poursuivre
 * (série non quotidienne, page complète, fin de période inconnue…).
 * La suite repart du DERNIER jour reçu, pas du lendemain : avec plusieurs
 * lignes par jour (niveau campagne), la coupe peut tomber au milieu d'un jour.
 * @returns {{ args: any, from: string } | null}
 */
export function nextCall(args, page, today = todayInParis()) {
  const read = readParams(args);
  if (!read || !page?.body?.paging?.next) return null;
  const { params, legacy } = read;
  if (String(params.time_increment ?? "") !== "1") return null;

  const days = page.body.data.map((r) => r?.date_start).filter((d) => ISO_DAY.test(String(d)));
  if (days.length === 0 || days.length !== page.body.data.length) return null;
  const last = days.reduce((a, b) => (a > b ? a : b));
  const first = days.reduce((a, b) => (a < b ? a : b));

  const until = readRange(params.time_range)?.until ?? presetUntil(params.date_preset, today);
  if (!until || last >= until) return null;
  // Une page entière sur un seul jour : repartir de ce jour tournerait en rond.
  if (first === last) return null;

  const next = { ...params, date_preset: "", time_range: JSON.stringify({ since: last, until }) };
  return { args: legacy ? { ...args, input: JSON.stringify(next) } : next, from: last };
}

/**
 * Recolle la page suivante : les lignes du jour de reprise déjà reçues sont
 * remplacées par celles de la nouvelle page (jour complet).
 */
export function mergePages(page, nextPage, from) {
  const kept = page.body.data.filter((r) => r.date_start < from);
  return {
    wrapped: page.wrapped,
    body: { ...page.body, data: [...kept, ...nextPage.body.data], paging: nextPage.body.paging },
  };
}

/** Page recollée → résultat MCP de même forme que l'original. */
export function toResult(result, page) {
  const text = JSON.stringify(page.wrapped ? [page.body] : page.body);
  return { ...result, content: result.content.map((c) => (c && c.type === "text" ? { ...c, text } : c)) };
}

/**
 * Poursuit une série quotidienne coupée. `call(args)` rappelle l'outil en amont.
 * En cas d'échec d'une page, rend ce qui a été recollé jusque-là : `paging.next`
 * reste présent et la compaction annonce la page partielle.
 * @returns {Promise<{ result: any, pages: number }>}
 */
export async function followDailyPages(result, args, call, { today = todayInParis(), maxPages = MAX_EXTRA_PAGES } = {}) {
  let page = readPage(result);
  if (!page) return { result, pages: 0 };
  let pages = 0;
  while (pages < maxPages) {
    const step = nextCall(args, page, today);
    if (!step) break;
    let nextPage;
    try { nextPage = readPage(await call(step.args)); } catch { break; }
    if (!nextPage || nextPage.body.data.length === 0) break;
    page = mergePages(page, nextPage, step.from);
    pages++;
  }
  return pages === 0 ? { result, pages } : { result: toResult(result, page), pages };
}
