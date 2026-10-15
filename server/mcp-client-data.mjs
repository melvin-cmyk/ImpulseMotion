#!/usr/bin/env node
/**
 * MCP stdio "client-data" — données e-commerce de l'entrepôt client_data.
 *
 * Lancé par le relay (server/relay.mjs) avec, en env :
 *   CLIENT_KEY        — client_key imposé côté serveur (bot client : le LLM ne le choisit jamais)
 *   CLIENT_KEYS       — liste fermée de clés (staff : la console lit plusieurs clients) ;
 *                       avec plus d'une clé, chaque outil prend un paramètre `client`
 *                       restreint à cette liste
 *   DATA_DATABASE_URL — URL Postgres LECTURE SEULE (rôle im_reader)
 * Refuse de démarrer sans clé ou sans URL.
 *
 * Toutes les requêtes sont paramétrées et filtrent client_key sur une clé de la liste.
 * Statut "canceled" exclu par défaut (param include_canceled). Montants EUR TTC
 * (grand_total), arrondis à 2 décimales, 200 lignes max par réponse.
 * Les dates sont interprétées en Europe/Paris (bornes incluses).
 *
 * Les réponses qui portent une liste (rows, by_type, top_codes) partent en
 * tableau : les clés ne sont écrites qu'une fois, en en-tête de colonnes, au
 * lieu d'être répétées sur chaque ligne. Mêmes valeurs, aucune ligne retirée.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { renderValue } from "./mcp-compact-generic.mjs";
import { buildDatasetQuery, OPERATORS, AGGREGATES, MAX_LIMIT as DATASET_MAX_LIMIT } from "./dataset-query.mjs";

const KEY_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const CLIENT_KEYS = [...new Set(
  String(process.env.CLIENT_KEYS || process.env.CLIENT_KEY || "").split(",").map((s) => s.trim()).filter(Boolean),
)];
// One key: tools stay as the bots know them (no `client` parameter). Several:
// every tool names the client, restricted to the list pinned by the relay.
const MULTI = CLIENT_KEYS.length > 1;
// Which tool families to expose: "orders" (e-commerce warehouse) and/or
// "datasets" (files dropped in the client's Drive folder). The relay derives
// it from the bot's ticked sources; absent → both (older relay).
const TOOL_FAMILIES = new Set(
  (process.env.CLIENT_DATA_TOOLS || "orders,datasets").split(",").map((s) => s.trim()).filter((s) => s === "orders" || s === "datasets"),
);
if (!TOOL_FAMILIES.size) TOOL_FAMILIES.add("orders");
const DATA_DATABASE_URL = process.env.DATA_DATABASE_URL || "";
if (!CLIENT_KEYS.length || CLIENT_KEYS.some((k) => !KEY_RE.test(k))) {
  console.error("[mcp-client-data] CLIENT_KEY(S) manquante ou invalide — refus de démarrer");
  process.exit(1);
}
if (!DATA_DATABASE_URL) {
  console.error("[mcp-client-data] DATA_DATABASE_URL manquante — refus de démarrer");
  process.exit(1);
}

const TZ = "Europe/Paris";
const MAX_ROWS = 200;

// ── DB ──────────────────────────────────────────────────────────────────────
function poolConfig(connectionString) {
  const u = new URL(connectionString);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  u.searchParams.delete("sslmode");
  u.searchParams.delete("channel_binding");
  return {
    connectionString: u.toString(),
    ssl: local ? undefined : { rejectUnauthorized: true },
    max: 2,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 25_000,
  };
}
const pool = new pg.Pool(poolConfig(DATA_DATABASE_URL));
pool.on("error", (e) => console.error("[mcp-client-data] pool:", e.message));

async function q(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const r2 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const int = (v) => (v === null || v === undefined ? 0 : Number(v));

function todayParis() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function shiftDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Période [from, to] inclusive → bornes SQL. Défaut : 7 derniers jours (jusqu'à hier inclus). */
function period(args) {
  const today = todayParis();
  const to = args?.to || shiftDays(today, -1);
  const from = args?.from || shiftDays(to, -6);
  if (from > to) throw new Error(`Période invalide : from (${from}) > to (${to})`);
  return { from, to, toExclusive: shiftDays(to, 1) };
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "format YYYY-MM-DD");
const periodShape = {
  from: dateStr.optional().describe("Début de période (YYYY-MM-DD, inclus, Europe/Paris). Défaut : 7 derniers jours."),
  to: dateStr.optional().describe("Fin de période (YYYY-MM-DD, incluse). Défaut : hier."),
  include_canceled: z.boolean().optional().describe("Inclure les commandes annulées (statut canceled). Défaut : false."),
};

