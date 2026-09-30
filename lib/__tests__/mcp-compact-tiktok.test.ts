/**
 * TikTok answers through server/mcp-compact.mjs. The envelope
 * { code, message, request_id, data: { list, page_info } } and the error below
 * are the API's own (the error was read on 2026-09-30); the report rows follow
 * the documented shape { dimensions, metrics }, every value a string.
 */
import { describe, expect, it } from "vitest";
import { compactText } from "../../server/mcp-compact.mjs";

const ctx = (tool: string) => ({ server: "mcp-tiktok-ads", tool });
const envelope = (list: unknown[], page_info: Record<string, number> = { page: 1, page_size: 1000, total_number: list.length, total_page: 1 }) =>
  JSON.stringify({ code: 0, message: "OK", request_id: "2026093019363833C1577FBDCDB72D13E1", data: { list, page_info } }, null, 2);

const campaignRow = (i: number) => ({
  dimensions: { campaign_id: `18000000000000000${String(i).padStart(2, "0")}` },
  metrics: {
    campaign_name: `Campagne ${i}`, objective_type: "WEB_CONVERSIONS",
    spend: (100 + i).toFixed(2), impressions: String(10_000 * i), clicks: String(100 * i), reach: String(8_000 * i), frequency: "1.25",
    ctr: "1.00", cpc: ((100 + i) / (100 * i)).toFixed(2), cpm: ((100 + i) / (10 * i)).toFixed(2),
    conversion: String(i), cost_per_conversion: ((100 + i) / i).toFixed(2), conversion_rate: "1.00",
    complete_payment: String(i), complete_payment_roas: "2.5", video_play_actions: String(5_000 * i),
  },
});

