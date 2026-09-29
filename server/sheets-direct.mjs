/**
 * Google Sheets sans IA, pour les routines — routes /api/sheets/* du relay.
 *
 * Appels directs à l'API Sheets v4 sous l'identité partagée
 * data@impulse-analytics.com (jeton court de server/gws-auth.mjs). Le
 * consultant partage sa feuille avec cette adresse : en lecture pour lire, en
 * éditeur pour écrire.
 *
 * Trois actions, toutes par NOM de colonne (en-tête en ligne 1) :
 *   read    { spreadsheetId, tab, maxRows?, headerOnly? }
 *           → { columns, rows, rowNumbers, truncated, warnings }
 *   append  { spreadsheetId, tab, columns: [nom…], rows: [[valeur…]…] }
 *           → { appendedRows, updatedRange }
 *   update  { spreadsheetId, tab, updates: [{ row, column, value }…] }
 *           → { updatedCells }
 *
 * Valeurs lues (choix fixe, le même pour toutes les routines) :
 *   - nombres : valeur brute (UNFORMATTED_VALUE), donc 1234.5 et non
 *     « 1 234,50 € » ; un pourcentage affiché 12 % est lu 0.12 ;
 *   - dates et heures : le TEXTE affiché dans la feuille
 *     (dateTimeRenderOption=FORMATTED_STRING), pas le numéro de série ;
 *   - cellule vide : null ; ligne entièrement vide : ignorée ;
 *   - rowNumbers[i] est le numéro de ligne dans la feuille de rows[i].
 *
 * Écriture : valueInputOption=RAW (rien n'est interprété par Sheets), et toute
 * chaîne qui commence par = + - ou @ reçoit une apostrophe devant, pour qu'un
 * export ou une relecture par un tableur ne l'exécute jamais comme formule.
 * Les nombres et booléens passent tels quels. Une colonne inconnue, ou présente
 * deux fois dans l'en-tête, fait refuser toute la demande : rien n'est écrit.
 *
 * Aucune URL ne vient de l'appelant : l'identifiant de document et le nom
 * d'onglet sont validés puis encodés dans une adresse fixe.
 *
 * Erreurs : { status, json: { error, class } } — class "functional" (la
 * demande est fausse : document non partagé, onglet ou colonne introuvable)
 * ou "infra" (jeton, quota, panne Google).
 */

const API = "https://sheets.googleapis.com/v4/spreadsheets";
export const SHARE_EMAIL = "data@impulse-analytics.com";

export const DEFAULT_MAX_ROWS = 1000;
export const MAX_ROWS_CAP = 5000;
export const MAX_APPEND_ROWS = 500;
export const MAX_UPDATES = 500;
/** Columns read: A to ZZ. */
export const MAX_COLUMNS = 702;
/** Sheets refuses more than 50 000 characters in one cell. */
export const MAX_CELL_CHARS = 50_000;
const LAST_COLUMN = "ZZ";
const TIMEOUT_MS = 20_000;

export class SheetsError extends Error {
  /** @param {"functional"|"infra"} errorClass */
  constructor(message, errorClass = "functional", status = errorClass === "infra" ? 502 : 422) {
    super(message);
    this.name = "SheetsError";
    this.errorClass = errorClass;
    this.status = status;
  }
}
const refuse = (message) => new SheetsError(message, "functional", 400);

// ── Validation ───────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{20,100}$/;
// Characters Sheets itself refuses in a tab name, plus control characters.
const TAB_FORBIDDEN = /[\[\]*?:\/\\\u0000-\u001f\u007f]/;

/** The document id alone (never a URL); throws otherwise. */
export function validateSpreadsheetId(value) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw refuse("Identifiant de document invalide : attendu l'identifiant du Google Sheet (la partie de l'adresse entre /d/ et /edit), pas une adresse.");
  }
  return value;
}

export function validateTab(value) {
  if (typeof value !== "string") throw refuse("Nom d'onglet invalide.");
  const tab = value.trim();
  if (!tab || tab.length > 100 || TAB_FORBIDDEN.test(tab) || tab.startsWith("'") || tab.endsWith("'")) {
    throw refuse("Nom d'onglet invalide : 1 à 100 caractères, sans [ ] * ? : / \\ ni apostrophe au début ou à la fin.");
  }
  return tab;
}