// Filtre commun : client, période (Europe/Paris), statut. $1=client_key $2=from $3=to_exclusive $4=include_canceled
const WHERE = `o.client_key = $1
  AND (o.created_at AT TIME ZONE '${TZ}')::date >= $2::date
  AND (o.created_at AT TIME ZONE '${TZ}')::date < $3::date
  AND ($4::boolean OR coalesce(o.status, '') <> 'canceled')`;

/** Clé du client visé par l'appel : la seule clé en mode bot, le paramètre `client` sinon. */
function clientOf(args) {
  if (!MULTI) return CLIENT_KEYS[0];
  const c = typeof args?.client === "string" ? args.client.trim() : "";
  if (!CLIENT_KEYS.includes(c)) throw new Error(`client : indique l'un de ${CLIENT_KEYS.join(", ")}.`);
  return c;
}
const clientShape = MULTI
  ? { client: z.enum(CLIENT_KEYS).describe(`Clé du client dont lire les données (${CLIENT_KEYS.join(", ")}).`) }
  : {};

function baseParams(p, args) {
  return [clientOf(args), p.from, p.toExclusive, Boolean(args?.include_canceled)];
}

function ok(payload) {
  return { content: [{ type: "text", text: renderValue(payload).text }] };
}
function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[mcp-client-data]", message);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}
const guarded = (fn) => async (args) => {
  try { return ok(await fn(args || {})); } catch (e) { return fail(e); }
};

// ── Server ──────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "client-data", version: "1.0.0" });

