/**
 * Arguments of the TikTok tools as the scope proxy sends them upstream
 * (server/mcp-tiktok-args.mjs). The n8n flow asks the model for parameters it
 * was meant to fix itself (measured on 2026-09-30: a report without
 * report_type, data_level, dimensions, metrics, page, page_size never reaches
 * TikTok); the server sets them, and says so in the tool description.
 *
 * The call is read as strict JSON and only the object read is sent: n8n reads
 * more than JSON, and would act on what this module could not check.
 */
import { describe, expect, it } from "vitest";
import { accountsOfTikTokCall, describeTikTokTool, prepareTikTokArgs } from "../../server/mcp-tiktok-args.mjs";

type Prepared = { object: Record<string, string>; args: { input: string } };
const prepared = (name: string, args: unknown, opts?: { legacy?: boolean }) => {
  const out = prepareTikTokArgs(name, args, opts);
  if ("error" in out) throw new Error(`refused: ${out.error}`);
  return out as unknown as Prepared;
};
/** What n8n receives: the object carried by `input`. */
const sent = (name: string, args: unknown) => JSON.parse(prepared(name, args).args.input) as Record<string, string>;
const input = (o: unknown) => ({ input: JSON.stringify(o) });
const ID = "7111111111111111111";
const OTHER = "7999999999999999999";
const ask = { advertiser_id: ID, start_date: "2026-09-01", end_date: "2026-09-20" };

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
    // Without a breakdown there is nothing to ask TikTok: said at once, in words the model can act on.
    const none = prepareTikTokArgs("get_breakdown_report", input(ask));
    expect("error" in none && none.error).toContain("dimensions est un tableau JSON");
  });

  it("asks TikTok for the kind of report the dimensions belong to", () => {
    // Ids and time are a BASIC report; age, gender, country, placement… an AUDIENCE one.
    expect(sent("get_breakdown_report", input({ ...ask, dimensions: ["campaign_id", "age"] })).report_type).toBe("AUDIENCE");
    expect(sent("get_breakdown_report", input({ ...ask, dimensions: ["campaign_id", "stat_time_day"] })).report_type).toBe("BASIC");
    expect(sent("get_report_integrated", input({ ...ask, data_level: "AUCTION_ADVERTISER", dimensions: ["advertiser_id", "stat_time_day"], metrics: ["spend"] })).report_type).toBe("BASIC");
    expect(sent("get_report_integrated", input({ ...ask, data_level: "AUCTION_CAMPAIGN", dimensions: ["campaign_id", "gender"], metrics: ["spend"], report_type: "BASIC" })).report_type).toBe("AUDIENCE");
  });

  it("the free report keeps the model's level, dimensions and metrics", () => {
    const out = sent("get_report_integrated", input({ ...ask, data_level: "auction_advertiser", dimensions: ["advertiser_id", "stat_time_day"], metrics: ["spend", "conversion"] }));
    expect(out).toMatchObject({ report_type: "BASIC", data_level: "AUCTION_ADVERTISER", dimensions: '["advertiser_id","stat_time_day"]', metrics: '["spend","conversion"]', page: "1", page_size: "1000" });
  });
});

describe("prepareTikTokArgs — the other tools", () => {
  it("turns advertiser_id into the array get_advertiser_info takes", () => {
    expect(sent("get_advertiser_info", input({ advertiser_id: ID }))).toEqual({ advertiser_ids: `["${ID}"]` });
    expect(sent("get_advertiser_info", input({ advertiser_ids: [ID] }))).toEqual({ advertiser_ids: `["${ID}"]` });
    expect(sent("get_advertiser_info", input({ advertiser_ids: `["${ID}"]` }))).toEqual({ advertiser_ids: `["${ID}"]` });
    expect(sent("get_advertiser_info", input({ advertiser_ids: ` ${ID} ` }))).toEqual({ advertiser_ids: `["${ID}"]` });
  });

  it("gives an empty filter when none is asked", () => {
    expect(sent("get_adgroups", input({ advertiser_id: ID }))).toEqual({ advertiser_id: ID, filtering: "{}" });
    expect(sent("get_ads", input({ advertiser_id: ID, filtering: { adgroup_ids: ["1"] } })).filtering).toBe('{"adgroup_ids":["1"]}');
    expect(sent("get_ads", input({ advertiser_id: ID, filtering: '{"adgroup_ids":["1"]}' })).filtering).toBe('{"adgroup_ids":["1"]}');
  });

  it("changes nothing in a tool it has nothing to add to, but the spaces around the id", () => {
    expect(sent("get_campaigns", input({ advertiser_id: ID }))).toEqual({ advertiser_id: ID });
    expect(sent("search_ad_videos", input({ advertiser_id: ` ${ID}\n` }))).toEqual({ advertiser_id: ID });
  });
});