/** "Suivi créas" → "'Suivi créas'" (apostrophes doubled), as A1 notation wants. */
export function quoteTab(tab) {
  return `'${tab.replace(/'/g, "''")}'`;
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_COLUMNS) throw refuse("Colonne hors limites (A à ZZ).");
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ── Values ───────────────────────────────────────────────────────────────────

/**
 * Formula injection: a string whose first visible character is = + - or @
 * (or that starts with a tab or a carriage return) gets an apostrophe in front.
 * Already prefixed = unchanged, so applying it twice is harmless.
 */
export function neutralizeFormula(value) {
  if (typeof value !== "string" || value === "") return value;
  if (/^[\t\r\n]/.test(value) || /^[=+\-@]/.test(value.trimStart())) return `'${value}`;
  return value;
}

/** One cell to write: string, finite number, boolean or null (written empty). */
export function cellToWrite(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw refuse("Valeur numérique invalide (infinie ou NaN).");
    return value;
  }
  if (typeof value !== "string") throw refuse("Valeur de cellule invalide : texte, nombre, booléen ou vide seulement.");
  if (value.length > MAX_CELL_CHARS) throw refuse(`Valeur trop longue : ${MAX_CELL_CHARS} caractères au plus par cellule.`);
  return neutralizeFormula(value);
}

function cellRead(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return String(value);
}

/**
 * Header row → column names with their position. Empty header cells are
 * skipped (their column is not read); a name present twice keeps its first
 * position and is listed in `duplicates`.
 */
export function parseHeader(row) {
  const columns = [];
  const indexOf = new Map();
  const duplicates = [];
  (Array.isArray(row) ? row : []).slice(0, MAX_COLUMNS).forEach((cell, i) => {
    const name = String(cell ?? "").trim();
    if (!name) return;
    if (indexOf.has(name)) { if (!duplicates.includes(name)) duplicates.push(name); return; }
    indexOf.set(name, i);
    columns.push(name);
  });
  return { columns, indexOf, duplicates };
}

/** Raw values of the API (header first) → rows by column name. */
export function toRowSet(values, maxRows) {
  const all = Array.isArray(values) ? values : [];
  const header = parseHeader(all[0]);
  if (!header.columns.length) throw new SheetsError("En-tête introuvable : la ligne 1 de l'onglet est vide.");
  const rows = [];
  const rowNumbers = [];
  let truncated = false;
  for (let i = 1; i < all.length; i++) {
    const raw = Array.isArray(all[i]) ? all[i] : [];
    const row = {};
    let filled = false;
    for (const name of header.columns) {
      const v = cellRead(raw[header.indexOf.get(name)]);
      if (v !== null) filled = true;
      row[name] = v;
    }
    if (!filled) continue;
    if (rows.length >= maxRows) { truncated = true; break; }
    rows.push(row);
    rowNumbers.push(i + 1);
  }
  const warnings = header.duplicates.map((d) => `Colonne « ${d} » présente plusieurs fois dans l'en-tête : seule la première est lue.`);
  return { columns: header.columns, rows, rowNumbers, truncated, warnings };
}

function clampMaxRows(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_ROWS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw refuse(`maxRows invalide : entier de 1 à ${MAX_ROWS_CAP}.`);
  return Math.min(n, MAX_ROWS_CAP);
}

/** Position of a column to write; refuses an unknown or ambiguous name. */
function targetColumn(header, name) {
  if (typeof name !== "string" || !name.trim()) throw refuse("Nom de colonne vide.");
  const key = name.trim();
  if (!header.indexOf.has(key)) throw new SheetsError(`Colonne inconnue : « ${key} » n'est pas dans l'en-tête de l'onglet. Rien n'a été écrit.`);
  if (header.duplicates.includes(key)) throw new SheetsError(`Colonne ambiguë : « ${key} » est présente plusieurs fois dans l'en-tête. Rien n'a été écrit.`);
  return header.indexOf.get(key);
}

