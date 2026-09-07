import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for pg (hoisted: vi.mock factories run first).
const calls: { text: string; values?: unknown[] }[] = [];
const state = vi.hoisted(() => ({ nextRows: [] as unknown[][], failOn: null as string | null }));

vi.mock("pg", () => {
  class Pool {
    on() { return this; }
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return { rows: state.nextRows.shift() ?? [], rowCount: 0 };
    }
    async connect() {
      return {
        query: async (text: string, values?: unknown[]) => {
          calls.push({ text, values });
          if (state.failOn && text.includes(state.failOn)) throw new Error("boom");
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      };
    }
  }
  return { Pool, default: { Pool } };
});

import {
  groupIngestRows, magentoDate, num, bool, upsertOrderRows, getCoverage, type IngestRow,
} from "@/lib/client-data";

const head = {
  order_id: "100000123", entity_id: "123", created_at: "2026-03-05 14:22:10", updated_at: "2026-03-06 08:00:00",
  status: "complete", code_prescripteur: "  Dr-DUPONT ", code_prescripteur_norm: "DRDUPONT", type_prescripteur: "medecin",
  grand_total: "89,90", subtotal: "74.92", shipping_amount: "5.90", tax_amount: "14.98", discount_amount: "0",
  customer_id: "42", customer_is_guest: "0", customer_key: "c42", customer_group_id: "1", store_id: "1",
  payment_method: "checkmo", shipping_description: "Colissimo", coupon_code: null, billing_country: "FR",
  total_qty_ordered: "3", customer_created_at: "2025-11-01 10:00:00",
};

beforeEach(() => {
  calls.length = 0;
  state.nextRows = [];
  state.failOn = null;
  process.env.DATA_DATABASE_URL = "postgresql://u:p@db.example.neon.tech/neondb?sslmode=require";
});

describe("parsing helpers", () => {
  it("parses Magento UTC dates and tolerates ISO / empty values", () => {
    expect(magentoDate("2026-03-05 14:22:10")).toBe("2026-03-05T14:22:10.000Z");
    expect(magentoDate("2026-03-05")).toBe("2026-03-05T00:00:00.000Z");
    expect(magentoDate("2026-03-05T14:22:10+02:00")).toBe("2026-03-05T12:22:10.000Z");
    expect(magentoDate("")).toBeNull();
    expect(magentoDate(null)).toBeNull();
    expect(magentoDate("n/a")).toBeNull();
  });
  it("parses numbers with comma decimals and booleans in any shape", () => {
    expect(num("89,90")).toBe(89.9);
    expect(num("1 234.5")).toBe(1234.5);
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
    expect(num(12)).toBe(12);
    expect(bool("1")).toBe(true);
    expect(bool("false")).toBe(false);
    expect(bool(true)).toBe(true);
    expect(bool(null)).toBeNull();
  });
});

describe("groupIngestRows", () => {
  it("groups flat rows by order_id, maps the header and numbers the items in arrival order", () => {
    const rows: IngestRow[] = [
      { ...head, is_order_head: "1", sku: "A-1", product_name: "Crème A", qty_ordered: "2", price: "19.96", row_total: "39.92", product_id: "7", product_type: "simple" },
      { ...head, is_order_head: "0", sku: "B-2", product_name: "Sérum B", qty_ordered: "1", price: "35", row_total: "35", product_id: "8", product_type: "simple" },
      { order_id: "100000124", created_at: "2026-03-07 09:00:00", status: "canceled", grand_total: "10", customer_is_guest: "1", sku: "C-3", product_name: "C", qty_ordered: "1", price: "10", row_total: "10" },
      { order_id: null, sku: "ORPHAN" },
    ];
    const groups = groupIngestRows(rows);
    expect(groups).toHaveLength(2);

    const [g1, g2] = groups;
    expect(g1.order).toMatchObject({
      order_id: "100000123", entity_id: "123", status: "complete",
      created_at: "2026-03-05T14:22:10.000Z", updated_at: "2026-03-06T08:00:00.000Z",
      grand_total: 89.9, subtotal: 74.92, shipping_amount: 5.9, tax_amount: 14.98, discount_amount: 0, total_qty: 3,
      currency: "EUR", customer_id: "42", customer_is_guest: false, customer_key: "c42",
      customer_created_at: "2025-11-01T10:00:00.000Z", customer_group: "1", store_id: "1",
      payment_method: "checkmo", shipping_method: "Colissimo", coupon_code: null, billing_country: "FR",
      prescriber_code: "DRDUPONT", prescriber_type: "medecin",
    });
    expect(g1.order.attrs).toEqual({ code_prescripteur_raw: "Dr-DUPONT" });
    expect(g1.items).toEqual([
      { line_no: 1, sku: "A-1", product_name: "Crème A", qty: 2, unit_price: 19.96, row_total: 39.92, product_id: "7", product_type: "simple", attrs: {} },
      { line_no: 2, sku: "B-2", product_name: "Sérum B", qty: 1, unit_price: 35, row_total: 35, product_id: "8", product_type: "simple", attrs: {} },
    ]);

    expect(g2.order.order_id).toBe("100000124");
    expect(g2.order.customer_is_guest).toBe(true);
    expect(g2.order.prescriber_code).toBeNull();
    expect(g2.items).toHaveLength(1);
  });

  it("prefers the row flagged is_order_head for the header even if it arrives later", () => {
    const rows: IngestRow[] = [
      { order_id: "1", is_order_head: "0", grand_total: "1", sku: "x" },
      { order_id: "1", is_order_head: "1", grand_total: "99", sku: "y" },
    ];
    const [g] = groupIngestRows(rows);
    expect(g.order.grand_total).toBe(99);
    expect(g.items.map((i) => i.sku)).toEqual(["x", "y"]);
  });

  it("falls back to the raw prescriber code when no normalised one is given", () => {
    const [g] = groupIngestRows([{ order_id: "1", code_prescripteur: "abc", sku: "x" }]);
    expect(g.order.prescriber_code).toBe("abc");
    expect(g.order.attrs).toEqual({});
  });
});

