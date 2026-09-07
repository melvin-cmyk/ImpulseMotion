#!/usr/bin/env node
/**
 * MCP stdio "client-data" — données e-commerce d'UN client (entrepôt client_data).
 *
 * Lancé par le relay (server/relay.mjs) avec, en env :
 *   CLIENT_KEY        — client_key imposé côté serveur (le LLM ne le choisit jamais)
 *   DATA_DATABASE_URL — URL Postgres LECTURE SEULE (rôle im_reader)
 * Refuse de démarrer sans ces deux variables.
 *
 * Toutes les requêtes sont paramétrées et filtrent client_key = $CLIENT_KEY.
 * Statut "canceled" exclu par défaut (param include_canceled). Montants EUR TTC
 * (grand_total), arrondis à 2 décimales, 200 lignes max par réponse.
 * Les dates sont interprétées en Europe/Paris (bornes incluses).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";

const CLIENT_KEY = process.env.CLIENT_KEY || "";
const DATA_DATABASE_URL = process.env.DATA_DATABASE_URL || "";
if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(CLIENT_KEY)) {
  console.error("[mcp-client-data] CLIENT_KEY manquante ou invalide — refus de démarrer");
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

function baseParams(p, args) {
  return [CLIENT_KEY, p.from, p.toExclusive, Boolean(args?.include_canceled)];
}

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
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

server.registerTool(
  "data_coverage",
  {
    title: "Couverture des données e-commerce",
    description:
      "Période couverte par les commandes e-commerce du client (première et dernière commande), nombre total de commandes, " +
      "répartition par statut et date du dernier chargement. À appeler en premier pour connaître la profondeur d'historique disponible. " +
      "Devise EUR, montants TTC (grand_total). Aucun paramètre.",
    inputSchema: {},
  },
  guarded(async () => {
    const [agg] = await q(
      `SELECT count(*)::int AS orders, min(created_at) AS first_at, max(created_at) AS last_at, max(ingested_at) AS last_ingested,
              sum(grand_total) FILTER (WHERE coalesce(status,'') <> 'canceled') AS revenue
       FROM client_data.orders WHERE client_key = $1`,
      [CLIENT_KEY],
    );
    const statuses = await q(
      `SELECT coalesce(status, '(inconnu)') AS status, count(*)::int AS n FROM client_data.orders
       WHERE client_key = $1 GROUP BY 1 ORDER BY n DESC LIMIT ${MAX_ROWS}`,
      [CLIENT_KEY],
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
  }),
);

server.registerTool(
  "data_sales_summary",
  {
    title: "Synthèse des ventes par période",
    description:
      "Ventes e-commerce agrégées par jour, semaine, mois ou en total sur la période : nombre de commandes, chiffre d'affaires " +
      "(somme de grand_total, EUR TTC), panier moyen (aov), articles vendus, nouveaux clients (première commande dans la période), " +
      "commandes invités. Source de référence pour le CA réel. Commandes annulées exclues par défaut.",
    inputSchema: {
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
    inputSchema: { ...periodShape },
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
    inputSchema: { ...periodShape },
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
    inputSchema: { from: periodShape.from, to: periodShape.to },
  },
  guarded(async (args) => {
    const p = period(args);
    const rows = await q(
      `SELECT coalesce(o.status, '(inconnu)') AS status, count(*)::int AS orders, sum(o.grand_total) AS revenue
       FROM client_data.orders o WHERE ${WHERE} GROUP BY 1 ORDER BY orders DESC LIMIT ${MAX_ROWS}`,
      [CLIENT_KEY, p.from, p.toExclusive, true],
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

// ── Start ───────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp-client-data] prêt (client_key=${CLIENT_KEY})`);

const shutdown = () => { pool.end().catch(() => undefined).finally(() => process.exit(0)); };
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