/** Rows to append, laid out on the width of the header ("" where no value is given). */
export function buildAppendValues(headerRow, columns, rows) {
  const header = parseHeader(headerRow);
  if (!header.columns.length) throw new SheetsError("En-tête introuvable : la ligne 1 de l'onglet est vide.");
  if (!Array.isArray(columns) || !columns.length) throw refuse("columns requis : la liste des colonnes à remplir.");
  if (!Array.isArray(rows) || !rows.length) throw refuse("rows requis : au moins une ligne.");
  if (rows.length > MAX_APPEND_ROWS) throw refuse(`Trop de lignes : ${MAX_APPEND_ROWS} au plus par appel.`);
  const positions = columns.map((c) => targetColumn(header, c));
  if (new Set(positions).size !== positions.length) throw refuse("Une colonne est citée deux fois.");
  const width = Math.max(...positions) + 1;
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw refuse("Chaque ligne doit porter une valeur par colonne citée.");
    const out = new Array(width).fill("");
    row.forEach((v, i) => { out[positions[i]] = cellToWrite(v); });
    return out;
  });
}

/** Cell updates → the `data` of values:batchUpdate, one range per cell. */
export function buildUpdateData(headerRow, tab, updates) {
  const header = parseHeader(headerRow);
  if (!header.columns.length) throw new SheetsError("En-tête introuvable : la ligne 1 de l'onglet est vide.");
  if (!Array.isArray(updates) || !updates.length) throw refuse("updates requis : au moins une cellule.");
  if (updates.length > MAX_UPDATES) throw refuse(`Trop de cellules : ${MAX_UPDATES} au plus par appel.`);
  const seen = new Set();
  return updates.map((u) => {
    if (!u || typeof u !== "object") throw refuse("Mise à jour invalide.");
    const row = Number(u.row);
    // Row 1 is the header: never rewritten.
    if (!Number.isInteger(row) || row < 2 || row > 1_000_000) throw refuse("Numéro de ligne invalide : entier à partir de 2 (la ligne 1 est l'en-tête).");
    const cell = `${columnLetter(targetColumn(header, u.column))}${row}`;
    if (seen.has(cell)) throw refuse(`Cellule ${cell} citée deux fois.`);
    seen.add(cell);
    return { range: `${quoteTab(tab)}!${cell}`, values: [[cellToWrite(u.value)]] };
  });
}

// ── Google ───────────────────────────────────────────────────────────────────

/**
 * Google's answer to a failed call, in plain words.
 * @param {number} status
 * @param {any} payload
 * @param {{ tab?: string, write?: boolean }} [ctx]
 */
export function explainGoogleError(status, payload, { tab, write = false } = {}) {
  const err = payload && typeof payload === "object" ? payload.error : null;
  const message = String(err?.message ?? "").slice(0, 200);
  const reason = String(err?.status ?? "");
  const details = JSON.stringify(err?.details ?? "");
  if (status === 401) return new SheetsError("Jeton Google refusé : identité partagée à reconnecter sur le relay.", "infra");
  if (status === 403 && /SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(`${details} ${message}`)) {
    return new SheetsError(`Le jeton Google du relay n'a pas le droit ${write ? "d'écrire" : "de lire"} dans Google Sheets (autorisation à étendre par un administrateur).`, "infra");
  }
  if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(`${details} ${message}`)) {
    return new SheetsError("API Google Sheets non activée pour le projet Google du relay.", "infra");
  }
  if (status === 403) {
    return new SheetsError(write
      ? `Écriture refusée : le document doit être partagé en éditeur avec ${SHARE_EMAIL} (et l'onglet ne doit pas être protégé).`
      : `Document non partagé avec ${SHARE_EMAIL} : ouvrir le partage du Google Sheet et ajouter cette adresse.`);
  }
  if (status === 404) return new SheetsError(`Document introuvable : vérifier l'identifiant, et que le Google Sheet est partagé avec ${SHARE_EMAIL}.`);
  if (status === 400 && /unable to parse range/i.test(message)) return new SheetsError(`Onglet introuvable : « ${tab} » n'existe pas dans ce document (vérifier le nom exact, accents et espaces compris).`);
  if (status === 400 && /not supported for this document/i.test(message)) return new SheetsError("Ce fichier n'est pas un Google Sheet (fichier Excel déposé dans Drive ?) : l'enregistrer au format Google Sheets.");
  if (status === 429 || reason === "RESOURCE_EXHAUSTED") return new SheetsError("Quota Google Sheets atteint, réessayer dans une minute.", "infra");
  if (status >= 500) return new SheetsError(`Google Sheets indisponible (HTTP ${status}).`, "infra");
  return new SheetsError(`Google Sheets a refusé la demande (HTTP ${status})${message ? ` : ${message}` : ""}.`);
}

