/**
 * The account-scope check of server/mcp-scoped-ads.mjs.
 *
 * This is the only technical control standing between a chat message and the
 * agency's whole business manager: the n8n MCP servers talk to every account
 * through the shared System User token, and before this proxy the restriction
 * was a paragraph of the system prompt — which a prompt injection ignores.
 */
import { describe, it, expect, beforeAll } from "vitest";

type Profile = { keys: RegExp; norm: (v: string) => string };

let collectAccountIds: (v: unknown, keys: RegExp) => string[];
let outOfScope: (args: unknown, p: Profile, allowed: Set<string>) => string[];

beforeAll(async () => {
  // Importing the module must not open stdio or dial the upstream server.
  process.env.SCOPED_ADS_NO_LISTEN = "1";
  process.env.SCOPED_SERVER_NAME = "meta-ads-impulse";
  process.env.SCOPED_UPSTREAM_URL = "https://example.invalid/mcp/x/sse";
  process.env.SCOPED_ACCOUNTS = "111";
  ({ collectAccountIds, outOfScope } = await import("../../server/mcp-scoped-ads.mjs"));
});

const meta: Profile = { keys: /account/i, norm: (v) => String(v).trim().replace(/^act_/i, "") };
const google: Profile = { keys: /customer/i, norm: (v) => String(v).trim().replace(/-/g, "").replace(/^0+/, "") };

const allowedMeta = new Set(["111", "222"]);

describe("collectAccountIds", () => {
  it("finds the id in a plain argument object", () => {
    expect(collectAccountIds({ ad_account_id: "act_111", limit: "100" }, meta.keys)).toEqual(["act_111"]);
  });

  it("looks inside stringified JSON — n8n tools take a serialised object", () => {
    // Without this, {"input":"{\"ad_account_id\":\"act_999\"}"} walked straight past.
    expect(collectAccountIds({ input: '{"ad_account_id":"act_999"}' }, meta.keys)).toEqual(["act_999"]);
  });

  it("finds ids nested in objects and arrays", () => {
    const args = { filters: [{ accounts: [{ accountId: "act_1" }] }, { account_id: 2 }] };
    expect(collectAccountIds(args, meta.keys).sort()).toEqual(["2", "act_1"]);
  });

  it("ignores unrelated parameters and malformed JSON", () => {
    expect(collectAccountIds({ fields: "id,name", gaql_query: "SELECT x" }, meta.keys)).toEqual([]);
    expect(collectAccountIds({ input: "{not json" }, meta.keys)).toEqual([]);
    expect(collectAccountIds(null, meta.keys)).toEqual([]);
  });

  it("stops recursing on deeply nested input", () => {
    let deep: Record<string, unknown> = { account_id: "act_999" };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(collectAccountIds(deep, meta.keys)).toEqual([]);
  });
});

describe("outOfScope", () => {
  it("lets an assigned account through, with or without the act_ prefix", () => {
    expect(outOfScope({ ad_account_id: "act_111" }, meta, allowedMeta)).toEqual([]);
    expect(outOfScope({ ad_account_id: "111" }, meta, allowedMeta)).toEqual([]);
  });

  it("refuses an account outside the scope", () => {
    expect(outOfScope({ ad_account_id: "act_999" }, meta, allowedMeta)).toEqual(["act_999"]);
  });

  it("refuses it even when smuggled through a serialised payload", () => {
    expect(outOfScope({ input: '{"ad_account_id":"act_999"}' }, meta, allowedMeta)).toEqual(["act_999"]);
  });

  it("refuses the whole call when one id among several is out of scope", () => {
    const args = { accounts: ["act_111", "act_999"], ad_account_id: "act_222" };
    expect(outOfScope(args, meta, allowedMeta)).toEqual(["act_999"]);
  });

  it("reports each offending id once", () => {
    const args = { a_account: "act_999", b_account: "act_999" };
    expect(outOfScope(args, meta, allowedMeta)).toEqual(["act_999"]);
  });

  it("ignores empty values rather than rejecting on a placeholder", () => {
    expect(outOfScope({ ad_account_id: "" }, meta, allowedMeta)).toEqual([]);
    expect(outOfScope({}, meta, allowedMeta)).toEqual([]);
  });

  it("normalises Google customer ids (dashes, leading zeros)", () => {
    const allowed = new Set(["4768893847"]);
    expect(outOfScope({ customer_id: "476-889-3847" }, google, allowed)).toEqual([]);
    expect(outOfScope({ customer_id: "04768893847" }, google, allowed)).toEqual([]);
    expect(outOfScope({ login_customer_id: "1234567890" }, google, allowed)).toEqual(["1234567890"]);
  });

  it("an empty scope refuses everything (fail-closed)", () => {
    expect(outOfScope({ ad_account_id: "act_111" }, meta, new Set())).toEqual(["act_111"]);
  });
});

