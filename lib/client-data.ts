/**
 * Entrepôt client_data (2e projet Neon) — commandes e-commerce des clients.
 *
 * Jamais via Prisma : pool `pg` lazy (singleton global). Toutes les lignes
 * portent `client_key` = ClientBot.clientKey ; le scoping est fait ici, jamais
 * par l'appelant.
 *
 * Env : DATA_DATABASE_URL (URL owner, lecture/écriture) — fallback DB_DATABASE_URL.
 */

import { Pool } from "pg";

// ── Types ───────────────────────────────────────────────────────────────────

type Raw = string | number | boolean | null | undefined;

/**
 * Une ligne PLATE par article, telle que produite par n8n depuis Magento.
 * Tout peut arriver en string ou null ; l'en-tête de commande est répété sur
 * chaque ligne (is_order_head marque éventuellement la première).
 */
export interface IngestRow {
  order_id?: Raw;
  entity_id?: Raw;
  created_at?: Raw;
  updated_at?: Raw;
  status?: Raw;
  code_prescripteur?: Raw;
  code_prescripteur_norm?: Raw;
  type_prescripteur?: Raw;
  sku?: Raw;
  product_name?: Raw;
  qty_ordered?: Raw;
  price?: Raw;
  row_total?: Raw;
  product_id?: Raw;
  product_type?: Raw;
  is_order_head?: Raw;
  grand_total?: Raw;
  subtotal?: Raw;
  shipping_amount?: Raw;
  tax_amount?: Raw;
  discount_amount?: Raw;
  customer_id?: Raw;
  customer_is_guest?: Raw;
  customer_key?: Raw;
  customer_group_id?: Raw;
  store_id?: Raw;
  payment_method?: Raw;
  shipping_description?: Raw;
  coupon_code?: Raw;
  billing_country?: Raw;
  total_qty_ordered?: Raw;
  customer_created_at?: Raw;
  currency?: Raw;
  [extra: string]: Raw;
}

export interface OrderRecord {
  order_id: string;
  entity_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  status: string | null;
  grand_total: number | null;
  subtotal: number | null;
  shipping_amount: number | null;
  tax_amount: number | null;
  discount_amount: number | null;
  total_qty: number | null;
  currency: string;
  customer_id: string | null;
  customer_is_guest: boolean | null;
  customer_key: string | null;
  customer_created_at: string | null;
  customer_group: string | null;
  store_id: string | null;
  payment_method: string | null;
  shipping_method: string | null;
  coupon_code: string | null;
  billing_country: string | null;
  prescriber_code: string | null;
  prescriber_type: string | null;
  attrs: Record<string, unknown>;
}

export interface OrderItemRecord {
  line_no: number;
  sku: string | null;
  product_name: string | null;
  qty: number | null;
  unit_price: number | null;
  row_total: number | null;
  product_id: string | null;
  product_type: string | null;
  attrs: Record<string, unknown>;
}

export interface OrderGroup {
  order: OrderRecord;
  items: OrderItemRecord[];
}

export interface Coverage {
  orders: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  lastIngestedAt: string | null;
  statuses: Record<string, number>;
}

// ── Parsing helpers (exportés pour les tests) ───────────────────────────────

export function str(v: Raw): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function num(v: Raw): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function bool(v: Raw): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "oui"].includes(s)) return true;
  if (["0", "false", "f", "no", "n", "non"].includes(s)) return false;
  return null;
}

/**
 * Dates Magento = "YYYY-MM-DD HH:MM:SS" en UTC (sans fuseau). Les ISO avec
 * fuseau explicite sont respectées telles quelles. Retourne un ISO UTC ou null.
 */
export function magentoDate(v: Raw): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/);
  const iso = m ? `${m[1]}T${m[2]}Z` : /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mapOrder(head: IngestRow, orderId: string): OrderRecord {
  const rawCode = str(head.code_prescripteur);
  const normCode = str(head.code_prescripteur_norm);
  const attrs: Record<string, unknown> = {};
  if (rawCode && normCode && rawCode !== normCode) attrs.code_prescripteur_raw = rawCode;
  return {
    order_id: orderId,
    entity_id: str(head.entity_id),
    created_at: magentoDate(head.created_at),
    updated_at: magentoDate(head.updated_at),
    status: str(head.status),
    grand_total: num(head.grand_total),
    subtotal: num(head.subtotal),
    shipping_amount: num(head.shipping_amount),
    tax_amount: num(head.tax_amount),
    discount_amount: num(head.discount_amount),
    total_qty: num(head.total_qty_ordered),
    currency: str(head.currency) ?? "EUR",
    customer_id: str(head.customer_id),
    customer_is_guest: bool(head.customer_is_guest),
    customer_key: str(head.customer_key),
    customer_created_at: magentoDate(head.customer_created_at),
    customer_group: str(head.customer_group_id),
    store_id: str(head.store_id),
    payment_method: str(head.payment_method),
    shipping_method: str(head.shipping_description),
    coupon_code: str(head.coupon_code),
    billing_country: str(head.billing_country),
    prescriber_code: normCode ?? rawCode,
    prescriber_type: str(head.type_prescripteur),
    attrs,
  };
}

