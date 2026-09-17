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
