/**
 * Arguments of the TikTok tools as the scope proxy sends them upstream
 * (server/mcp-tiktok-args.mjs). The n8n flow asks the model for parameters it
 * was meant to fix itself (measured on 2026-09-30: a report without
 * report_type, data_level, dimensions, metrics, page, page_size never reaches
 * TikTok); the server sets them, and says so in the tool description.
 */
import { describe, expect, it } from "vitest";
import { describeTikTokTool, prepareTikTokArgs } from "../../server/mcp-tiktok-args.mjs";

const sent = (name: string, args: unknown, opts?: { legacy?: boolean }) => {
  const out = prepareTikTokArgs(name, args, opts) as { input: string };
  return JSON.parse(out.input) as Record<string, string>;
};
const input = (o: unknown) => ({ input: JSON.stringify(o) });
const ask = { advertiser_id: "7111111111111111111", start_date: "2026-09-01", end_date: "2026-09-20" };

describe("prepareTikTokArgs — reports", () => {
  it("completes a campaign report from the three things the model gives", () => {
    const out = sent("get_campaign_performance", input(ask));
    expect(out).toMatchObject({ ...ask, report_type: "BASIC", data_level: "AUCTION_CAMPAIGN", dimensions: '["campaign_id"]', page: "1", page_size: "1000" });
    const metrics = JSON.parse(out.metrics) as string[];
    expect(metrics).toEqual(expect.arrayContaining(["campaign_name", "spend", "conversion", "complete_payment", "complete_payment_roas"]));
    // Every value is a string: the n8n tool rejects anything else.
    for (const v of Object.values(out)) expect(typeof v).toBe("string");
  });

  it("sets the level of each shortcut, whatever the model guessed", () => {
    const guessed = { ...ask, report_type: "AUDIENCE", data_level: "AUCTION_AD", dimensions: '["ad_id"]', metrics: '["spend"]' };
    expect(sent("get_campaign_performance", input(guessed))).toMatchObject({ report_type: "BASIC", data_level: "AUCTION_CAMPAIGN", dimensions: '["campaign_id"]' });
    expect(sent("get_adgroup_performance", input(guessed))).toMatchObject({ data_level: "AUCTION_ADGROUP", dimensions: '["adgroup_id"]' });
    expect(sent("get_ad_performance", input(ask))).toMatchObject({ data_level: "AUCTION_AD", dimensions: '["ad_id"]' });
    expect(JSON.parse(sent("get_ad_performance", input(guessed)).metrics)).toContain("ad_name");
  });

  it("keeps the page asked for, and nothing that is not a page", () => {
    expect(sent("get_ad_performance", input({ ...ask, page: 3 })).page).toBe("3");
    expect(sent("get_ad_performance", input({ ...ask, page: "2" })).page).toBe("2");
    for (const page of ["0", "-1", "1.5", "deux", null, "99999"]) expect(sent("get_ad_performance", input({ ...ask, page })).page).toBe("1");
    expect(sent("get_ad_performance", input({ ...ask, page_size: "5000" })).page_size).toBe("1000");
    expect(sent("get_ad_performance", input({ ...ask, page_size: 200 })).page_size).toBe("200");
  });

  it("leaves the breakdown to the model, in the form the tool takes", () => {
    expect(sent("get_breakdown_report", input({ ...ask, dimensions: ["campaign_id", "age"] })).dimensions).toBe('["campaign_id","age"]');
    expect(sent("get_breakdown_report", input({ ...ask, dimensions: '["campaign_id","gender"]' })).dimensions).toBe('["campaign_id","gender"]');
    expect(sent("get_breakdown_report", input({ ...ask, dimensions: "campaign_id, country_code" })).dimensions).toBe('["campaign_id","country_code"]');
    const out = sent("get_breakdown_report", input({ ...ask, dimensions: ["campaign_id", "age"], metrics: ["balance"] }));
    expect(out.data_level).toBe("AUCTION_CAMPAIGN");
    expect(JSON.parse(out.metrics)).not.toContain("balance");
    // Without a breakdown there is nothing to send: TikTok says what is missing.
    expect("dimensions" in sent("get_breakdown_report", input(ask))).toBe(false);
  });

  it("the free report keeps the model's level, dimensions and metrics", () => {
    const out = sent("get_report_integrated", input({ ...ask, data_level: "auction_advertiser", dimensions: ["advertiser_id", "stat_time_day"], metrics: ["spend", "conversion"] }));
    expect(out).toMatchObject({ report_type: "BASIC", data_level: "AUCTION_ADVERTISER", dimensions: '["advertiser_id","stat_time_day"]', metrics: '["spend","conversion"]', page: "1", page_size: "1000" });
  });
});