function mapItem(row: IngestRow, lineNo: number): OrderItemRecord {
  return {
    line_no: lineNo,
    sku: str(row.sku),
    product_name: str(row.product_name),
    qty: num(row.qty_ordered),
    unit_price: num(row.price),
    row_total: num(row.row_total),
    product_id: str(row.product_id),
    product_type: str(row.product_type),
    attrs: {},
  };
}

/**
 * Regroupe les lignes plates par order_id. L'en-tête est pris sur la ligne
 * marquée is_order_head si présente, sinon la première ligne reçue. Chaque
 * ligne portant un article (sku / product_name / product_id) devient un item,
 * line_no = ordre d'arrivée (1..n). Les lignes sans order_id sont ignorées.
 */
export function groupIngestRows(rows: IngestRow[]): OrderGroup[] {
  const groups = new Map<string, { head: IngestRow; rows: IngestRow[] }>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const orderId = str(row.order_id);
    if (!orderId) continue;
    let g = groups.get(orderId);
    if (!g) {
      g = { head: row, rows: [] };
      groups.set(orderId, g);
    } else if (bool(row.is_order_head) === true && bool(g.head.is_order_head) !== true) {
      g.head = row;
    }
    g.rows.push(row);
  }
  const out: OrderGroup[] = [];
  for (const [orderId, g] of groups) {
    const items: OrderItemRecord[] = [];
    for (const row of g.rows) {
      if (str(row.sku) || str(row.product_name) || str(row.product_id)) {
        items.push(mapItem(row, items.length + 1));
      }
    }
    out.push({ order: mapOrder(g.head, orderId), items });
  }
  return out;
}

// ── Pool ────────────────────────────────────────────────────────────────────

const globalForData = globalThis as unknown as { __clientDataPool?: Pool };

