/**
 * Compaction déterministe et générique des résultats d'outils des serveurs MCP
 * maison (gws, sandbox, client-data) avant qu'ils n'atteignent le modèle.
 *
 * Pourquoi un module à part de server/mcp-compact.mjs : celui-ci est réglé pour
 * Meta / Google Ads / GA4 (il arrondit, convertit les chaînes numériques et les
 * micros, retire createTime / parent / metadata, plafonne à 100 lignes triées
 * par dépense). Sur un export Sheets ou une liste Drive, ce serait de la perte
 * silencieuse (« 01230 » → 1230, dates de création retirées). Ici, rien n'est
 * réinterprété : on change la forme, pas les valeurs. Un nombre est rendu tel
 * qu'il est écrit dans le texte reçu (12345678901234567890, 1.10), jamais
 * tel que JavaScript l'aurait arrondi.
 *
 * Tout est pur (aucun accès disque ni réseau), testé dans
 * lib/__tests__/mcp-compact-generic.test.ts :
 *  - renderJson   : JSON → minifié, ou tableau TSV quand c'est une liste d'objets
 *  - foldOutput   : stdout/stderr répétitif replié (barres de progression,
 *                   lignes identiques, avertissements répétés, np.float64(…))
 *  - capMiddle    : plafond avec début et fin conservés, coupe sur des lignes
 *  - sliceText    : lecture d'un texte par plage (lignes ou caractères)
 *  - createReadLedger : mémoire des plages déjà servies (relecture évitée)
 *  - renderFileList / renderSkillList : inventaire groupé par dossier
 *
 * Règle commune : ce qui est coupé ou replié est annoncé dans la sortie, avec
 * la façon d'obtenir le reste. Seuls les changements de forme sans perte
 * (minification, tableau) sont muets.
 */