describe("prepareTikTokArgs — only what was read is sent", () => {
  it("wraps arguments given without `input`, and reads an `input` given as an object", () => {
    expect(sent("get_campaigns", { advertiser_id: ID })).toEqual({ advertiser_id: ID });
    expect(sent("get_campaigns", { input: { advertiser_id: ID } })).toEqual({ advertiser_id: ID });
    expect(sent("get_campaign_performance", ask).data_level).toBe("AUCTION_CAMPAIGN");
  });

  it("sends plain arguments to a tool that no longer takes `input`", () => {
    expect(prepared("get_campaigns", input({ advertiser_id: ID }), { legacy: false }).args).toEqual({ advertiser_id: ID });
    expect(prepared("get_campaign_performance", ask, { legacy: false }).args).toMatchObject({ ...ask, data_level: "AUCTION_CAMPAIGN", page: "1" });
  });

  it("refuses an `input` that is not a strict JSON object — n8n would still read it", () => {
    const loose = [
      "```json\n{\"advertiser_id\":\"" + OTHER + "\"}\n```", // a fenced block
      `{advertiser_id: '${OTHER}'}`, // object notation
      `{"advertiser_id":"${OTHER}",}`, // trailing comma
      OTHER, // a bare value: n8n gives it to the one parameter of the tool
      `"${OTHER}"`, `["${OTHER}"]`, "{not json", "", "   ", 12, true, [OTHER],
    ];
    for (const value of loose) {
      // With or without a neighbour that names the allowed account: `input` is what n8n reads.
      for (const args of [{ input: value }, { input: value, advertiser_id: ID }]) {
        const out = prepareTikTokArgs("get_campaigns", args);
        expect("error" in out, JSON.stringify(args)).toBe(true);
      }
    }
    for (const odd of ["texte", 12, [1]]) expect("error" in prepareTikTokArgs("get_campaigns", odd)).toBe(true);
  });

  it("never sends a neighbour of `input`: only `input` counts when it is given", () => {
    const out = prepared("get_campaigns", { input: JSON.stringify({ advertiser_id: OTHER }), advertiser_id: ID, extra: "x" });
    expect(out.object).toEqual({ advertiser_id: OTHER });
    expect(Object.keys(out.args)).toEqual(["input"]);
    expect(out.args.input).not.toContain(ID);
  });

  it("an empty call is an empty object, for the account check to refuse", () => {
    for (const none of [undefined, null, {}, { input: null }]) expect(prepared("get_campaigns", none).object).toEqual({});
  });
});

describe("accountsOfTikTokCall — the account a call names", () => {
  const named = (name: string, args: unknown) => {
    const p = prepareTikTokArgs(name, args);
    return "error" in p ? p : accountsOfTikTokCall(name, p.object);
  };

  it("reads advertiser_id where TikTok reads it", () => {
    expect(named("get_campaigns", input({ advertiser_id: ID }))).toEqual({ ids: [ID] });
    expect(named("get_campaign_performance", input(ask))).toEqual({ ids: [ID] });
    expect(named("get_advertiser_info", input({ advertiser_id: ID }))).toEqual({ ids: [ID] });
    expect(named("get_advertiser_info", input({ advertiser_ids: [ID, OTHER] }))).toEqual({ ids: [ID, OTHER] });
  });

  it("refuses a call that names no account, or names it elsewhere", () => {
    for (const args of [
      {}, input({}), input({ advertiser_id: "" }), input({ advertiser_id: "  " }), input({ advertiser_name: ID }), input({ adv_advertiser: ID }),
      input({ filtering: { advertiser_id: ID } }), input({ advertiser_id: { v: ID } }), input({ advertiser_id: [ID] }), input({ advertiser_id: [[[[[ID]]]]] }),
    ]) {
      expect("error" in named("get_campaigns", args), JSON.stringify(args)).toBe(true);
    }
    for (const args of [input({}), input({ advertiser_ids: "[]" }), input({ advertiser_ids: { x: ID } }), input({ advertiser_ids: `["${ID}"` }), input({ advertiser_ids: [[ID]] })]) {
      expect("error" in named("get_advertiser_info", args), JSON.stringify(args)).toBe(true);
    }
  });

  it("refuses an id that is not a string of digits", () => {
    for (const odd of [`${OTHER}.0`, `+${OTHER}`, `${ID},${OTHER}`, `["${OTHER}"]`, "act_123456", "123", "1".repeat(26)]) {
      expect("error" in named("get_campaigns", input({ advertiser_id: odd })), odd).toBe(true);
    }
  });

  it("refuses an id written as a number: its last digits are already lost", () => {
    const out = named("get_campaigns", { input: `{"advertiser_id": ${ID}}` });
    expect("error" in out && out.error).toContain("entre guillemets");
    expect("error" in named("get_advertiser_info", { input: `{"advertiser_ids": [${ID}]}` })).toBe(true);
    expect("error" in named("get_advertiser_info", { input: `{"advertiser_id": ${ID}}` })).toBe(true);
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
    expect(text).toContain("advertiser_id (required");
    expect(text).toContain("in double quotes"); // a number of 19 digits is rounded on the way
    expect(text).toContain("start_date, end_date (required");
    expect(text).not.toContain("report_type: (description: ,");
    expect(text).not.toContain("ALL parameters marked as required");
  });

  it("says how to get a daily series", () => {
    expect(describeTikTokTool("get_report_integrated", upstream)).toContain("stat_time_day");
  });

  it("says of every open tool that the id goes in quotes, and leaves an unknown tool as it is", () => {
    for (const name of ["get_advertiser_info", "get_campaigns", "get_adgroups", "get_ads", "list_custom_audiences", "search_ad_videos", "search_ad_images", "get_breakdown_report"]) {
      expect(describeTikTokTool(name, "What it does."), name).toContain("in double quotes");
    }
    expect(describeTikTokTool("get_pixels", "List pixels.")).toBe("List pixels.");
    expect(describeTikTokTool("get_pixels", undefined)).toBe("");
  });
});