function poolConfig(connectionString: string) {
  const u = new URL(connectionString);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  // pg traite sslmode=require comme verify-full et avertit à chaque connexion :
  // on retire le paramètre et on passe ssl explicitement (certificats Neon valides).
  u.searchParams.delete("sslmode");
  u.searchParams.delete("channel_binding");
  return {
    connectionString: u.toString(),
    ssl: local ? undefined : { rejectUnauthorized: true },
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

export function hasClientDataDb(): boolean {
  return Boolean(process.env.DATA_DATABASE_URL || process.env.DB_DATABASE_URL);
}

export function getClientDataPool(): Pool {
  if (globalForData.__clientDataPool) return globalForData.__clientDataPool;
  const url = process.env.DATA_DATABASE_URL || process.env.DB_DATABASE_URL;
  if (!url) throw new Error("DATA_DATABASE_URL manquante (entrepôt client_data)");
  const pool = new Pool(poolConfig(url));
  pool.on("error", (err) => console.error("[client-data] pool error:", err.message));
  globalForData.__clientDataPool = pool;
  return pool;
}

// ── Upsert ──────────────────────────────────────────────────────────────────

const ORDER_COLS = [
  "entity_id", "created_at", "updated_at", "status",
  "grand_total", "subtotal", "shipping_amount", "tax_amount", "discount_amount", "total_qty",
  "currency", "customer_id", "customer_is_guest", "customer_key", "customer_created_at", "customer_group",
  "store_id", "payment_method", "shipping_method", "coupon_code", "billing_country",
  "prescriber_code", "prescriber_type", "attrs",
] as const;

const ORDER_CASTS: Record<(typeof ORDER_COLS)[number], string> = {
  entity_id: "text", created_at: "timestamptz", updated_at: "timestamptz", status: "text",
  grand_total: "numeric", subtotal: "numeric", shipping_amount: "numeric", tax_amount: "numeric",
  discount_amount: "numeric", total_qty: "numeric",
  currency: "text", customer_id: "text", customer_is_guest: "boolean", customer_key: "text",
  customer_created_at: "timestamptz", customer_group: "text",
  store_id: "text", payment_method: "text", shipping_method: "text", coupon_code: "text", billing_country: "text",
  prescriber_code: "text", prescriber_type: "text", attrs: "jsonb",
};

const ITEM_COLS = ["line_no", "sku", "product_name", "qty", "unit_price", "row_total", "product_id", "product_type", "attrs"] as const;
const ITEM_CASTS: Record<(typeof ITEM_COLS)[number], string> = {
  line_no: "int", sku: "text", product_name: "text", qty: "numeric", unit_price: "numeric", row_total: "numeric",
  product_id: "text", product_type: "text", attrs: "jsonb",
};

/** pg sérialise les tableaux JS ; numeric/timestamptz/jsonb passent en text puis cast côté SQL. */
function col(values: unknown[]): (string | number | boolean | null)[] {
  return values.map((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "object") return JSON.stringify(v);
    if (typeof v === "number") return String(v);
    return v as string | boolean;
  });
}

const CHUNK = 500;

/**
 * Upsert des commandes (ON CONFLICT DO UPDATE) + remplacement complet des
 * articles de chaque commande reçue. Une transaction par appel.
 * Retourne le nombre de commandes et d'articles écrits.
 */
export async function upsertOrderRows(
  clientKey: string,
  rows: IngestRow[],
): Promise<{ orders: number; items: number }> {
  const groups = groupIngestRows(rows);
  if (groups.length === 0) return { orders: 0, items: 0 };

  const pool = getClientDataPool();
  const client = await pool.connect();
  let items = 0;
  try {
    await client.query("BEGIN");
    for (let i = 0; i < groups.length; i += CHUNK) {
      const chunk = groups.slice(i, i + CHUNK);
      const orderIds = chunk.map((g) => g.order.order_id);

      // Orders: un seul INSERT ... SELECT FROM unnest(...)
      const params: unknown[] = [clientKey, orderIds];
      const unnestArgs: string[] = ["$2::text[]"];
      for (const c of ORDER_COLS) {
        params.push(col(chunk.map((g) => g.order[c])));
        unnestArgs.push(`$${params.length}::${ORDER_CASTS[c]}[]`);
      }
      const updates = ORDER_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
      await client.query(
        `INSERT INTO client_data.orders (client_key, order_id, ${ORDER_COLS.join(", ")}, ingested_at)
         SELECT $1, t.order_id, ${ORDER_COLS.map((c) => `t.${c}`).join(", ")}, now()
         FROM unnest(${unnestArgs.join(", ")}) AS t(order_id, ${ORDER_COLS.join(", ")})
         ON CONFLICT (client_key, order_id) DO UPDATE SET ${updates}, ingested_at = now()`,
        params,
      );

      // Items: delete + reinsert for every order in the chunk
      await client.query(
        "DELETE FROM client_data.order_items WHERE client_key = $1 AND order_id = ANY($2::text[])",
        [clientKey, orderIds],
      );
      const flat = chunk.flatMap((g) => g.items.map((it) => ({ order_id: g.order.order_id, ...it })));
      if (flat.length) {
        const iparams: unknown[] = [clientKey, flat.map((r) => r.order_id)];
        const iargs: string[] = ["$2::text[]"];
        for (const c of ITEM_COLS) {
          iparams.push(col(flat.map((r) => r[c])));
          iargs.push(`$${iparams.length}::${ITEM_CASTS[c]}[]`);
        }
        await client.query(
          `INSERT INTO client_data.order_items (client_key, order_id, ${ITEM_COLS.join(", ")})
           SELECT $1, t.order_id, ${ITEM_COLS.map((c) => `t.${c}`).join(", ")}
           FROM unnest(${iargs.join(", ")}) AS t(order_id, ${ITEM_COLS.join(", ")})`,
          iparams,
        );
        items += flat.length;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { orders: groups.length, items };
}

// ── Coverage ────────────────────────────────────────────────────────────────

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function getCoverage(clientKey: string): Promise<Coverage> {
  const pool = getClientDataPool();
  const [agg, byStatus] = await Promise.all([
    pool.query<{ orders: number; first_at: Date | null; last_at: Date | null; last_ingested: Date | null }>(
      `SELECT count(*)::int AS orders, min(created_at) AS first_at, max(created_at) AS last_at,
              max(ingested_at) AS last_ingested
       FROM client_data.orders WHERE client_key = $1`,
      [clientKey],
    ),
    pool.query<{ status: string | null; n: number }>(
      `SELECT status, count(*)::int AS n FROM client_data.orders
       WHERE client_key = $1 GROUP BY status ORDER BY n DESC`,
      [clientKey],
    ),
  ]);
  const row = agg.rows[0];
  const statuses: Record<string, number> = {};
  for (const r of byStatus.rows) statuses[r.status ?? "(inconnu)"] = Number(r.n);
  return {
    orders: Number(row?.orders ?? 0),
    firstOrderAt: iso(row?.first_at),
    lastOrderAt: iso(row?.last_at),
    lastIngestedAt: iso(row?.last_ingested),
    statuses,
  };
}