describe("upsertOrderRows", () => {
  it("runs one transaction: orders upsert, items delete + reinsert, scoped by client_key", async () => {
    const rows: IngestRow[] = [
      { ...head, sku: "A-1", qty_ordered: "2", price: "19.96", row_total: "39.92" },
      { ...head, sku: "B-2", qty_ordered: "1", price: "35", row_total: "35" },
    ];
    const res = await upsertOrderRows("lpev", rows);
    expect(res).toEqual({ orders: 1, items: 2 });

    const texts = calls.map((c) => c.text.replace(/\s+/g, " ").trim());
    expect(texts[0]).toBe("BEGIN");
    expect(texts[1]).toMatch(/^INSERT INTO client_data\.orders/);
    expect(texts[1]).toContain("ON CONFLICT (client_key, order_id) DO UPDATE SET");
    expect(texts[2]).toMatch(/^DELETE FROM client_data\.order_items WHERE client_key = \$1 AND order_id = ANY/);
    expect(texts[3]).toMatch(/^INSERT INTO client_data\.order_items/);
    expect(texts[4]).toBe("COMMIT");

    // params: client_key first, then column arrays (one entry per order / item)
    const orderParams = calls[1].values!;
    expect(orderParams[0]).toBe("lpev");
    expect(orderParams[1]).toEqual(["100000123"]);
    expect(calls[2].values).toEqual(["lpev", ["100000123"]]);
    const itemParams = calls[3].values!;
    expect(itemParams[0]).toBe("lpev");
    expect(itemParams[1]).toEqual(["100000123", "100000123"]);
    expect(itemParams[2]).toEqual(["1", "2"]); // line_no as text, cast to int[] in SQL
    expect(itemParams[3]).toEqual(["A-1", "B-2"]);
  });

  it("does nothing without usable rows", async () => {
    expect(await upsertOrderRows("lpev", [{ order_id: "" }, {} as IngestRow])).toEqual({ orders: 0, items: 0 });
    expect(calls).toHaveLength(0);
  });

  it("rolls back and rethrows on failure", async () => {
    state.failOn = "INSERT INTO client_data.orders";
    await expect(upsertOrderRows("lpev", [{ ...head, sku: "A" }])).rejects.toThrow("boom");
    expect(calls.map((c) => c.text.trim())).toContain("ROLLBACK");
  });
});

describe("getCoverage", () => {
  it("aggregates counts, period and statuses", async () => {
    state.nextRows = [
      [{ orders: 3, first_at: new Date("2026-01-01T00:00:00Z"), last_at: new Date("2026-03-01T00:00:00Z"), last_ingested: new Date("2026-03-02T00:00:00Z") }],
      [{ status: "complete", n: 2 }, { status: null, n: 1 }],
    ];
    const cov = await getCoverage("lpev");
    expect(cov).toEqual({
      orders: 3,
      firstOrderAt: "2026-01-01T00:00:00.000Z",
      lastOrderAt: "2026-03-01T00:00:00.000Z",
      lastIngestedAt: "2026-03-02T00:00:00.000Z",
      statuses: { complete: 2, "(inconnu)": 1 },
    });
    expect(calls.every((c) => c.values?.[0] === "lpev")).toBe(true);
  });
});