describe("TikTok Ads — advertiser ids", () => {
  type Full = Profile & { requireId?: boolean; deny: Set<string>; denyPattern?: RegExp; prepare?: (n: string, a: unknown, o?: { legacy?: boolean }) => unknown };
  let tiktok: Full;
  let namesAnAccount: (args: unknown, p: Profile) => boolean;
  const allowed = new Set(["7111111111111111111"]);
  const input = (o: unknown) => ({ input: JSON.stringify(o) });

  beforeAll(async () => {
    const mod = await import("../../server/mcp-scoped-ads.mjs");
    tiktok = mod.PROFILES["mcp-tiktok-ads"] as Full;
    namesAnAccount = mod.namesAnAccount;
  });

  it("lets the assigned advertiser through, in the serialised form n8n expects", () => {
    expect(outOfScope(input({ advertiser_id: "7111111111111111111" }), tiktok, allowed)).toEqual([]);
  });

  it("refuses another advertiser", () => {
    expect(outOfScope(input({ advertiser_id: "7999999999999999999" }), tiktok, allowed)).toEqual(["7999999999999999999"]);
  });

  it("reads advertiser_ids, a JSON array carried as a string", () => {
    // Taken whole, the string `["7999…"]` was one unknown "id": refused for the
    // wrong reason, and let through by any profile that ignores what is not an id.
    expect(outOfScope(input({ advertiser_ids: '["7111111111111111111"]' }), tiktok, allowed)).toEqual([]);
    expect(outOfScope(input({ advertiser_ids: '["7111111111111111111","7999999999999999999"]' }), tiktok, allowed)).toEqual(["7999999999999999999"]);
    expect(outOfScope(input({ advertiser_ids: ["7111111111111111111", ["7999999999999999999"]] }), tiktok, allowed)).toEqual(["7999999999999999999"]);
  });

  it("refuses an id that is not written as the allowed one, rather than ignoring it", () => {
    for (const odd of ["7999999999999999999.0", "+7999999999999999999", "07111111111111111111", "7111111111111111111,7999999999999999999", '["7999999999999999999"']) {
      expect(outOfScope(input({ advertiser_id: odd }), tiktok, allowed)).toEqual([odd]);
    }
  });

  it("tolerates spaces around the allowed id", () => {
    expect(outOfScope(input({ advertiser_id: " 7111111111111111111 " }), tiktok, allowed)).toEqual([]);
  });

  it("asks every call to name an advertiser", () => {
    expect(tiktok.requireId).toBe(true);
    expect(namesAnAccount(input({ advertiser_id: "7111111111111111111" }), tiktok)).toBe(true);
    expect(namesAnAccount(input({ advertiser_ids: '["7111111111111111111"]' }), tiktok)).toBe(true);
    for (const none of [{}, input({}), input({ advertiser_id: "" }), input({ advertiser_id: "  " }), input({ advertiser_ids: "[]" }), input({ advertiser_ids: { x: "7999999999999999999" } }), { input: "{not json" }, null]) {
      expect(namesAnAccount(none, tiktok)).toBe(false);
    }
  });

  it("closes the tool that lists every advertiser, and anything that writes", () => {
    expect(tiktok.deny.has("list_advertisers")).toBe(true);
    for (const name of ["create_campaign", "update_adgroup", "delete_ad", "upload_video", "Enable_campaign"]) expect(tiktok.denyPattern?.test(name)).toBe(true);
    for (const name of ["get_campaigns", "get_report_integrated", "search_ad_videos", "list_custom_audiences"]) expect(tiktok.denyPattern?.test(name)).toBe(false);
  });

  it("checks what is really sent: the arguments completed by the server still carry the id", () => {
    const sent = tiktok.prepare!("get_advertiser_info", input({ advertiser_id: "7999999999999999999" }));
    expect(outOfScope(sent, tiktok, allowed)).toEqual(["7999999999999999999"]);
    const report = tiktok.prepare!("get_campaign_performance", input({ advertiser_id: "7999999999999999999", start_date: "2026-09-01", end_date: "2026-09-07" }));
    expect(outOfScope(report, tiktok, allowed)).toEqual(["7999999999999999999"]);
    // "advertiser_id" as a DIMENSION is a value, not an account.
    const daily = tiktok.prepare!("get_report_integrated", input({ advertiser_id: "7111111111111111111", data_level: "AUCTION_ADVERTISER", dimensions: ["advertiser_id", "stat_time_day"], metrics: ["spend"], start_date: "2026-09-01", end_date: "2026-09-07" }));
    expect(outOfScope(daily, tiktok, allowed)).toEqual([]);
  });
});

describe("a JSON array carried as a string, on the other servers", () => {
  it("is read item by item for Meta too", () => {
    expect(outOfScope({ account_ids: '["act_111","act_222"]' }, meta, allowedMeta)).toEqual([]);
    expect(outOfScope({ account_ids: '["act_111","act_999"]' }, meta, allowedMeta)).toEqual(["act_999"]);
  });
});