if (TOOL_FAMILIES.has("orders")) {
server.registerTool(
  "data_coverage",
  {
    title: "Couverture des données e-commerce",
    description:
      "Période couverte par les commandes e-commerce du client (première et dernière commande), nombre total de commandes, " +
      "répartition par statut et date du dernier chargement. À appeler en premier pour connaître la profondeur d'historique disponible. " +
      "Devise EUR, montants TTC (grand_total)." + (MULTI ? " Sans `client`, rend la couverture de chaque client disponible." : " Aucun paramètre."),
    inputSchema: MULTI ? { client: clientShape.client.optional() } : {},
  },
  guarded(async (args) => {
    if (MULTI && !(typeof args.client === "string" && args.client.trim())) {
      const clients = [];
      for (const key of CLIENT_KEYS) clients.push({ client: key, ...(await coverageOf(key)) });
      return { clients, currency: "EUR", timezone: TZ, note: "Montants TTC (grand_total). Les commandes annulées sont exclues des chiffres par défaut." };
    }
    return coverageOf(clientOf(args));
  }),
);

async function coverageOf(clientKey) {
  {
    const [agg] = await q(
      `SELECT count(*)::int AS orders, min(created_at) AS first_at, max(created_at) AS last_at, max(ingested_at) AS last_ingested,
              sum(grand_total) FILTER (WHERE coalesce(status,'') <> 'canceled') AS revenue
       FROM client_data.orders WHERE client_key = $1`,
      [clientKey],
    );
    const statuses = await q(
      `SELECT coalesce(status, '(inconnu)') AS status, count(*)::int AS n FROM client_data.orders
       WHERE client_key = $1 GROUP BY 1 ORDER BY n DESC LIMIT ${MAX_ROWS}`,
      [clientKey],
    );
    return {
      orders: int(agg?.orders),
      first_order_at: agg?.first_at ? new Date(agg.first_at).toISOString() : null,
      last_order_at: agg?.last_at ? new Date(agg.last_at).toISOString() : null,
      last_ingested_at: agg?.last_ingested ? new Date(agg.last_ingested).toISOString() : null,
      revenue_total_excl_canceled: r2(agg?.revenue),
      statuses: Object.fromEntries(statuses.map((s) => [s.status, int(s.n)])),
      currency: "EUR",
      timezone: TZ,
      note: "Montants TTC (grand_total). Les commandes annulées sont exclues des chiffres par défaut.",
    };
  }
}

server.registerTool(
  "data_sales_summary",
  {
    title: "Synthèse des ventes par période",
    description:
      "Ventes e-commerce agrégées par jour, semaine, mois ou en total sur la période : nombre de commandes, chiffre d'affaires " +
      "(somme de grand_total, EUR TTC), panier moyen (aov), articles vendus, nouveaux clients (première commande dans la période), " +
      "commandes invités. Source de référence pour le CA réel. Commandes annulées exclues par défaut.",
    inputSchema: {
      ...clientShape,
      ...periodShape,
      granularity: z.enum(["day", "week", "month", "total"]).optional().describe("Granularité (défaut : total)."),
    },
  },
  guarded(async (args) => {
    const p = period(args);
    const g = args.granularity || "total";
    const bucket = g === "total"
      ? `'total'`
      : `to_char(date_trunc('${g}', o.created_at AT TIME ZONE '${TZ}'), '${g === "month" ? "YYYY-MM" : "YYYY-MM-DD"}')`;
    const rows = await q(
      `WITH first_orders AS (
         SELECT customer_key, min((created_at AT TIME ZONE '${TZ}')::date) AS first_day
         FROM client_data.orders
         WHERE client_key = $1 AND customer_key IS NOT NULL AND coalesce(customer_is_guest, false) = false
           AND ($4::boolean OR coalesce(status, '') <> 'canceled')
         GROUP BY customer_key
       )
       SELECT ${bucket} AS period,
              count(*)::int AS orders,
              sum(o.grand_total) AS revenue,
              avg(o.grand_total) AS aov,
              sum(o.total_qty) AS items,
              count(DISTINCT o.customer_key) FILTER (
                WHERE coalesce(o.customer_is_guest, false) = false
                  AND f.first_day = (o.created_at AT TIME ZONE '${TZ}')::date
              )::int AS new_customers,
              count(*) FILTER (WHERE coalesce(o.customer_is_guest, false) OR o.customer_key IS NULL)::int AS guest_orders
       FROM client_data.orders o
       LEFT JOIN first_orders f ON f.customer_key = o.customer_key
       WHERE ${WHERE}
       GROUP BY 1 ORDER BY 1 LIMIT ${MAX_ROWS}`,
      baseParams(p, args),
    );
    return {
      period: { from: p.from, to: p.to }, granularity: g, currency: "EUR",
      rows: rows.map((r) => ({
        period: r.period, orders: int(r.orders), revenue: r2(r.revenue), aov: r2(r.aov),
        items: r2(r.items), new_customers: int(r.new_customers), guest_orders: int(r.guest_orders),
      })),
    };
  }),
);

server.registerTool(
  "data_top_products",
  {
    title: "Top produits",
    description:
      "Produits les plus vendus sur la période (par chiffre d'affaires TTC des lignes ou par quantité) : sku, nom, quantité, " +
      "CA (EUR TTC), nombre de commandes. Commandes annulées exclues par défaut.",
    inputSchema: {
      ...clientShape,
      ...periodShape,
      limit: z.number().int().min(1).max(50).optional().describe("Nombre de produits (max 50, défaut 20)."),
      by: z.enum(["revenue", "qty"]).optional().describe("Tri : revenue (défaut) ou qty."),
    },
  },
  guarded(async (args) => {
    const p = period(args);
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
    const order = args.by === "qty" ? "qty DESC, revenue DESC" : "revenue DESC, qty DESC";
    const rows = await q(
      `SELECT coalesce(i.sku, '(sans sku)') AS sku, max(i.product_name) AS product_name,
              sum(i.qty) AS qty, sum(i.row_total) AS revenue, count(DISTINCT i.order_id)::int AS orders
       FROM client_data.order_items i
       JOIN client_data.orders o ON o.client_key = i.client_key AND o.order_id = i.order_id
       WHERE ${WHERE}
       GROUP BY 1 ORDER BY ${order} LIMIT $5`,
      [...baseParams(p, args), limit],
    );
    return {
      period: { from: p.from, to: p.to }, by: args.by || "revenue", currency: "EUR",
      rows: rows.map((r) => ({ sku: r.sku, product_name: r.product_name, qty: r2(r.qty), revenue: r2(r.revenue), orders: int(r.orders) })),
    };
  }),
);

server.registerTool(
  "data_prescriber_split",
  {
    title: "Répartition par prescripteur",
    description:
      "Répartition des commandes par type de prescripteur (commandes, CA EUR TTC, part en %) sur la période, plus le top 20 " +
      "des codes prescripteurs par CA. Commandes annulées exclues par défaut.",
    inputSchema: { ...clientShape, ...periodShape },
  },
  guarded(async (args) => {
    const p = period(args);
    const params = baseParams(p, args);
    const byType = await q(
      `SELECT coalesce(o.prescriber_type, '(aucun)') AS prescriber_type, count(*)::int AS orders, sum(o.grand_total) AS revenue
       FROM client_data.orders o WHERE ${WHERE} GROUP BY 1 ORDER BY revenue DESC NULLS LAST LIMIT ${MAX_ROWS}`,
      params,
    );
    const topCodes = await q(
      `SELECT o.prescriber_code, max(o.prescriber_type) AS prescriber_type, count(*)::int AS orders, sum(o.grand_total) AS revenue
       FROM client_data.orders o WHERE ${WHERE} AND o.prescriber_code IS NOT NULL
       GROUP BY 1 ORDER BY revenue DESC NULLS LAST LIMIT 20`,
      params,
    );
    const totalRevenue = byType.reduce((s, r) => s + Number(r.revenue || 0), 0);
    const totalOrders = byType.reduce((s, r) => s + int(r.orders), 0);
    return {
      period: { from: p.from, to: p.to }, currency: "EUR",
      total: { orders: totalOrders, revenue: r2(totalRevenue) },
      by_type: byType.map((r) => ({
        prescriber_type: r.prescriber_type, orders: int(r.orders), revenue: r2(r.revenue),
        revenue_share_pct: totalRevenue ? r2((Number(r.revenue || 0) / totalRevenue) * 100) : null,
        orders_share_pct: totalOrders ? r2((int(r.orders) / totalOrders) * 100) : null,
      })),
      top_codes: topCodes.map((r) => ({ prescriber_code: r.prescriber_code, prescriber_type: r.prescriber_type, orders: int(r.orders), revenue: r2(r.revenue) })),
    };
  }),
);

server.registerTool(
  "data_customers_new_vs_returning",
  {
    title: "Nouveaux clients vs récurrents",
    description:
      "Sur la période : commandes et CA (EUR TTC) des nouveaux clients (première commande dans la période, calculée sur tout " +
      "l'historique), des clients récurrents (déjà commandé avant) et des invités (sans compte). Commandes annulées exclues par défaut.",
    inputSchema: { ...clientShape, ...periodShape },
  },
  guarded(async (args) => {
    const p = period(args);
    const rows = await q(
      `WITH first_orders AS (
         SELECT customer_key, min((created_at AT TIME ZONE '${TZ}')::date) AS first_day
         FROM client_data.orders
         WHERE client_key = $1 AND customer_key IS NOT NULL AND coalesce(customer_is_guest, false) = false
           AND ($4::boolean OR coalesce(status, '') <> 'canceled')
         GROUP BY customer_key
       )
       SELECT CASE
                WHEN coalesce(o.customer_is_guest, false) OR o.customer_key IS NULL THEN 'guest'
                WHEN f.first_day >= $2::date THEN 'new'
                ELSE 'returning' END AS segment,
              count(*)::int AS orders,
              count(DISTINCT o.customer_key)::int AS customers,
              sum(o.grand_total) AS revenue,
              avg(o.grand_total) AS aov
       FROM client_data.orders o
       LEFT JOIN first_orders f ON f.customer_key = o.customer_key
       WHERE ${WHERE}
       GROUP BY 1 ORDER BY 1`,
      baseParams(p, args),
    );
    const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue || 0), 0);
    const out = { new: null, returning: null, guest: null };
    for (const r of rows) {
      out[r.segment] = {
        orders: int(r.orders), customers: r.segment === "guest" ? null : int(r.customers),
        revenue: r2(r.revenue), aov: r2(r.aov),
        revenue_share_pct: totalRevenue ? r2((Number(r.revenue || 0) / totalRevenue) * 100) : null,
      };
    }
    return { period: { from: p.from, to: p.to }, currency: "EUR", segments: out, total_revenue: r2(totalRevenue) };
  }),
);