// Nombre gardé sous sa forme écrite (JSON.rawJSON, Node ≥ 21) : JSON.stringify le
// rend tel quel. Sans cette API, renderJson renonce à mettre en forme un texte
// dont un nombre ne survivrait pas à l'aller-retour.
const RAW_JSON = /** @type {{ rawJSON?: (text: string) => unknown, isRawJSON?: (v: unknown) => boolean }} */ (/** @type {unknown} */ (JSON));
const HAS_RAW = typeof RAW_JSON.rawJSON === "function" && typeof RAW_JSON.isRawJSON === "function";
const isRaw = (v) => HAS_RAW && v !== null && typeof v === "object" && !!RAW_JSON.isRawJSON?.(v);

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !isRaw(v);
const isScalar = (v) => v === null || typeof v !== "object" || isRaw(v);
// Séparateurs de ligne : ceux de JSON, et ceux qu'un lecteur de lignes coupe aussi.
const LINE_BREAK = /[\t\n\r\v\f\u0085\u2028\u2029]/;
const SAFE_KEY = /^(?!#)[^.\t\n\r\v\f\u0085\u2028\u2029=;]+$/;
const FLATTEN_DEPTH = 3;
const MIN_FILL = 0.5;

/** JSON.stringify, plus l'échappement des séparateurs de ligne qu'il laisse en clair. */
function json(v) {
  const t = JSON.stringify(v);
  return t === undefined ? t : t.replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Cellule de tableau : chaîne nue quand elle se relit sans ambiguïté, JSON
 * sinon. Un # en tête est protégé : seule une vraie ligne de titre commence ainsi.
 */
function cell(v) {
  if (v === undefined) return "";
  if (typeof v === "string") {
    if (v === "" || v === "null" || v === "true" || v === "false" || LINE_BREAK.test(v) || /^\s|\s$/.test(v) || /^["[{#]/.test(v)) return json(v);
    return v;
  }
  return json(v);
}

/** Valeur d'en-tête (`clé=valeur ; clé=valeur`) : comme une cellule, séparateur protégé. */
const headerCell = (v) => (typeof v === "string" && v.includes(" ; ") ? json(v) : cell(v));

/** Valeur d'une page (`clé=valeur | valeur`) : comme une cellule, séparateur protégé. */
const pageCell = (v) => (typeof v === "string" && v.includes(" | ") ? json(v) : cell(v));

/** Objet imbriqué → colonnes pointées (start.dateTime) ; les tableaux restent en JSON dans la cellule. */
function flattenRow(obj, prefix = "", depth = 0, out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (!SAFE_KEY.test(k)) return null;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlain(v) && Object.keys(v).length > 0 && depth < FLATTEN_DEPTH) {
      if (!flattenRow(v, key, depth + 1, out)) return null;
    } else out[key] = v;
  }
  return out;
}

/** Liste d'objets → lignes TSV (en-tête + une ligne par élément), ou null si la forme ne s'y prête pas. */
function tableLines(name, list) {
  const rows = [];
  for (const item of list) {
    const r = flattenRow(item);
    if (!r) return null;
    rows.push(r);
  }
  const cols = [];
  const seen = new Set();
  let filled = 0;
  for (const r of rows) for (const k of Object.keys(r)) { filled++; if (!seen.has(k)) { seen.add(k); cols.push(k); } }
  if (cols.length === 0 || filled / (rows.length * cols.length) < MIN_FILL) return null;

  // Colonnes constantes (≥ 3 lignes, présentes partout) : dites une fois.
  const constants = [];
  if (rows.length >= 3) {
    for (const c of [...cols]) {
      if (!rows.every((r) => c in r)) continue;
      const v0 = json(rows[0][c]);
      if (rows.every((r) => json(r[c]) === v0)) {
        constants.push(`${c}=${headerCell(rows[0][c])}`);
        cols.splice(cols.indexOf(c), 1);
      }
    }
  }
  const title = `# ${name ? `${name} : ` : ""}${rows.length} lignes${constants.length ? ` ; valeur identique sur chaque ligne : ${constants.join(" ; ")}` : ""}`;
  if (cols.length === 0) return [title];
  return [title, cols.join("\t"), ...rows.map((r) => cols.map((c) => cell(r[c])).join("\t"))];
}

/** Tableau de tableaux de scalaires (Sheets values) → une ligne par rangée, cellules tabulées. */
function gridLines(name, grid) {
  return [`# ${name ? `${name} : ` : ""}${grid.length} lignes (grille)`, ...grid.map((row) => row.map(cell).join("\t"))];
}

const isObjectList = (v) => Array.isArray(v) && v.length >= 2 && v.every(isPlain);
const isGrid = (v) => Array.isArray(v) && v.length >= 2 && v.every((r) => Array.isArray(r) && r.every(isScalar));

/** Parcourt l'objet : scalaires → en-tête, listes d'objets et grilles → sections. */
function collect(obj, prefix, depth, header, sections) {
  for (const [k, v] of Object.entries(obj)) {
    if (!SAFE_KEY.test(k)) return false;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObjectList(v) || isGrid(v)) {
      const lines = isGrid(v) ? gridLines(key, v) : tableLines(key, v);
      if (lines) sections.push(lines);
      else header.push(`${key}=${json(v)}`);
    } else if (isPlain(v) && Object.keys(v).length > 0 && depth < FLATTEN_DEPTH) {
      if (!collect(v, key, depth + 1, header, sections)) return false;
    } else header.push(`${key}=${headerCell(v)}`);
  }
  return true;
}

/**
 * Rend une valeur JSON sous sa forme la plus courte sans perte : tableau(x) TSV
 * quand elle contient une liste d'objets ou une grille, JSON minifié sinon.
 * @param {unknown} value
 * @returns {{ text: string, mode: "table" | "minified" }}
 */
export function renderValue(value) {
  const minified = json(value);
  let lines = null;
  if (isObjectList(value)) lines = tableLines("", value);
  else if (isGrid(value)) lines = gridLines("", value);
  else if (isPlain(value)) {
    const header = [];
    const sections = [];
    if (collect(value, "", 0, header, sections) && sections.length) {
      lines = [...(header.length ? [header.join(" ; ")] : []), ...sections.flat()];
    }
  }
  const table = lines ? lines.join("\n") : null;
  // Garde-fou : jamais plus lourd que le JSON minifié.
  return table !== null && table.length < minified.length ? { text: table, mode: "table" } : { text: minified, mode: "minified" };
}

const PAGE_TOKENS = ["nextPageToken", "nextSyncToken"];

/**
 * Pages NDJSON (gws --page-all) → une seule valeur : listes concaténées, champs
 * identiques d'une page à l'autre dits une fois. Un champ dont la valeur change
 * selon la page (un total estimé, par exemple) n'est pas fusionné : ses valeurs
 * sont rendues à part, page par page, pour qu'aucune n'en remplace une autre.
 * @returns {{ value: Record<string, unknown>, perPage: string[] } | null}
 */
function mergePages(pages) {
  if (!pages.every(isPlain)) return null;
  const last = pages[pages.length - 1];
  /** @type {Record<string, unknown>} */
  const merged = {};
  const perPage = [];
  for (const k of new Set(pages.flatMap((p) => Object.keys(p)))) {
    const present = pages.filter((p) => k in p);
    // Le jeton de suite ne vaut que s'il vient de la dernière page.
    if (PAGE_TOKENS.includes(k)) { if (k in last) merged[k] = last[k]; continue; }
    if (present.every((p) => Array.isArray(p[k]))) { merged[k] = present.flatMap((p) => p[k]); continue; }
    const first = json(present[0][k]);
    if (present.every((p) => json(p[k]) === first)) { merged[k] = present[0][k]; continue; }
    perPage.push(`${k}=${pages.map((p) => (k in p ? pageCell(p[k]) : "(absent)")).join(" | ")}`);
  }
  return { value: merged, perPage };
}

/** Nombres du texte qui ne se réécrivent pas à l'identique (au-delà de 2^53, 1.10, 2.0, 1e3). */
function hasLossyNumber(text) {
  for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (m[0][0] !== '"' && String(Number(m[0])) !== m[0]) return true;
  }
  return false;
}