async function google(deps, method, pathAndQuery, body, ctx) {
  let token;
  try { token = await deps.getToken(); }
  catch (err) { throw new SheetsError(String(err?.message || err).slice(0, 300), "infra"); }
  if (!token) throw new SheetsError("Jeton Google absent sur le relay.", "infra");
  let res;
  try {
    res = await (deps.fetch ?? fetch)(`${API}/${pathAndQuery}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SheetsError(`Google Sheets injoignable : ${String(err?.message || err).slice(0, 120)}`, "infra");
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw explainGoogleError(res.status, payload, ctx);
  return payload ?? {};
}

const READ_OPTIONS = "majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";
const valuesPath = (id, range) => `${id}/values/${encodeURIComponent(range)}`;

async function fetchHeader(deps, id, tab, write) {
  const data = await google(deps, "GET", `${valuesPath(id, `${quoteTab(tab)}!1:1`)}?${READ_OPTIONS}`, null, { tab, write });
  return Array.isArray(data.values) ? data.values[0] ?? [] : [];
}

export async function readSheet(input, deps) {
  const id = validateSpreadsheetId(input?.spreadsheetId);
  const tab = validateTab(input?.tab);
  if (input?.headerOnly === true) {
    const header = parseHeader(await fetchHeader(deps, id, tab, false));
    if (!header.columns.length) throw new SheetsError("En-tête introuvable : la ligne 1 de l'onglet est vide.");
    return { ...toRowSet([header.columns], 0), warnings: header.duplicates.map((d) => `Colonne « ${d} » présente plusieurs fois dans l'en-tête : seule la première est lue.`) };
  }
  const maxRows = clampMaxRows(input?.maxRows);
  // One row more than asked, to know whether the tab holds more.
  const range = `${quoteTab(tab)}!A1:${LAST_COLUMN}${maxRows + 2}`;
  const data = await google(deps, "GET", `${valuesPath(id, range)}?${READ_OPTIONS}`, null, { tab });
  return toRowSet(data.values, maxRows);
}

export async function appendRows(input, deps) {
  const id = validateSpreadsheetId(input?.spreadsheetId);
  const tab = validateTab(input?.tab);
  const values = buildAppendValues(await fetchHeader(deps, id, tab, true), input?.columns, input?.rows);
  const query = "valueInputOption=RAW&insertDataOption=INSERT_ROWS&includeValuesInResponse=false";
  const data = await google(deps, "POST", `${valuesPath(id, `${quoteTab(tab)}!A1`)}:append?${query}`, { majorDimension: "ROWS", values }, { tab, write: true });
  return { appendedRows: Number(data.updates?.updatedRows ?? values.length), updatedRange: String(data.updates?.updatedRange ?? "") };
}

export async function updateCells(input, deps) {
  const id = validateSpreadsheetId(input?.spreadsheetId);
  const tab = validateTab(input?.tab);
  const data = buildUpdateData(await fetchHeader(deps, id, tab, true), tab, input?.updates);
  const out = await google(deps, "POST", `${id}/values:batchUpdate`, { valueInputOption: "RAW", includeValuesInResponse: false, data }, { tab, write: true });
  return { updatedCells: Number(out.totalUpdatedCells ?? data.length) };
}

const ACTIONS = { read: readSheet, append: appendRows, update: updateCells };

/**
 * What the relay routes call. Never throws: { status, json }.
 * deps = { getToken: async () => string, fetch? }.
 */
export async function handleSheetsRequest(action, body, deps) {
  const run = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!run) return { status: 404, json: { error: "Action inconnue.", class: "functional" } };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, json: { error: "Corps JSON requis.", class: "functional" } };
  try {
    return { status: 200, json: { result: await run(body, deps) } };
  } catch (err) {
    if (err instanceof SheetsError) return { status: err.status, json: { error: err.message, class: err.errorClass } };
    return { status: 500, json: { error: `Erreur interne : ${String(err?.message || err).slice(0, 200)}`, class: "infra" } };
  }
}