server.registerTool(
  "data_orders_by_status",
  {
    title: "Commandes par statut",
    description:
      "Nombre de commandes et CA (EUR TTC) par statut Magento (complete, processing, canceled, pending…) sur la période. " +
      "Cet outil inclut toujours les commandes annulées, pour mesurer le taux d'annulation.",
    inputSchema: { ...clientShape, from: periodShape.from, to: periodShape.to },
  },
  guarded(async (args) => {
    const p = period(args);
    const rows = await q(
      `SELECT coalesce(o.status, '(inconnu)') AS status, count(*)::int AS orders, sum(o.grand_total) AS revenue
       FROM client_data.orders o WHERE ${WHERE} GROUP BY 1 ORDER BY orders DESC LIMIT ${MAX_ROWS}`,
      [clientOf(args), p.from, p.toExclusive, true],
    );
    const total = rows.reduce((s, r) => s + int(r.orders), 0);
    return {
      period: { from: p.from, to: p.to }, currency: "EUR", total_orders: total,
      rows: rows.map((r) => ({ status: r.status, orders: int(r.orders), revenue: r2(r.revenue), share_pct: total ? r2((int(r.orders) / total) * 100) : null })),
    };
  }),
);

const DIMENSIONS = {
  payment_method: "o.payment_method",
  shipping_method: "o.shipping_method",
  coupon_code: "o.coupon_code",
  billing_country: "o.billing_country",
  customer_group: "o.customer_group",
};

