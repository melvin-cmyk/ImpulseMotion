/**
 * TikTok data read by the application through the relay's direct call
 * (lib/tiktok-data.ts): ranges cut at 30 days, every page read, rows summed,
 * purchase value read from total_purchase_value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
let answer: (tool: string, input: Record<string, unknown>) => unknown = () => ({ code: 0, data: { list: [] } });

vi.mock("@/lib/relay-tool", () => ({
  relayDirectTool: vi.fn(async (tool: string, input: Record<string, unknown>) => {
    calls.push({ tool, input });
    return answer(tool, input);
  }),
}));

import { chunkRange, fetchTikTokCampaigns, fetchTikTokDaily, fetchTikTokTotals, listTikTokAdvertisers, statsOf, tiktokEnvelope } from "@/lib/tiktok-data";

const ID = "6869676251863318529";
const ok = (list: unknown[], totalPage = 1) => ({ code: 0, message: "OK", data: { list, page_info: { page: 1, total_page: totalPage } } });

beforeEach(() => {
  calls.length = 0;
  answer = () => ok([]);
});

describe("chunkRange", () => {
  it("cuts a range in pieces of 30 days at most, inclusive", () => {
    expect(chunkRange("2026-09-01", "2026-09-30")).toEqual([{ since: "2026-09-01", until: "2026-09-30" }]);
    expect(chunkRange("2026-08-01", "2026-09-30")).toEqual([
      { since: "2026-08-01", until: "2026-08-30" },
      { since: "2026-08-31", until: "2026-09-29" },
      { since: "2026-09-30", until: "2026-09-30" },
    ]);
    expect(chunkRange("2026-09-02", "2026-09-01")).toEqual([]);
    expect(chunkRange("septembre", "2026-09-01")).toEqual([]);
  });
});

describe("tiktokEnvelope / statsOf", () => {
  it("throws on a TikTok error, reads list and pages otherwise", () => {
    expect(() => tiktokEnvelope({ code: 40001, message: "advertiser doesn't exist" })).toThrow(/40001/);
    expect(() => tiktokEnvelope("texte")).toThrow(/illisible/);
    expect(tiktokEnvelope([ok([{ a: 1 }], 3)])).toEqual({ list: [{ a: 1 }], totalPage: 3 });
  });

  it("reads the purchase value from total_purchase_value, never from complete_payment", () => {
    const s = statsOf({ metrics: { spend: "70033.20", total_purchase_value: "696183.60", total_purchase: "11829", complete_payment: "0", conversion: "15243", impressions: "-" } });
    expect(s).toMatchObject({ spend: 70033.2, purchaseValue: 696183.6, purchases: 11829, conversions: 15243, impressions: 0 });
  });
});

describe("reports", () => {
  it("sums the totals of every 30-day piece, one advertiser per call", async () => {
    answer = () => ok([{ dimensions: { advertiser_id: ID }, metrics: { spend: "10.5", total_purchase_value: "100" } }]);
    const t = await fetchTikTokTotals(ID, "2026-08-01", "2026-09-30");
    expect(calls).toHaveLength(3);
    expect(t.spend).toBeCloseTo(31.5);
    expect(t.purchaseValue).toBe(300);
    expect(calls[0]).toMatchObject({ tool: "mcp-tiktok-ads.get_report_integrated", input: { advertiser_id: ID, data_level: "AUCTION_ADVERTISER", start_date: "2026-08-01", end_date: "2026-08-30" } });
    expect(calls[0].input.metrics).toEqual(expect.arrayContaining(["spend", "total_purchase_value", "total_purchase", "conversion"]));
  });

  it("reads every page", async () => {
    answer = (_t, input) => ok([{ dimensions: { stat_time_day: `2026-09-0${input.page} 00:00:00` }, metrics: { spend: "1" } }], 3);
    const days = await fetchTikTokDaily(ID, "2026-09-01", "2026-09-03");
    expect(calls.map((c) => c.input.page)).toEqual(["1", "2", "3"]);
    expect(days.map((d) => d.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("merges a campaign found in two pieces of the range, highest spend first", async () => {
    answer = (_t, input) => ok(input.start_date === "2026-08-01"
      ? [{ dimensions: { campaign_id: "1" }, metrics: { campaign_name: "A", objective_type: "APP_PROMOTION", spend: "5" } }]
      : [{ dimensions: { campaign_id: "1" }, metrics: { campaign_name: "A", spend: "5" } }, { dimensions: { campaign_id: "2" }, metrics: { campaign_name: "B", spend: "20" } }]);
    const rows = await fetchTikTokCampaigns(ID, "2026-08-01", "2026-09-15");
    expect(rows.map((r) => [r.id, r.name, r.spend])).toEqual([["2", "B", 20], ["1", "A", 10]]);
    expect(rows[1].objective).toBe("APP_PROMOTION");
  });

  it("lets a TikTok error surface (the caller decides what to show)", async () => {
    answer = () => ({ code: 40001, message: "advertiser doesn't exist" });
    await expect(fetchTikTokTotals(ID, "2026-09-01", "2026-09-30")).rejects.toThrow(/40001/);
  });
});

describe("listTikTokAdvertisers", () => {
  it("lists the accounts of every Business Center once, with the centers they belong to", async () => {
    answer = (tool, input) => tool.endsWith("list_business_centers")
      ? ok([{ bc_info: { bc_id: "111111", name: "Agence" } }, { bc_info: { bc_id: "222222", name: "Jow" } }, { bc_info: { bc_id: "x", name: "?" } }])
      : input.bc_id === "111111"
        ? ok([{ asset_id: ID, asset_name: "Jow.cuisine" }, { asset_id: "7640043625339715604", asset_name: "Vins de Provence EN" }])
        : ok([{ asset_id: ID, asset_name: "Jow.cuisine" }]);
    const list = await listTikTokAdvertisers({ fresh: true });
    expect(list).toEqual([
      { id: ID, name: "Jow.cuisine", businessCenters: ["Agence", "Jow"] },
      { id: "7640043625339715604", name: "Vins de Provence EN", businessCenters: ["Agence"] },
    ]);
    // A center id that is not digits is never asked for.
    expect(calls.filter((c) => c.tool.endsWith("list_bc_advertisers")).map((c) => c.input.bc_id)).toEqual(["111111", "222222"]);
  });
});