/**
 * JSON.parse qui garde chaque nombre tel qu'il est écrit quand sa relecture le
 * changerait. Rend undefined s'il faudrait le faire et que Node ne le permet pas.
 */
function parseLossless(text) {
  if (!HAS_RAW) {
    const value = JSON.parse(text);
    return hasLossyNumber(text) ? undefined : value;
  }
  let lossy = false;
  const value = JSON.parse(text, /** @type {any} */ ((_k, v, ctx) => {
    if (typeof v !== "number") return v;
    if (!ctx || typeof ctx.source !== "string") { lossy = true; return v; }
    return ctx.source === String(v) ? v : RAW_JSON.rawJSON?.(ctx.source);
  }));
  return lossy && hasLossyNumber(text) ? undefined : value;
}

/**
 * @typedef {{ raw: number, out: number, mode: "table" | "minified" | "text", pages?: number }} RenderStats
 */

/**
 * Texte d'un résultat d'outil → forme compacte. Inchangé si ce n'est pas du JSON
 * (ni du NDJSON), ou si un de ses nombres ne pouvait pas être gardé tel qu'écrit.
 * `table: false` limite à la minification (erreurs).
 * @param {string} text
 * @param {{ table?: boolean }} [opts]
 * @returns {{ text: string, stats: RenderStats }}
 */