server.registerTool(
  "data_breakdown",
  {
    title: "Ventilation des commandes",
    description:
      "Ventilation des commandes et du CA (EUR TTC) sur la période selon une dimension : payment_method (moyen de paiement), " +
      "shipping_method (livraison), coupon_code (codes promo utilisés), billing_country (pays de facturation), customer_group " +
      "(groupe client). Commandes annulées exclues par défaut. 200 lignes max, triées par CA.",
    inputSchema: {
      ...clientShape,
      ...periodShape,
      dimension: z.enum(["payment_method", "shipping_method", "coupon_code", "billing_country", "customer_group"]).describe("Dimension de ventilation."),
    },
  },
  guarded(async (args) => {
    const p = period(args);
    const colExpr = DIMENSIONS[args.dimension];
    if (!colExpr) throw new Error("dimension inconnue");
    const rows = await q(
      `SELECT coalesce(${colExpr}, '(aucun)') AS value, count(*)::int AS orders, sum(o.grand_total) AS revenue, avg(o.grand_total) AS aov
       FROM client_data.orders o WHERE ${WHERE} GROUP BY 1 ORDER BY revenue DESC NULLS LAST LIMIT ${MAX_ROWS}`,
      baseParams(p, args),
    );
    const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue || 0), 0);
    const totalOrders = rows.reduce((s, r) => s + int(r.orders), 0);
    return {
      period: { from: p.from, to: p.to }, dimension: args.dimension, currency: "EUR",
      total: { orders: totalOrders, revenue: r2(totalRevenue) },
      rows: rows.map((r) => ({
        value: r.value, orders: int(r.orders), revenue: r2(r.revenue), aov: r2(r.aov),
        revenue_share_pct: totalRevenue ? r2((Number(r.revenue || 0) / totalRevenue) * 100) : null,
      })),
    };
  }),
);
}