describe("prepareTikTokArgs — the other tools", () => {
  it("turns advertiser_id into the array get_advertiser_info takes", () => {
    expect(sent("get_advertiser_info", input({ advertiser_id: "7111111111111111111" }))).toEqual({ advertiser_ids: '["7111111111111111111"]' });
    expect(sent("get_advertiser_info", input({ advertiser_ids: ["7111111111111111111"] }))).toEqual({ advertiser_ids: '["7111111111111111111"]' });
    expect(sent("get_advertiser_info", input({ advertiser_ids: '["7111111111111111111"]' }))).toEqual({ advertiser_ids: '["7111111111111111111"]' });
  });

  it("keeps a malformed list as it came, for the scope check to refuse", () => {
    expect(sent("get_advertiser_info", input({ advertiser_ids: '["7999999999999999999"' })).advertiser_ids).toBe('["7999999999999999999"');
  });

  it("gives an empty filter when none is asked", () => {
    expect(sent("get_adgroups", input({ advertiser_id: "7111111111111111111" }))).toEqual({ advertiser_id: "7111111111111111111", filtering: "{}" });
    expect(sent("get_ads", input({ advertiser_id: "7111111111111111111", filtering: { adgroup_ids: ["1"] } })).filtering).toBe('{"adgroup_ids":["1"]}');
    expect(sent("get_ads", input({ advertiser_id: "7111111111111111111", filtering: '{"adgroup_ids":["1"]}' })).filtering).toBe('{"adgroup_ids":["1"]}');
  });

  it("changes nothing in a tool it does not know", () => {
    expect(sent("get_campaigns", input({ advertiser_id: "7111111111111111111" }))).toEqual({ advertiser_id: "7111111111111111111" });
    expect(sent("search_ad_videos", input({ advertiser_id: "7111111111111111111" }))).toEqual({ advertiser_id: "7111111111111111111" });
  });
});

describe("prepareTikTokArgs — the shape of the call", () => {
  it("wraps arguments given without `input`, and reads an `input` given as an object", () => {
    expect(sent("get_campaigns", { advertiser_id: "7111111111111111111" })).toEqual({ advertiser_id: "7111111111111111111" });
    expect(sent("get_campaigns", { input: { advertiser_id: "7111111111111111111" } })).toEqual({ advertiser_id: "7111111111111111111" });
    expect(sent("get_campaign_performance", ask).data_level).toBe("AUCTION_CAMPAIGN");
  });

  it("sends plain arguments to a tool that no longer takes `input`", () => {
    expect(prepareTikTokArgs("get_campaigns", input({ advertiser_id: "7111111111111111111" }), { legacy: false })).toEqual({ advertiser_id: "7111111111111111111" });
    expect(prepareTikTokArgs("get_campaign_performance", ask, { legacy: false })).toMatchObject({ ...ask, data_level: "AUCTION_CAMPAIGN", page: "1" });
  });

  it("returns an unreadable call untouched", () => {
    for (const odd of [{ input: "{not json" }, { input: 12 }, { input: '"texte"' }, null, "texte", [1]]) {
      expect(prepareTikTokArgs("get_campaign_performance", odd)).toEqual(odd);
    }
  });
});

describe("describeTikTokTool", () => {
  const upstream =
    "SHORTCUT: performance by CAMPAIGN over a date range (max 30 days). Returns spend… Currency is the account currency.\n" +
    "Tool expects valid stringified JSON object with 9 properties.\nProperty names with description, type and required status:\n" +
    "advertiser_id: (description: TikTok advertiser ID, numeric string, type: string, required: true),\nreport_type: (description: , type: string, required: true)\n" +
    "ALL parameters marked as required must be provided";

  it("keeps the purpose, and lists only what the model must give", () => {
    const text = describeTikTokTool("get_campaign_performance", upstream);
    expect(text).toContain("SHORTCUT: performance by CAMPAIGN");
    expect(text).toContain("stringified JSON object"); // the form of the call, and what /api/tool looks for
    expect(text).toContain("advertiser_id (required)");
    expect(text).toContain("start_date, end_date (required");
    expect(text).not.toContain("report_type: (description: ,");
    expect(text).not.toContain("ALL parameters marked as required");
  });

  it("says how to get a daily series", () => {
    expect(describeTikTokTool("get_report_integrated", upstream)).toContain("stat_time_day");
  });

  it("leaves the other tools as they are", () => {
    expect(describeTikTokTool("get_campaigns", "List all campaigns.")).toBe("List all campaigns.");
    expect(describeTikTokTool("get_campaigns", undefined)).toBe("");
  });
});
