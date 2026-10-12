/**
 * SQL builder for the dataset tools of the "client-data" MCP server.
 *
 * A dataset is a table of JSON rows (client_data.dataset_rows.data) whose
 * columns are declared in client_data.datasets.columns ([{name, type}]). The
 * model asks in terms of column NAMES, filters, groupings and aggregates; this
 * module turns that into ONE parameterised SELECT. Nothing written by the model
 * ever reaches the SQL text: column names are matched against the declared
 * list (the SQL quotes the declared spelling), operators and functions come
 * from closed lists, values travel as parameters.
 *
 * Pure: no database access, so it is unit-tested directly.
 */

export const MAX_LIMIT = 200;
export const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null"];
export const AGGREGATES = ["count", "count_distinct", "sum", "avg", "min", "max"];
const IDENT_RE = /^[a-z0-9_]{1,64}$/;

/** Column type from the dataset's declaration (inferred at load time). */
export function columnType(columns, name) {
  const c = columns.find((x) => x.name === name);
  return c ? c.type : null;
}

function quoteIdent(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/**
 * Expression reading a column with the right cast. Text stays text; numbers
 * and dates are cast only when the stored text matches (a stray word in a
 * numeric column yields NULL instead of an SQL error).
 */
export function columnExpr(column) {
  const raw = `(r.data->>'${column.name.replace(/'/g, "''")}')`;
  switch (column.type) {
    case "number":
      return `(CASE WHEN ${raw} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${raw}::numeric END)`;
    case "date":
      return `(CASE WHEN ${raw} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN substr(${raw}, 1, 10)::date END)`;
    default:
      return raw;
  }
}

function resolveColumn(columns, name, what) {
  if (typeof name !== "string" || !name.trim()) throw new Error(`${what} : nom de colonne manquant`);
  const exact = columns.find((c) => c.name === name);
  if (exact) return exact;
  const loose = columns.filter((c) => c.name.toLowerCase().trim() === name.toLowerCase().trim());
  if (loose.length === 1) return loose[0];
  throw new Error(`${what} : colonne inconnue « ${name} ». Colonnes disponibles : ${columns.map((c) => c.name).join(", ")}`);
}

/** A caller-facing alias for an aggregate ("sum_montant"), safe as an SQL identifier. */
export function aggregateAlias(agg) {
  const base = agg.column ? `${agg.fn}_${agg.column}` : agg.fn;
  const slug = base.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return IDENT_RE.test(slug) ? slug : `agg_${Math.abs(hash(base))}`;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Builds the query.
 * @param {object} dataset  { client_key, dataset_key, current_load_id, columns:[{name,type}] }
 * @param {object} args     { select?, where?, group_by?, aggregates?, order_by?, limit?, offset? }
 * @returns {{ text: string, values: unknown[], columns: string[], limit: number, aggregated: boolean }}
 */
export function buildDatasetQuery(dataset, args = {}) {
  const columns = Array.isArray(dataset.columns) ? dataset.columns.filter((c) => c && typeof c.name === "string") : [];
  if (!columns.length) throw new Error("Ce jeu de données n'a aucune colonne déclarée.");
  if (!dataset.current_load_id) throw new Error("Ce jeu de données n'a pas encore de chargement terminé.");

  const values = [dataset.client_key, dataset.dataset_key, dataset.current_load_id];
  const param = (v) => { values.push(v); return `$${values.length}`; };

  // WHERE
  const where = [`r.client_key = $1`, `r.dataset_key = $2`, `r.load_id = $3`];
  const filters = Array.isArray(args.where) ? args.where : [];
  if (filters.length > 20) throw new Error("20 filtres au plus.");
  for (const f of filters) {
    if (!f || typeof f !== "object") throw new Error("Filtre invalide.");
    const col = resolveColumn(columns, f.column, "where");
    const op = typeof f.op === "string" ? f.op : "eq";
    if (!OPERATORS.includes(op)) throw new Error(`Opérateur inconnu « ${op} » (${OPERATORS.join(", ")}).`);
    const expr = columnExpr(col);
    const textExpr = `(r.data->>'${col.name.replace(/'/g, "''")}')`;
    switch (op) {
      case "is_null": where.push(`(${textExpr} IS NULL OR ${textExpr} = '')`); break;
      case "not_null": where.push(`(${textExpr} IS NOT NULL AND ${textExpr} <> '')`); break;
      case "contains":
        where.push(`${textExpr} ILIKE ${param(`%${String(f.value ?? "").replace(/[%_\\]/g, (m) => `\\${m}`)}%`)}`);
        break;
      case "in": {
        const list = Array.isArray(f.value) ? f.value : [f.value];
        if (!list.length || list.length > 100) throw new Error("in : 1 à 100 valeurs.");
        if (col.type === "text") where.push(`${textExpr} = ANY(${param(list.map((v) => String(v)))}::text[])`);
        else where.push(`${expr} = ANY(${param(list.map((v) => castValue(col, v)))}::${sqlArrayType(col)})`);
        break;
      }
      default: {
        const sqlOp = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
        if (col.type === "text") where.push(`${textExpr} ${sqlOp} ${param(String(f.value ?? ""))}`);
        else where.push(`${expr} ${sqlOp} ${param(castValue(col, f.value))}::${sqlType(col)}`);
      }
    }
  }

  // SELECT / GROUP BY
  const groupBy = Array.isArray(args.group_by) ? args.group_by : [];
  const aggregates = Array.isArray(args.aggregates) ? args.aggregates : [];
  if (groupBy.length > 6) throw new Error("6 colonnes de regroupement au plus.");
  if (aggregates.length > 10) throw new Error("10 agrégats au plus.");
  const aggregated = groupBy.length > 0 || aggregates.length > 0;

  const selectParts = [];
  const outColumns = [];
  if (aggregated) {
    for (const g of groupBy) {
      const col = resolveColumn(columns, g, "group_by");
      selectParts.push(`${columnExpr(col)} AS ${quoteIdent(col.name)}`);
      outColumns.push(col.name);
    }
    const aggs = aggregates.length ? aggregates : [{ fn: "count" }];
    const seen = new Set();
    for (const a of aggs) {
      if (!a || typeof a !== "object" || !AGGREGATES.includes(a.fn)) throw new Error(`Agrégat invalide (${AGGREGATES.join(", ")}).`);
      let sql;
      if (a.fn === "count" && !a.column) sql = "count(*)::int";
      else {
        const col = resolveColumn(columns, a.column, `aggregates.${a.fn}`);
        if (["sum", "avg"].includes(a.fn) && col.type !== "number") {
          throw new Error(`${a.fn} : la colonne « ${col.name} » n'est pas numérique.`);
        }
        const e = columnExpr(col);
        sql = a.fn === "count" ? `count(${e})::int`
          : a.fn === "count_distinct" ? `count(DISTINCT ${e})::int`
          : a.fn === "avg" ? `round(avg(${e})::numeric, 2)`
          : a.fn === "sum" ? `round(sum(${e})::numeric, 2)`
          : `${a.fn}(${e})`;
      }
      const alias = aggregateAlias(a);
      if (seen.has(alias)) throw new Error(`Agrégat en double : ${alias}.`);
      seen.add(alias);
      selectParts.push(`${sql} AS ${quoteIdent(alias)}`);
      outColumns.push(alias);
    }
  } else {
    const select = Array.isArray(args.select) && args.select.length ? args.select : columns.map((c) => c.name);
    if (select.length > 40) throw new Error("40 colonnes au plus.");
    for (const s of select) {
      const col = resolveColumn(columns, s, "select");
      if (outColumns.includes(col.name)) continue;
      selectParts.push(`${columnExpr(col)} AS ${quoteIdent(col.name)}`);
      outColumns.push(col.name);
    }
  }

  // ORDER BY: by an output column (group key, aggregate alias or selected column)
  const orderBy = Array.isArray(args.order_by) ? args.order_by : [];
  if (orderBy.length > 4) throw new Error("4 tris au plus.");
  const orderParts = [];
  for (const o of orderBy) {
    const by = typeof o === "string" ? o : o?.by;
    const dir = (typeof o === "object" && o?.dir === "asc") ? "ASC" : "DESC";
    if (typeof by !== "string") throw new Error("order_by : « by » manquant.");
    const match = outColumns.find((c) => c === by) ?? outColumns.find((c) => c.toLowerCase() === by.toLowerCase());
    if (!match) throw new Error(`order_by : « ${by} » n'est pas une colonne du résultat (${outColumns.join(", ")}).`);
    orderParts.push(`${quoteIdent(match)} ${dir} NULLS LAST`);
  }
  if (!orderParts.length) orderParts.push(aggregated ? `1 ${aggregated && aggregates.length ? "DESC" : "ASC"} NULLS LAST` : "r.row_no ASC");
  if (aggregated && !orderBy.length && aggregates.length) {
    // Default for aggregated results: biggest first aggregate first.
    orderParts[0] = `${quoteIdent(outColumns[groupBy.length])} DESC NULLS LAST`;
  }

  const limit = Math.min(Math.max(1, Number(args.limit) || (aggregated ? 50 : 20)), MAX_LIMIT);
  const offset = Math.max(0, Number(args.offset) || 0);

  const groupSql = groupBy.length ? ` GROUP BY ${groupBy.map((_, i) => i + 1).join(", ")}` : "";
  const text =
    `SELECT ${selectParts.join(", ")} FROM client_data.dataset_rows r WHERE ${where.join(" AND ")}` +
    `${groupSql} ORDER BY ${orderParts.join(", ")} LIMIT ${limit + 1} OFFSET ${offset}`;
  return { text, values, columns: outColumns, limit, offset, aggregated };
}

function sqlType(col) {
  return col.type === "number" ? "numeric" : col.type === "date" ? "date" : "text";
}
function sqlArrayType(col) {
  return `${sqlType(col)}[]`;
}
function castValue(col, v) {
  if (col.type === "number") {
    const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n)) throw new Error(`Valeur numérique attendue pour « ${col.name} ».`);
    return String(n);
  }
  if (col.type === "date") {
    const s = String(v ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error(`Date YYYY-MM-DD attendue pour « ${col.name} ».`);
    return s.slice(0, 10);
  }
  return String(v ?? "");
}