// ── Datasets (fichiers déposés dans le dossier Drive du client) ─────────────
if (TOOL_FAMILIES.has("datasets")) {
  async function loadDataset(clientKey, key) {
    if (typeof key !== "string" || !key.trim()) throw new Error("dataset : clé manquante (voir data_datasets).");
    const k = key.trim().toLowerCase();
    const rows = await q(
      `SELECT client_key, dataset_key, name, description, columns, row_count, current_load_id, loaded_at, source
       FROM client_data.datasets WHERE client_key = $1 AND (dataset_key = $2 OR lower(name) = $2) LIMIT 1`,
      [clientKey, k],
    );
    if (!rows.length) throw new Error(`Jeu de données inconnu : « ${key} ». Appelle data_datasets pour la liste.`);
    return rows[0];
  }

  server.registerTool(
    "data_datasets",
    {
      title: "Jeux de données déposés",
      description:
        "Liste des fichiers de données (CSV, Excel, Google Sheets) déposés pour ce client par l'équipe Impulse Analytics : clé du jeu, " +
        "nom, description, nombre de lignes, colonnes avec leur type (text, number, date) et un exemple de valeur. " +
        "À appeler avant data_dataset_query pour connaître les colonnes exactes." + (MULTI ? "" : " Aucun paramètre."),
      inputSchema: { ...clientShape },
    },
    guarded(async (args) => {
      const rows = await q(
        `SELECT dataset_key, name, description, columns, row_count, loaded_at
         FROM client_data.datasets WHERE client_key = $1 AND current_load_id IS NOT NULL ORDER BY name`,
        [clientOf(args)],
      );
      return {
        datasets: rows.map((r) => ({
          dataset: r.dataset_key,
          name: r.name,
          description: r.description || null,
          rows: int(r.row_count),
          loaded_at: r.loaded_at ? new Date(r.loaded_at).toISOString().slice(0, 10) : null,
          columns: (Array.isArray(r.columns) ? r.columns : []).map((c) => ({ name: c.name, type: c.type, sample: c.sample ?? null })),
        })),
      };
    }),
  );

  const filterShape = z.object({
    column: z.string().describe("Nom exact d'une colonne (voir data_datasets)."),
    op: z.enum(OPERATORS).optional().describe("eq (défaut), neq, gt, gte, lt, lte, contains (texte, insensible à la casse), in (liste), is_null, not_null."),
    value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional().describe("Valeur comparée (liste pour in). Dates en YYYY-MM-DD."),
  });
  const aggregateShape = z.object({
    fn: z.enum(AGGREGATES).describe("count, count_distinct, sum, avg, min, max."),
    column: z.string().optional().describe("Colonne agrégée (facultative pour count)."),
  });

  server.registerTool(
    "data_dataset_query",
    {
      title: "Interroger un jeu de données",
      description:
        "Lit un jeu de données déposé (voir data_datasets) : lignes brutes (select) ou agrégats (group_by + aggregates : sum, avg, " +
        "count, count_distinct, min, max) avec filtres (where) et tri (order_by). Les colonnes se désignent par leur nom exact. " +
        `${DATASET_MAX_LIMIT} lignes au plus par appel (limit, offset pour la suite) ; la réponse indique s'il reste des lignes. ` +
        "Exemple : {dataset:'ventes-magasins', group_by:['magasin'], aggregates:[{fn:'sum',column:'ca_ht'}], order_by:[{by:'sum_ca_ht',dir:'desc'}]}.",
      inputSchema: {
        ...clientShape,
        dataset: z.string().describe("Clé du jeu (data_datasets → dataset)."),
        select: z.array(z.string()).optional().describe("Colonnes à renvoyer (lignes brutes). Défaut : toutes."),
        where: z.array(filterShape).optional().describe("Filtres combinés par ET."),
        group_by: z.array(z.string()).optional().describe("Colonnes de regroupement."),
        aggregates: z.array(aggregateShape).optional().describe("Agrégats calculés par groupe (ou sur tout le jeu sans group_by)."),
        order_by: z.array(z.object({ by: z.string(), dir: z.enum(["asc", "desc"]).optional() })).optional()
          .describe("Tri sur une colonne du résultat (nom de colonne, ou alias d'agrégat « fn_colonne », ex. sum_ca_ht)."),
        limit: z.number().int().min(1).max(DATASET_MAX_LIMIT).optional().describe(`Lignes renvoyées (défaut 20 brutes / 50 agrégées, max ${DATASET_MAX_LIMIT}).`),
        offset: z.number().int().min(0).optional().describe("Lignes à sauter (pagination)."),
      },
    },
    guarded(async (args) => {
      const ds = await loadDataset(clientOf(args), args.dataset);
      const built = buildDatasetQuery(ds, args);
      const rows = await q(built.text, built.values);
      const more = rows.length > built.limit;
      const page = more ? rows.slice(0, built.limit) : rows;
      return {
        dataset: ds.dataset_key,
        name: ds.name,
        total_rows_in_dataset: int(ds.row_count),
        aggregated: built.aggregated,
        returned: page.length,
        offset: built.offset,
        more_rows: more,
        ...(more ? { note: `Résultat tronqué à ${built.limit} lignes : les totaux ci-dessus ne portent que sur ces lignes. Demande la suite avec offset=${built.offset + built.limit}, ou agrège davantage.` } : {}),
        columns: built.columns,
        rows: page.map((r) => built.columns.map((c) => (r[c] instanceof Date ? r[c].toISOString().slice(0, 10) : r[c]))),
      };
    }),
  );
}

// ── Start ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp-client-data] prêt (client_keys=${CLIENT_KEYS.join(",")})`);

const shutdown = () => { pool.end().catch(() => undefined).finally(() => process.exit(0)); };
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