export function renderJson(text, { table = true } = {}) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  /** @type {(t: string, mode: RenderStats["mode"], pages?: number) => { text: string, stats: RenderStats }} */
  const done = (t, mode, pages) => ({ text: t, stats: { raw: raw.length, out: t.length, mode, ...(pages ? { pages } : {}) } });
  if (!/^[[{]/.test(trimmed)) return done(raw, "text");
  let value;
  let pages = 0;
  let perPage = [];
  try { value = parseLossless(trimmed); } catch {
    const lines = trimmed.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return done(raw, "text");
    const parsed = [];
    for (const l of lines) {
      let page;
      try { page = parseLossless(l); } catch { return done(raw, "text"); }
      if (page === undefined) return done(raw, "text");
      parsed.push(page);
    }
    const merged = mergePages(parsed);
    if (!merged) return done(parsed.map((p) => json(p)).join("\n"), "minified");
    value = merged.value;
    perPage = merged.perPage;
    pages = parsed.length;
  }
  if (value === undefined) return done(raw, "text");
  const r = table ? renderValue(value) : { text: json(value), mode: /** @type {const} */ ("minified") };
  const note = `[${pages} pages fusionnées${perPage.length ? ` ; valeur propre à chaque page, dans l'ordre des pages : ${perPage.join(" ; ")}` : ""}]`;
  return done(pages ? `${note}\n${r.text}` : r.text, r.mode, pages);
}

// ── Sorties de scripts ──────────────────────────────────────────────────────

// Une barre de progression porte un pourcentage ET un corps de barre : un simple
// filet de séparation (━━━━) n'en est pas une.
const PROGRESS_RE = /\d{1,3}\s?%\s*\|.*\||\d{1,3}\s?%.*[█▉▊▋▌▍▎▏━#=]{4,}|[█▉▊▋▌▍▎▏━#=>]{4,}.*\d{1,3}\s?%/;
const WARNING_RE = /^(\S.*:\d+: )?\w*Warning: /;
const NUMPY_RE = /\bnp\.(?:float|int|uint)(?:8|16|32|64|128)\((-?(?:\d[\d.]*(?:e[+-]?\d+)?|inf|nan))\)/g;
const NUMPY_STR_RE = /\bnp\.str_\(('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\)/g;
const NUMPY_BOOL_RE = /\bnp\.(True|False)_\b/g;
const MIN_RUN = 3;

/**
 * Replie ce qu'un terminal n'aurait pas montré ou qu'un lecteur saute : états
 * intermédiaires d'une barre de progression, lignes identiques consécutives,
 * avertissements répétés à l'identique, enveloppes de type numpy. Chaque repli
 * laisse une mention à l'endroit où il a lieu (ou en tête pour les enveloppes).
 * @param {string} text
 * @returns {{ text: string, folded: boolean }}
 */
export function foldOutput(text) {
  const src = String(text ?? "");
  const notes = [];
  let refreshes = 0;
  // Retour chariot : seul le dernier état de la ligne reste affiché.
  let lines = src.replace(/\r\n/g, "\n").split("\n").map((l) => {
    if (!l.includes("\r")) return l;
    const parts = l.split("\r").filter((p) => p.length > 0);
    refreshes += Math.max(0, parts.length - 1);
    return parts.length ? parts[parts.length - 1] : "";
  });
  if (refreshes) notes.push(`${refreshes} rafraîchissements de ligne (retour chariot) réduits à leur dernier état`);

  let wrappers = 0;
  lines = lines.map((l) => (l.includes("np.")
    ? l.replace(NUMPY_RE, (_, v) => { wrappers++; return v; })
      .replace(NUMPY_STR_RE, (_, v) => { wrappers++; return v; })
      .replace(NUMPY_BOOL_RE, (_, v) => { wrappers++; return v; })
    : l));
  if (wrappers) notes.push(`${wrappers} enveloppes numpy np.float64(x) / np.int64(x) écrites x`);

  // Barres de progression sur des lignes successives : dernier état seulement.
  const afterBars = [];
  for (let i = 0; i < lines.length; i++) {
    if (!PROGRESS_RE.test(lines[i])) { afterBars.push(lines[i]); continue; }
    let j = i;
    while (j + 1 < lines.length && PROGRESS_RE.test(lines[j + 1])) j++;
    afterBars.push(lines[j]);
    if (j > i) afterBars.push(`…[${j - i} états précédents de la barre de progression repliés]`);
    i = j;
  }

  // Avertissements identiques (ligne + ligne de code indentée qui suit) : le premier seulement.
  const warnCount = new Map();
  const blocks = [];
  for (let i = 0; i < afterBars.length; i++) {
    const l = afterBars[i];
    if (!WARNING_RE.test(l)) { blocks.push({ text: l }); continue; }
    const follow = i + 1 < afterBars.length && /^\s+\S/.test(afterBars[i + 1]) ? `\n${afterBars[i + 1]}` : "";
    if (follow) i++;
    const key = l + follow;
    const n = warnCount.get(key) || 0;
    warnCount.set(key, n + 1);
    if (n === 0) blocks.push({ text: key, warn: key });
  }
  const afterWarn = [];
  for (const b of blocks) {
    afterWarn.push(...b.text.split("\n"));
    if (b.warn && warnCount.get(b.warn) > 1) afterWarn.push(`…[avertissement identique émis ${warnCount.get(b.warn)} fois, affiché une fois]`);
  }

  // Lignes identiques consécutives.
  const out = [];
  for (let i = 0; i < afterWarn.length; i++) {
    let j = i;
    while (j + 1 < afterWarn.length && afterWarn[j + 1] === afterWarn[i]) j++;
    const run = j - i + 1;
    if (run < MIN_RUN) { out.push(afterWarn[i]); continue; }
    out.push(afterWarn[i], `…[${afterWarn[i].trim() === "" ? "ligne vide" : "ligne identique"} répétée ${run} fois de suite]`);
    i = j;
  }

  const body = out.join("\n");
  const folded = body !== src.replace(/\r\n/g, "\n");
  return { text: notes.length ? `[${notes.join(" ; ")}]\n${body}` : body, folded };
}

/**
 * Plafonne un texte en gardant le début et la fin, coupés sur des fins de ligne
 * quand c'est possible. `hint` dit au modèle comment obtenir le milieu.
 * @param {string} text
 * @param {number} cap
 * @param {{ headRatio?: number, hint?: string }} [opts]
 * @returns {{ text: string, cut: number }}
 */
export function capMiddle(text, cap, { headRatio = 0.6, hint = "" } = {}) {
  const src = String(text ?? "");
  if (src.length <= cap) return { text: src, cut: 0 };
  let headEnd = Math.floor(cap * headRatio);
  let tailStart = src.length - (cap - headEnd);
  // Recule / avance jusqu'à une fin de ligne si elle est proche (20 % du segment au plus).
  const nlHead = src.lastIndexOf("\n", headEnd);
  if (nlHead > headEnd * 0.8) headEnd = nlHead + 1;
  const nlTail = src.indexOf("\n", tailStart);
  if (nlTail !== -1 && nlTail - tailStart < (src.length - tailStart) * 0.2) tailStart = nlTail + 1;
  const cut = tailStart - headEnd;
  const cutLines = src.slice(headEnd, tailStart).split("\n").length - 1;
  const head = src.slice(0, headEnd);
  const mark = `…[${cut} caractères${cutLines > 1 ? ` (${cutLines} lignes)` : ""} coupés ici, sur ${src.length}${hint ? ` — ${hint}` : ""}]…`;
  return { text: `${head}${head.endsWith("\n") ? "" : "\n"}${mark}\n${src.slice(tailStart)}`, cut };
}

// ── Lecture de fichier par plage ────────────────────────────────────────────

/**
 * @typedef {{ startLine?: number, startChar?: number, maxLines?: number, maxChars: number }} SliceRequest
 * @typedef {{ text: string, from: number, to: number, firstLine: number, lastLine: number, totalLines: number, totalChars: number, complete: boolean, next: { start_line?: number, start_char?: number } | null }} Slice
 */

/**
 * Extrait une plage d'un texte. Départ par ligne (1 = première) ou par
 * caractère (0 = premier) ; la coupe se fait en fin de ligne, sauf si une
 * seule ligne dépasse déjà le plafond (JSON minifié…), auquel cas elle se fait
 * au caractère et la suite se demande par start_char.
 * @param {string} text
 * @param {SliceRequest} req
 * @returns {Slice}
 */
export function sliceText(text, { startLine, startChar, maxLines, maxChars }) {
  const src = String(text ?? "");
  const totalChars = src.length;
  const starts = [0];
  for (let i = src.indexOf("\n"); i !== -1 && i + 1 < totalChars; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
  const totalLines = totalChars === 0 ? 0 : starts.length;
  const lineOf = (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };

  let from = 0;
  if (startChar !== undefined && startChar > 0) from = Math.min(startChar, totalChars);
  else if (startLine !== undefined && startLine > 1) from = startLine > totalLines ? totalChars : starts[startLine - 1];

  let to = Math.min(totalChars, from + maxChars);
  const firstLine = from >= totalChars ? totalLines : lineOf(from);
  if (maxLines !== undefined) {
    const endLine = firstLine + maxLines; // première ligne exclue
    if (endLine <= totalLines) to = Math.min(to, starts[endLine - 1]);
  }
  if (to < totalChars && src[to - 1] !== "\n") {
    const nl = src.lastIndexOf("\n", to - 1);
    if (nl >= from) to = nl + 1; // sinon : ligne plus longue que le plafond, coupe au caractère
  }
  const complete = from === 0 && to === totalChars;
  const lastLine = to > from ? lineOf(to - 1) : firstLine;
  /** @type {Slice["next"]} */
  let next = null;
  if (to < totalChars) next = src[to - 1] === "\n" ? { start_line: lineOf(to) } : { start_char: to };
  return { text: src.slice(from, to), from, to, firstLine, lastLine, totalLines, totalChars, complete, next };
}

/** Mention de plage partielle : où l'on est, combien il reste, comment lire la suite. */
export function sliceNote(/** @type {Slice} */ s) {
  if (s.complete) return "";
  if (s.to <= s.from) return `[rien à lire à partir de là : le fichier fait ${s.totalLines} lignes, ${s.totalChars} caractères]`;
  const where = `lignes ${s.firstLine}–${s.lastLine} sur ${s.totalLines}, caractères ${s.from}–${s.to} sur ${s.totalChars}`;
  if (!s.next) return `[${where} ; fin du fichier]`;
  const how = s.next.start_line !== undefined ? `start_line=${s.next.start_line}` : `start_char=${s.next.start_char}`;
  return `[${where} — suite : ${how}]`;
}

/**
 * Mémoire, pour la durée du processus, des plages déjà renvoyées au modèle.
 * `signature` (taille + date de modification) invalide tout dès que le fichier change.
 */
export function createReadLedger() {
  /** @type {Map<string, { signature: string, ranges: { from: number, to: number }[] }>} */
  const files = new Map();
  return {
    /** Plage déjà servie pour ce fichier inchangé ? */
    covers(/** @type {string} */ key, /** @type {string} */ signature, /** @type {number} */ from, /** @type {number} */ to) {
      const f = files.get(key);
      return !!f && f.signature === signature && to > from && f.ranges.some((r) => r.from <= from && to <= r.to);
    },
    record(/** @type {string} */ key, /** @type {string} */ signature, /** @type {number} */ from, /** @type {number} */ to) {
      const f = files.get(key);
      if (!f || f.signature !== signature) { files.set(key, { signature, ranges: [{ from, to }] }); return; }
      // Plages contiguës ou recouvrantes fusionnées : deux lectures à la suite valent une lecture entière.
      const merged = { from, to };
      f.ranges = f.ranges.filter((r) => {
        if (r.to < merged.from || merged.to < r.from) return true;
        merged.from = Math.min(merged.from, r.from);
        merged.to = Math.max(merged.to, r.to);
        return false;
      });
      f.ranges.push(merged);
    },
  };
}

// ── Inventaire de fichiers ──────────────────────────────────────────────────

export function fmtBytes(/** @type {number} */ n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

/**
 * Fichiers groupés par dossier : le chemin du dossier n'est écrit qu'une fois.
 * @param {{ path: string, bytes: number }[]} files chemins relatifs à `root`
 * @param {{ root?: string, truncatedAt?: number }} [opts]
 */
export function renderFileList(files, { root = "/work", truncatedAt = 0 } = {}) {
  /** @type {Map<string, string[]>} */
  const dirs = new Map();
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const dir = i === -1 ? "" : f.path.slice(0, i);
    const name = i === -1 ? f.path : f.path.slice(i + 1);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)?.push(`${name} (${fmtBytes(f.bytes)})`);
  }
  const lines = [...dirs].map(([dir, names]) => `${root}${dir ? `/${dir}` : ""}/ : ${names.join(", ")}`);
  if (truncatedAt && files.length >= truncatedAt) lines.push(`…[liste arrêtée aux ${truncatedAt} premiers fichiers — pour le reste, run_python avec os.walk('${root}')]`);
  return lines.join("\n");
}

/**
 * Skills montées, sur une ligne. `*` = la skill a un dossier assets/.
 * @param {{ name: string, assets: boolean }[]} skills
 */
export function renderSkillList(skills) {
  const withAssets = skills.some((s) => s.assets);
  return `--- ${skills.length} skills HQ, lecture seule : /skills/<nom>/SKILL.md${withAssets ? " ; * = a aussi un dossier assets/" : ""} ---\n${skills.map((s) => s.name + (s.assets ? "*" : "")).join(", ")}`;
}