describe("compactText — TikTok", () => {
  it("renders the API's own error as one short line, without the request id", () => {
    const raw = JSON.stringify({ code: 40001, message: "The advertiser 7000000000000000001 doesn't exist or has been deleted.", request_id: "2026093019363833C1577FBDCDB72D13E1", data: {} }, null, 2);
    const { text } = compactText(raw, ctx("get_campaign_performance"));
    expect(text).toContain("40001");
    expect(text).toContain("doesn't exist");
    expect(text).not.toContain("request_id");
    expect(text).not.toContain("2026093019363833C1577FBDCDB72D13E1");
  });

  it("merges dimensions and metrics into one table, numbers read as numbers, ids kept whole", () => {
    const { text, stats } = compactText(envelope([1, 2, 3, 4].map(campaignRow)), ctx("get_campaign_performance"));
    const lines = text.split("\n");
    const header = lines.find((l) => l.includes("campaign_id") && l.includes("spend"))!;
    expect(header).toBeTruthy();
    expect(text).toContain("1800000000000000001"); // 19 digits: a number would lose the last ones
    expect(text).toContain("Campagne 3");
    expect(text).toContain("103"); // spend of campaign 3, without its trailing zeros
    expect(text).not.toContain("dimensions");
    expect(text).not.toContain("request_id");
    expect(text).not.toContain("page_size");
    expect(text).toContain("objective_type=WEB_CONVERSIONS"); // constant, said once
    expect(stats.out).toBeLessThan(stats.raw / 2);
  });

  it("says when the page is not the last one, and which one it is", () => {
    const { text } = compactText(envelope([1, 2, 3].map(campaignRow), { page: 1, page_size: 1000, total_number: 2400, total_page: 3 }), ctx("get_ad_performance"));
    expect(text.split("\n")[0]).toContain("page partielle");
    expect(text).toContain("page=1");
    expect(text).toContain("total_page=3");
  });

  it("says nothing about pages on a complete answer", () => {
    const { text } = compactText(envelope([1, 2, 3].map(campaignRow)), ctx("get_ad_performance"));
    expect(text).not.toContain("page partielle");
    expect(text).not.toContain("total_page");
  });

  it("drops « - », the API's way of saying a metric does not apply", () => {
    const rows = [1, 2, 3].map(campaignRow);
    (rows[1].metrics as Record<string, string>).complete_payment_roas = "-";
    const { text } = compactText(envelope(rows), ctx("get_campaign_performance"));
    expect(text).not.toMatch(/\t-(\t|$)/m);
  });

  it("summarises a long daily series by campaign: sums, and ratios recomputed on the sums", () => {
    const list = [];
    for (let c = 1; c <= 20; c++) {
      for (let d = 1; d <= 30; d++) {
        list.push({
          dimensions: { campaign_id: `18000000000000000${String(c).padStart(2, "0")}`, stat_time_day: `2026-09-${String(d).padStart(2, "0")} 00:00:00` },
          metrics: { campaign_name: `Campagne ${c}`, spend: "10.00", impressions: "1000", clicks: "20", ctr: "2.00", cpc: "0.50", conversion: "2", cost_per_conversion: "5.00", conversion_rate: "10.00", complete_payment_roas: "3.1" },
        });
      }
    }
    const { text, stats } = compactText(envelope(list), ctx("get_report_integrated"));
    expect(stats.mode).toBe("summary");
    expect(text).toContain("600 lignes");
    expect(text).toContain("du 2026-09-01 au 2026-09-30");
    // 30 days × 10 of spend, 60 conversions, for each campaign.
    const total = text.split("\n").find((l) => /Campagne 7\t/.test(l) || l.startsWith("1800000000000000007"))!;
    expect(total).toContain("300");
    expect(total).toContain("60");
    expect(text).toMatch(/cost_per_conversion=spend\/conversion/);
    expect(text).toMatch(/conversion_rate=100×conversion\/clicks/);
    expect(text).toMatch(/non additifs : .*complete_payment_roas/);
  });

  it("shows of an advertiser only what a conversation needs", () => {
    const raw = envelope([{
      advertiser_id: "7111111111111111111", name: "Client Démo", company: "Démo SAS", currency: "EUR", timezone: "Europe/Paris", display_timezone: "Europe/Paris",
      status: "STATUS_ENABLE", country: "FR", industry: "291905", role: "ROLE_ADVERTISER",
      balance: 1234.56, email: "contact@demo.test", cellphone_number: "+33600000000", telephone_number: "+33100000000", address: "1 rue du Test", contacter: "Jean Test",
      license_no: "L-1", license_url: "https://example.test/licence.png", create_time: 1700000000,
    }]);
    const { text } = compactText(raw, ctx("get_advertiser_info"));
    for (const kept of ["7111111111111111111", "Client Démo", "EUR", "Europe/Paris", "STATUS_ENABLE"]) expect(text).toContain(kept);
    for (const gone of ["1234.56", "balance", "contact@demo.test", "+33600000000", "+33100000000", "1 rue du Test", "Jean Test", "L-1", "licence.png"]) expect(text).not.toContain(gone);
  });

  it("keeps a structure list readable", () => {
    const list = [1, 2, 3].map((i) => ({ advertiser_id: "7111111111111111111", campaign_id: `180000000000000000${i}`, campaign_name: `Campagne ${i}`, operation_status: i === 2 ? "DISABLE" : "ENABLE", budget: 50 * i, budget_mode: "BUDGET_MODE_DAY", objective_type: "WEB_CONVERSIONS" }));
    const { text } = compactText(envelope(list), ctx("get_campaigns"));
    expect(text).toContain("Campagne 2");
    expect(text).toContain("DISABLE");
    expect(text).toContain("advertiser_id=7111111111111111111");
  });

  it("an empty answer stays an answer", () => {
    const { text } = compactText(envelope([]), ctx("get_campaign_performance"));
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("request_id");
  });

  it("does not take another server's object for a TikTok answer", () => {
    const meta = JSON.stringify({ data: [{ campaign_name: "A", spend: "10" }, { campaign_name: "B", spend: "20" }, { campaign_name: "C", spend: "30" }], paging: { cursors: {} } });
    const { text } = compactText(meta, { server: "meta-ads-impulse", tool: "Campaign_Performance1" });
    expect(text).toContain("3 lignes");
  });
});
