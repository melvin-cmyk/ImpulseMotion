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
let UNREADABLE: string;

beforeAll(async () => {
  // Importing the module must not open stdio or dial the upstream server.
  process.env.SCOPED_ADS_NO_LISTEN = "1";
  process.env.SCOPED_SERVER_NAME = "meta-ads-impulse";
  process.env.SCOPED_UPSTREAM_URL = "https://example.invalid/mcp/x/sse";
  process.env.SCOPED_ACCOUNTS = "111";
  ({ collectAccountIds, outOfScope, UNREADABLE } = await import("../../server/mcp-scoped-ads.mjs"));
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
    expect([...new Set(collectAccountIds(args, meta.keys))].sort()).toEqual(["2", "act_1"]);
  });

  it("takes for an id every value held under an account key, however it is wrapped", () => {
    // An object under an account key was walked for account KEYS only: its values went upstream unread.
    expect(collectAccountIds({ account_id: { v: "act_999" } }, meta.keys)).toEqual(["act_999"]);
    expect(collectAccountIds({ accounts: ["act_111", ["act_999"]] }, meta.keys).sort()).toEqual(["act_111", "act_999"]);
    expect(collectAccountIds({ account_ids: '["act_111","act_999"]' }, meta.keys).sort()).toEqual(["act_111", "act_999"]);
  });

  it("ignores unrelated parameters and malformed JSON", () => {
    expect(collectAccountIds({ fields: "id,name", gaql_query: "SELECT x" }, meta.keys)).toEqual([]);
    expect(collectAccountIds({ input: "{not json" }, meta.keys)).toEqual([]);
    expect(collectAccountIds(null, meta.keys)).toEqual([]);
  });

  it("reads as deep as a real call goes, and does not let through what is deeper", () => {
    let deep: Record<string, unknown> = { account_id: "act_999" };
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(collectAccountIds(deep, meta.keys)).toEqual(["act_999"]);
    expect(outOfScope({ account_id: [[[[["act_999"]]]]] }, meta, allowedMeta)).toEqual(["act_999"]);
    for (let i = 0; i < 60; i++) deep = { nested: deep };
    // Unread is not « no account »: the call is refused.
    expect(collectAccountIds(deep, meta.keys)).toEqual([UNREADABLE]);
    expect(outOfScope(deep, meta, allowedMeta)).toEqual([UNREADABLE]);
    let nested: unknown = "act_999";
    for (let i = 0; i < 60; i++) nested = [nested];
    expect(outOfScope({ account_id: nested }, meta, allowedMeta)).toEqual([UNREADABLE]);
  });

  it("lets through the nested arguments of a real call that names its own account", () => {
    // GA4 and Meta calls as the dashboards' assistants make them: the filters nest, inside `input`, inside a JSON string.
    const ga4: Profile = { keys: /propert/i, norm: (v) => String(v).trim().replace(/^properties\//i, "") };
    const filter = { and_group: { expressions: [{ filter: { field_name: "country", in_list_filter: { values: ["FR", "BE"] } } }, { not_expression: { filter: { field_name: "deviceCategory", string_filter: { value: "tablet" } } } }] } };
    const report = { property_id: "123456789", dimensions: ["date"], metrics: ["sessions"], dimension_filter: filter, order_bys: [{ dimension: { dimension_name: "date" }, desc: true }] };
    expect(outOfScope(report, ga4, new Set(["123456789"]))).toEqual([]);
    expect(outOfScope({ input: JSON.stringify({ ...report, dimension_filter: JSON.stringify(filter) }) }, ga4, new Set(["123456789"]))).toEqual([]);
    expect(outOfScope({ input: JSON.stringify({ ...report, property_id: "999" }) }, ga4, new Set(["123456789"]))).toEqual(["999"]);
    const metaCall = { input: JSON.stringify({ ad_account_id: "act_111", filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: ["1", "2"] }]), time_range: { since: "2026-09-01", until: "2026-09-07" } }) };
    expect(outOfScope(metaCall, meta, allowedMeta)).toEqual([]);
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

describe("the gate of a TikTok conversation", () => {
  type Decision = { refusal: string } | { args: { input: string } };
  type Gate = { isDenied: (name: string) => boolean; listed: (tools: Array<{ name: string; description?: string }>) => Array<{ name: string; description?: string }>; check: (name: string, given: unknown, opts?: { legacy?: boolean }) => Decision };
  let createGate: (profile: unknown, scope: { accounts: string; tools?: string }) => Gate;
  let tiktok: unknown;
  const ID = "7111111111111111111";
  const OTHER = "7999999999999999999";
  /** What the server adds to a list: the first page, at the size it shows whole. */
  const PAGE = { page: "1", page_size: "100" };
  const CLIENT_TOOLS = "get_advertiser_info,get_campaigns,get_adgroups,get_ads,get_campaign_performance,get_adgroup_performance,get_ad_performance,get_breakdown_report,get_report_integrated";
  const input = (o: unknown) => ({ input: JSON.stringify(o) });
  const gate = (accounts = ID, tools = CLIENT_TOOLS) => createGate(tiktok, { accounts, tools });
  /** What goes upstream, or the refusal. */
  const sent = (d: Decision) => ("args" in d ? (JSON.parse(d.args.input) as Record<string, string>) : null);
  const refused = (d: Decision) => ("refusal" in d ? d.refusal : null);

  beforeAll(async () => {
    const mod = await import("../../server/mcp-scoped-ads.mjs");
    createGate = mod.createGate as never;
    tiktok = mod.PROFILES["mcp-tiktok-ads"];
  });

  it("sends the allowed advertiser, as the object it read and completed", () => {
    expect(sent(gate().check("get_campaigns", input({ advertiser_id: ID })))).toEqual({ advertiser_id: ID, ...PAGE });
    const report = sent(gate().check("get_campaign_performance", input({ advertiser_id: ID, start_date: "2026-09-01", end_date: "2026-09-07" })));
    expect(report).toMatchObject({ advertiser_id: ID, report_type: "BASIC", data_level: "AUCTION_CAMPAIGN", page: "1" });
    expect(sent(gate().check("get_advertiser_info", input({ advertiser_id: ID })))).toEqual({ advertiser_ids: `["${ID}"]` });
    // "advertiser_id" as a DIMENSION is a value, not an account.
    expect(sent(gate().check("get_report_integrated", input({ advertiser_id: ID, data_level: "AUCTION_ADVERTISER", dimensions: ["advertiser_id", "stat_time_day"], metrics: ["spend"], start_date: "2026-09-01", end_date: "2026-09-07" })))).toMatchObject({ advertiser_id: ID });
  });

  it("refuses another advertiser, wherever the call puts it", () => {
    for (const [name, args] of [
      ["get_campaigns", input({ advertiser_id: OTHER })],
      ["get_campaign_performance", input({ advertiser_id: OTHER, start_date: "2026-09-01", end_date: "2026-09-07" })],
      ["get_advertiser_info", input({ advertiser_id: OTHER })],
      ["get_advertiser_info", input({ advertiser_ids: `["${OTHER}"]` })],
      ["get_advertiser_info", input({ advertiser_ids: [ID, OTHER] })],
      ["get_campaigns", { advertiser_id: OTHER }],
      ["get_campaigns", { input: { advertiser_id: OTHER } }],
      // The allowed account at the first level, another one further down.
      ["get_adgroups", input({ advertiser_id: ID, filtering: { advertiser_id: OTHER } })],
      ["get_adgroups", input({ advertiser_id: ID, filtering: `{"advertiser_ids":["${OTHER}"]}` })],
    ] as Array<[string, unknown]>) {
      expect(refused(gate().check(name, args)), `${name} ${JSON.stringify(args)}`).toContain("n'est pas dans ton périmètre");
    }
  });

  it("is not fooled by a neighbour of `input` that names the allowed account", () => {
    // n8n reads `input`, and reads more than JSON: what cannot be read here is never left to it.
    const fenced = "```json\n{\"advertiser_id\":\"" + OTHER + "\"}\n```";
    for (const args of [
      { input: fenced, advertiser_id: ID },
      { input: `{advertiser_id:'${OTHER}',start_date:'2026-09-01',end_date:'2026-09-07'}`, advertiser_id: ID },
      { input: OTHER, advertiser_id: ID },
      { input: JSON.stringify({ advertiser_name: ID }) },
      { advertiser_id: [[[[[OTHER]]]]], adv_advertiser: ID },
      { advertiser_id: { v: OTHER }, my_advertiser: ID },
    ]) {
      expect(refused(gate().check("get_campaigns", args)), JSON.stringify(args)).toBeTruthy();
    }
    // A readable `input` wins over its neighbours, which are not sent.
    const d = gate().check("get_campaigns", { input: JSON.stringify({ advertiser_id: ID }), advertiser_id: OTHER, note: "x" });
    expect(sent(d)).toEqual({ advertiser_id: ID, ...PAGE });
  });

  it("refuses a call that names no account — for an administrator too", () => {
    for (const g of [gate(), gate("*")]) {
      for (const args of [{}, input({}), undefined, null, input({ advertiser_id: "" }), input({ advertiser_id: 7111111111111111111 })]) {
        expect(refused(g.check("get_campaigns", args)), JSON.stringify(args)).toContain("Appel refusé");
      }
    }
    // An administrator reads any account that is named.
    expect(sent(gate("*").check("get_campaigns", input({ advertiser_id: OTHER })))).toEqual({ advertiser_id: OTHER, ...PAGE });
  });

  it("tolerates spaces around the allowed id, and sends it without them", () => {
    expect(sent(gate().check("get_campaigns", input({ advertiser_id: ` ${ID} ` })))).toEqual({ advertiser_id: ID, ...PAGE });
  });

  it("closes what lists every advertiser, what writes, and what is not on its list", () => {
    const g = gate();
    expect(refused(g.check("list_advertisers", input({ app_id: "x", secret: "y" })))).toContain("énumération");
    for (const name of ["create_campaign", "update_adgroup", "delete_ad", "upload_video", "Enable_campaign"]) expect(refused(g.check(name, input({ advertiser_id: ID })))).toContain("créent ou modifient");
    // Open to the team, not to the assistant of a client; and a tool added upstream tomorrow.
    for (const name of ["search_ad_videos", "search_ad_images", "list_custom_audiences", "get_pixels"]) {
      expect(refused(g.check(name, input({ advertiser_id: ID }))), name).toContain("pas ouvert dans cette conversation");
    }
    const staff = gate(ID, `${CLIENT_TOOLS},list_custom_audiences,search_ad_videos,search_ad_images`);
    expect(sent(staff.check("search_ad_videos", input({ advertiser_id: ID })))).toEqual({ advertiser_id: ID, page: "1", page_size: "40" });
    expect(refused(staff.check("get_pixels", input({ advertiser_id: ID })))).toContain("pas ouvert");
    // Even a list that names it cannot open the listing of every advertiser.
    expect(refused(gate(ID, "list_advertisers,get_campaigns").check("list_advertisers", {}))).toContain("énumération");
  });

  it("shows a conversation its open tools only, with what the model must really give", () => {
    const upstream = ["list_advertisers", "get_campaigns", "get_campaign_performance", "search_ad_videos", "create_campaign", "get_pixels"].map((name) => ({
      name, description: `What ${name} does.\nTool expects valid stringified JSON object with 9 properties.\nreport_type: (description: , type: string, required: true)`,
    }));
    const shown = gate().listed(upstream);
    expect(shown.map((t) => t.name)).toEqual(["get_campaigns", "get_campaign_performance"]);
    expect(shown[1].description).toContain("start_date, end_date (required");
    expect(shown[1].description).not.toContain("report_type: (description: ,");
  });

  it("takes `*` for every account only when it is the whole scope", () => {
    expect(refused(gate(`${ID},*`).check("get_campaigns", input({ advertiser_id: OTHER })))).toContain("n'est pas dans ton périmètre");
  });

  it("does not exist without its list of tools", () => {
    // Without a list every tool of the upstream server would be open, tomorrow's included.
    for (const tools of ["", " ", ",", " , ,"]) expect(() => createGate(tiktok, { accounts: ID, tools }), JSON.stringify(tools)).toThrow(/liste d'outils/);
    expect(() => createGate(tiktok, { accounts: ID })).toThrow(/liste d'outils/);
  });

  it("sends the parameters the tool declares, and nothing else the model wrote", () => {
    const d = gate().check("get_campaigns", input({ advertiser_id: ID, advertiser_name: "Client Démo", note: "x", secret: "y" }));
    expect(sent(d)).toEqual({ advertiser_id: ID, ...PAGE });
    const report = gate().check("get_report_integrated", input({ advertiser_id: ID, data_level: "AUCTION_CAMPAIGN", dimensions: ["campaign_id"], metrics: ["spend"], start_date: "2026-09-01", end_date: "2026-09-07", filtering: { campaign_ids: ["1"] }, extra: "&advertiser_id=" + OTHER }));
    expect(Object.keys(sent(report)!).sort()).toEqual(["advertiser_id", "data_level", "dimensions", "end_date", "metrics", "page", "page_size", "report_type", "start_date"]);
  });

  it("refuses a parameter that is not what its name says", () => {
    const base = { advertiser_id: ID, data_level: "AUCTION_CAMPAIGN", dimensions: ["campaign_id"], metrics: ["spend"], start_date: "2026-09-01", end_date: "2026-09-07" };
    for (const over of [
      { start_date: `2026-09-01&advertiser_id=${OTHER}` }, { end_date: "hier" }, { end_date: 20260907 }, { data_level: `AUCTION_AD&advertiser_id=${OTHER}` },
      { dimensions: `campaign_id&advertiser_id=${OTHER}` }, { dimensions: [`campaign_id"],"advertiser_id":"${OTHER}`] }, { metrics: ["spend; drop"] }, { metrics: "[spend" }, { dimensions: [] },
    ]) {
      expect(refused(gate().check("get_report_integrated", input({ ...base, ...over }))), JSON.stringify(over)).toContain("Appel refusé");
    }
    for (const filtering of ["{campaign_ids:['1']}", "texte", 12, ["x"]]) {
      expect(refused(gate().check("get_adgroups", input({ advertiser_id: ID, filtering }))), JSON.stringify(filtering)).toContain("filtering est un objet JSON");
    }
  });
});

describe("the gate of the other servers", () => {
  type Decision = { refusal: string } | { args: unknown };
  let createGate: (profile: unknown, scope: { accounts: string; tools?: string }) => { check: (name: string, given: unknown, opts?: { legacy?: boolean }) => Decision };
  let profiles: Record<string, unknown>;
  beforeAll(async () => {
    const mod = await import("../../server/mcp-scoped-ads.mjs");
    createGate = mod.createGate as never;
    profiles = mod.PROFILES as never;
  });

  it("sends a call as it came when its account is allowed", () => {
    const g = createGate(profiles["meta-ads-impulse"], { accounts: "111,222" });
    const args = { input: '{"ad_account_id":"act_111","date_preset":"last_7d"}' };
    expect(g.check("Campaign_Performance1", args)).toEqual({ args });
    expect("refusal" in g.check("Campaign_Performance1", { input: '{"ad_account_id":"act_999"}' })).toBe(true);
    expect("refusal" in g.check("List_Ad_Accounts1", {})).toBe(true);
  });

  it("refuses an `input` it cannot read, which n8n would still act on", () => {
    // Already true before TikTok: object notation went upstream unchecked.
    const g = createGate(profiles["meta-ads-impulse"], { accounts: "111" });
    for (const loose of ["{ad_account_id: 'act_999'}", "```json\n{\"ad_account_id\":\"act_999\"}\n```", "act_999", '["act_999"]', 12]) {
      const d = g.check("Campaign_Performance1", { input: loose });
      expect("refusal" in d && d.refusal, String(loose)).toContain("JSON strict");
    }
    // A tool that takes its parameters one by one is not concerned, nor is an empty input.
    expect("args" in g.check("Campaign_Performance1", { input: "texte libre", ad_account_id: "act_111" }, { legacy: false })).toBe(true);
    expect("args" in g.check("Account_Overview1", { input: "" })).toBe(true);
  });

  it("leaves an administrator's calls untouched", () => {
    const g = createGate(profiles["mcp-google-ads"], { accounts: "*" });
    const args = { input: "{customer_id: '999'}" };
    expect(g.check("Campaign_Performance", args)).toEqual({ args });
    // …but never what writes.
    expect("refusal" in g.check("Create_Conversion_Action", args)).toBe(true);
  });
});

describe("a JSON array carried as a string, on the other servers", () => {
  it("is read item by item for Meta too", () => {
    expect(outOfScope({ account_ids: '["act_111","act_222"]' }, meta, allowedMeta)).toEqual([]);
    expect(outOfScope({ account_ids: '["act_111","act_999"]' }, meta, allowedMeta)).toEqual(["act_999"]);
  });
});
