import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No real call: fetch is a mock, and every request it receives is kept to be inspected.

const PRIMARY = "EAAprimaryTokenForTestsOnly000000000000000001";
const BACKUP = "EAAbackupTokenForTestsOnly0000000000000000002";
const ACCOUNT = "564381881705822";
const CAMPAIGN = "120233510168830703";
const ADSET = "120250524723890703";
const PAGE = "103591049029300";
const CREATIVE = "3281195995406081";
const AD = "120250524723910999";

interface Call { method: string; url: string; path: string; body: URLSearchParams | null; auth: string | null }

const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
const calls: Call[] = [];
type Reply = (call: Call) => Response | Promise<Response>;
let reply: Reply;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const metaError = (code: number, message: string, status = 400) => json({ error: { message, code, fbtrace_id: "trace" } }, status);
const timeout = () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; return e; };

const posts = () => calls.filter((c) => c.method === "POST");
const gets = () => calls.filter((c) => c.method === "GET");

/** Meta as it answers when everything goes well. */
const happy: Reply = (c) => {
  if (c.method === "GET" && c.path === `/${ADSET}`) return json({ id: ADSET, name: "Ensemble", account_id: ACCOUNT, campaign_id: CAMPAIGN, status: "ACTIVE" });
  if (c.method === "GET" && c.path === `/${AD}`) return json({ id: AD, status: "PAUSED", effective_status: "PAUSED", adset_id: ADSET });
  if (c.method === "GET" && c.path === `/${ADSET}/ads`) return json({ data: [] });
  if (c.method === "POST" && c.path === `/act_${ACCOUNT}/adcreatives`) return json({ id: CREATIVE });
  if (c.method === "POST" && c.path === `/act_${ACCOUNT}/ads`) return json({ id: AD, success: true });
  if (c.method === "POST" && c.path === `/${AD}`) return json({ success: true });
  return metaError(100, "Unsupported request");
};

async function load() {
  const api = await import("@/lib/meta-api");
  const write = await import("@/lib/meta-write");
  const { mintWriteGuard } = await import("@/lib/routines/write-guard");
  return { api, write, guard: mintWriteGuard("live", "run-test") };
}

const input = () => ({
  accountId: `act_${ACCOUNT}`, campaignId: CAMPAIGN, adsetId: ADSET, pageId: PAGE,
  name: "W40 - Visuel produit", primaryText: "Découvrez la nouvelle gamme.", headline: "Nouveau", description: "Livraison offerte",
  linkUrl: "https://www.example.org/produit?utm_source=meta", callToAction: "SHOP_NOW", imageUrl: "https://cdn.example.org/visuel.jpg",
});

/** The token must be nowhere a person or a log could read it. */
function expectNoToken(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  expect(text).not.toContain(PRIMARY);
  expect(text).not.toContain(BACKUP);
}

beforeEach(() => {
  vi.resetModules();
  process.env.META_SYSTEM_TOKEN = PRIMARY;
  process.env.META_SYSTEM_TOKEN_BACKUP = BACKUP;
  calls.length = 0;
  reply = happy;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (target, init) => {
    const url = String(target);
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      path: new URL(url).pathname.replace(/^\/v\d+\.\d+/, ""),
      body: init?.body instanceof URLSearchParams ? init.body : null,
      auth: headers.get("authorization"),
    };
    calls.push(call);
    return reply(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  try {
    // Whatever the test did, no URL and no log ever carried a token.
    for (const c of calls) expectNoToken(c.url);
    expectNoToken(vi.mocked(console.warn).mock.calls.flat().map(String).join(" "));
    expectNoToken(vi.mocked(console.error).mock.calls.flat().map(String).join(" "));
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.META_SYSTEM_TOKEN;
    delete process.env.META_SYSTEM_TOKEN_BACKUP;
  }
});

describe("createPausedAd — paused by construction", () => {
  it("creates the creative, then the ad with status=PAUSED, then reads it back", async () => {
    const { write, guard } = await load();
    const ad = await write.createPausedAd(guard, input());
    expect(ad).toEqual({ adId: AD, creativeId: CREATIVE, status: "PAUSED" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /${ADSET}`, `POST /act_${ACCOUNT}/adcreatives`, `POST /act_${ACCOUNT}/ads`, `GET /${AD}`,
    ]);

    const [creative, created] = posts();
    expect(created.body?.get("status")).toBe("PAUSED");
    expect(created.body?.get("adset_id")).toBe(ADSET);
    expect(JSON.parse(created.body?.get("creative") ?? "{}")).toEqual({ creative_id: CREATIVE });
    expect([...created.body!.keys()].sort()).toEqual(["access_token", "adset_id", "creative", "name", "status"]);

    expect([...creative.body!.keys()].sort()).toEqual(["access_token", "name", "object_story_spec"]);
    expect(JSON.parse(creative.body?.get("object_story_spec") ?? "{}")).toEqual({
      page_id: PAGE,
      link_data: {
        link: "https://www.example.org/produit?utm_source=meta",
        message: "Découvrez la nouvelle gamme.",
        picture: "https://cdn.example.org/visuel.jpg",
        name: "Nouveau",
        description: "Livraison offerte",
        call_to_action: { type: "SHOP_NOW", value: { link: "https://www.example.org/produit?utm_source=meta" } },
      },
    });
  });

  it("puts the token in the body of a POST and in a header for a read, never in a URL", async () => {
    const { write, guard } = await load();
    await write.createPausedAd(guard, { ...input(), instagramUserId: "17841428027695210" });
    for (const c of posts()) {
      expect(c.body?.get("access_token")).toBe(PRIMARY);
      expect(new URL(c.url).search).toBe("");
    }
    for (const c of gets()) {
      expect(c.auth).toBe(`Bearer ${PRIMARY}`);
      expect(new URL(c.url).searchParams.has("access_token")).toBe(false);
    }
    expect(JSON.parse(posts()[0].body?.get("object_story_spec") ?? "{}").instagram_user_id).toBe("17841428027695210");
  });

  it("never sends a status other than PAUSED, whatever is slipped in the input", async () => {
    const { write, guard } = await load();
    const forged = { ...input(), status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "5000", bid_amount: "100" };
    await write.createPausedAd(guard, forged as ReturnType<typeof input>);
    for (const c of posts()) {
      const status = c.body?.get("status");
      if (c.path.endsWith("/ads")) expect(status).toBe("PAUSED");
      else expect(status).toBeNull();
      const sent = [...c.body!.entries()].map(([k, v]) => `${k}=${v}`).join("&");
      expect(sent).not.toMatch(/ACTIVE|budget|bid_amount/);
    }
  });

  it("has no code path to another status, a budget or a deletion", () => {
    const root = path.resolve(__dirname, "../..");
    const write = readFileSync(path.join(root, "lib/meta-write.ts"), "utf8");
    const step = readFileSync(path.join(root, "lib/routines/steps/meta-create-ads.ts"), "utf8");
    const api = readFileSync(path.join(root, "lib/meta-api.ts"), "utf8");
    // The only place a status is written, and the only value it can take.
    expect(api.match(/body\.set\("status"[^)]*\)/g)).toEqual(['body.set("status", "PAUSED")']);
    for (const source of [write, step]) {
      expect(source).not.toMatch(/fetch\(/);
      expect(source).not.toMatch(/status["'`]?\s*[:=,]\s*["'`](ACTIVE|ARCHIVED|DELETED)/);
      expect(source).not.toMatch(/method:\s*["'`](DELETE|PUT|PATCH)/i);
      expect(source).not.toMatch(/daily_budget|lifetime_budget|bid_amount|bid_strategy/);
    }
    expect(api).not.toMatch(/method:\s*["'`](DELETE|PUT|PATCH)/i);
    // Writers hold no way to make a guard.
    expect(write).not.toMatch(/mintWriteGuard|routines\/write-guard["']/);
    expect(step).not.toMatch(/mintWriteGuard|routines\/write-guard["']/);
  });
});

describe("createPausedAd — write capability", () => {
  it("refuses without a guard minted by the engine, before any request", async () => {
    const { write } = await load();
    const fakes = [null, undefined, {}, { runId: "run-test" }, Object.freeze({ runId: "run-test" }), "run-test"];
    for (const fake of fakes) {
      await expect(write.createPausedAd(fake as never, input())).rejects.toThrow(/Écriture refusée/);
    }
    expect(calls).toHaveLength(0);
  });

  it("metaGraphPost checks the guard itself", async () => {
    const { api } = await load();
    await expect(api.metaGraphPost({ runId: "x" } as never, { kind: "ad", accountId: ACCOUNT }, PRIMARY, { name: "a", adset_id: ADSET, creative: "{}" }))
      .rejects.toThrow(/Écriture refusée/);
    expect(calls).toHaveLength(0);
  });

  it("metaGraphPost knows three targets and their fields, nothing else", async () => {
    const { api, guard } = await load();
    const ad = { name: "a", adset_id: ADSET, creative: "{}" };
    const refused: Array<[unknown, Record<string, string>]> = [
      [{ kind: "ad", accountId: ACCOUNT }, { ...ad, status: "ACTIVE" }],
      [{ kind: "ad", accountId: ACCOUNT }, { ...ad, status: "PAUSED" }],
      [{ kind: "ad", accountId: ACCOUNT }, { ...ad, daily_budget: "1000" }],
      [{ kind: "ad", accountId: ACCOUNT }, { ...ad, bid_amount: "10" }],
      [{ kind: "ad", accountId: ACCOUNT }, { ...ad, access_token: "other" }],
      [{ kind: "ad", accountId: ACCOUNT }, { name: "a" }],
      [{ kind: "adcreative", accountId: ACCOUNT }, { name: "a", object_story_spec: "{}", status: "ACTIVE" }],
      [{ kind: "pause_ad", adId: AD }, { status: "ACTIVE" }],
      [{ kind: "pause_ad", adId: AD }, { name: "renamed" }],
      [{ kind: "pause_ad", adId: `${AD}/../act_1` }, {}],
      [{ kind: "ad", accountId: "act_1/../../me" }, ad],
      [{ kind: "campaign", accountId: ACCOUNT }, { name: "a" }],
      [{ kind: "delete_ad", adId: AD }, {}],
    ];
    for (const [target, fields] of refused) {
      await expect(api.metaGraphPost(guard, target as never, PRIMARY, fields)).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);

    await api.metaGraphPost(guard, { kind: "pause_ad", adId: AD }, PRIMARY);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/${AD}`);
    expect([...posts()[0].body!.entries()].sort()).toEqual([["access_token", PRIMARY], ["status", "PAUSED"]]);
  });
});

describe("createPausedAd — restricted account", () => {
  it.each([
    ["another account", { account_id: "111111111111111", campaign_id: CAMPAIGN }, /n'appartient pas au compte/],
    ["another campaign", { account_id: ACCOUNT, campaign_id: "120200000000000000" }, /n'appartient pas à la campagne/],
    ["no account in the answer", { campaign_id: CAMPAIGN }, /n'appartient pas au compte/],
  ])("refuses an ad set of %s without any POST", async (_label, adset, message) => {
    const { write, guard } = await load();
    reply = (c) => (c.path === `/${ADSET}` ? json({ id: ADSET, name: "Ensemble", ...adset }) : happy(c));
    await expect(write.createPausedAd(guard, input())).rejects.toMatchObject({ name: "MetaWriteError", kind: "refused", message: expect.stringMatching(message) });
    expect(posts()).toHaveLength(0);
  });

  it("refuses when the ad set cannot be read, without any POST", async () => {
    const { write, guard } = await load();
    reply = (c) => (c.path === `/${ADSET}` ? metaError(100, "Unsupported get request. Object with ID does not exist") : happy(c));
    await expect(write.createPausedAd(guard, input())).rejects.toMatchObject({ kind: "refused" });
    reply = (c) => { if (c.path === `/${ADSET}`) throw timeout(); return happy(c); };
    await expect(write.createPausedAd(guard, input())).rejects.toMatchObject({ kind: "infra" });
    expect(posts()).toHaveLength(0);
  });

  it("verifyAdsetInAccount accepts the account with or without act_", async () => {
    const { write } = await load();
    await expect(write.verifyAdsetInAccount(ACCOUNT, CAMPAIGN, ADSET)).resolves.toMatchObject({ adsetId: ADSET, accountId: `act_${ACCOUNT}` });
    await expect(write.verifyAdsetInAccount(`act_${ACCOUNT}`, CAMPAIGN, ADSET)).resolves.toMatchObject({ campaignId: CAMPAIGN });
    for (const bad of [["", CAMPAIGN, ADSET], [ACCOUNT, "{{row.campagne}}", ADSET], [ACCOUNT, CAMPAIGN, `${ADSET}?fields=x`], [ACCOUNT, CAMPAIGN, "me"]]) {
      const before = calls.length;
      await expect(write.verifyAdsetInAccount(bad[0], bad[1], bad[2])).rejects.toMatchObject({ kind: "refused" });
      expect(calls.length).toBe(before);
    }
  });
});

describe("createPausedAd — timeout, network, failover", () => {
  it.each([
    ["the creative", `/act_${ACCOUNT}/adcreatives`, 1],
    ["the ad", `/act_${ACCOUNT}/ads`, 2],
  ])("a timeout while creating %s leaves the outcome uncertain: no second POST, no failover", async (_label, failing, expectedPosts) => {
    const { write, guard } = await load();
    reply = (c) => { if (c.method === "POST" && c.path === failing) throw timeout(); return happy(c); };
    const err = await write.createPausedAd(guard, input()).catch((e) => e);
    expect(err).toMatchObject({ name: "MetaWriteError", kind: "uncertain" });
    expect(posts()).toHaveLength(expectedPosts);
    expect(posts().filter((c) => c.path === failing)).toHaveLength(1);
    for (const c of posts()) expect(c.body?.get("access_token")).toBe(PRIMARY);
    expectNoToken(err.message);
  });

  it("a network cut or a 5xx is uncertain too", async () => {
    const { write, guard } = await load();
    reply = (c) => { if (c.method === "POST") throw new TypeError("fetch failed"); return happy(c); };
    await expect(write.createPausedAd(guard, input())).rejects.toMatchObject({ kind: "uncertain" });
    expect(posts()).toHaveLength(1);

    calls.length = 0;
    reply = (c) => (c.method === "POST" ? new Response("<html>502</html>", { status: 502 }) : happy(c));
    await expect(write.createPausedAd(guard, input())).rejects.toMatchObject({ kind: "uncertain" });
    expect(posts()).toHaveLength(1);
    for (const c of posts()) expect(c.body?.get("access_token")).toBe(PRIMARY);
  });

  it("an answer without an id is uncertain", async () => {
    const { write, guard } = await load();
    reply = (c) => (c.method === "POST" && c.path.endsWith("/ads") ? json({ success: true }) : happy(c));
    await expect(write.createPausedAd(guard, input())).rejects.toMatchObject({ kind: "uncertain", creativeId: CREATIVE });
    expect(posts()).toHaveLength(2);
  });

  it.each([[190, "Invalid OAuth access token"], [4, "Application request limit reached"]])(
    "fails over to the backup token when Meta refuses the request (code %s): nothing was created", async (code, message) => {
      const { write, guard } = await load();
      reply = (c) => (c.method === "POST" && c.body?.get("access_token") === PRIMARY ? metaError(code, message) : happy(c));
      const ad = await write.createPausedAd(guard, input());
      expect(ad.status).toBe("PAUSED");
      expect(posts().map((c) => [c.path, c.body?.get("access_token")])).toEqual([
        [`/act_${ACCOUNT}/adcreatives`, PRIMARY],
        [`/act_${ACCOUNT}/adcreatives`, BACKUP],
        [`/act_${ACCOUNT}/ads`, BACKUP],
      ]);
      for (const c of posts().filter((p) => p.path.endsWith("/ads"))) expect(c.body?.get("status")).toBe("PAUSED");
    });

  it("does not retry a rate limit on the same token, and reports it as infra", async () => {
    const { write, guard } = await load();
    delete process.env.META_SYSTEM_TOKEN_BACKUP;
    reply = (c) => (c.method === "POST" ? metaError(17, "User request limit reached") : happy(c));
    await expect(write.createPausedAd(guard, input())).rejects.toMatchObject({ kind: "infra" });
    expect(posts()).toHaveLength(1);
  });

  it("a refusal by Meta is final: one POST, error cleaned", async () => {
    const { write, guard } = await load();
    reply = (c) => (c.method === "POST" ? metaError(100, "Invalid parameter: picture could not be downloaded") : happy(c));
    const err = await write.createPausedAd(guard, input()).catch((e) => e);
    expect(err).toMatchObject({ kind: "refused" });
    expect(err.message).toContain("picture could not be downloaded");
    expect(posts()).toHaveLength(1);
  });
});

describe("createPausedAd — read back", () => {
  it.each(["ACTIVE", "PENDING_REVIEW", undefined])("status read back %s: pause attempted, item failed with the ad id", async (status) => {
    const { write, guard } = await load();
    reply = (c) => (c.method === "GET" && c.path === `/${AD}` ? json({ id: AD, status }) : happy(c));
    const err = await write.createPausedAd(guard, input()).catch((e) => e);
    expect(err).toMatchObject({ name: "MetaWriteError", kind: "not_paused", adId: AD, creativeId: CREATIVE });
    const pause = posts().filter((c) => c.path === `/${AD}`);
    expect(pause).toHaveLength(1);
    expect([...pause[0].body!.entries()].sort()).toEqual([["access_token", PRIMARY], ["status", "PAUSED"]]);
    expect(posts()).toHaveLength(3);
  });

  it("read back impossible: pause attempted, never reported as created", async () => {
    const { write, guard } = await load();
    reply = (c) => { if (c.method === "GET" && c.path === `/${AD}`) throw timeout(); return happy(c); };
    await expect(write.createPausedAd(guard, input())).rejects.toMatchObject({ kind: "not_paused", adId: AD });
    expect(posts().filter((c) => c.path === `/${AD}`)).toHaveLength(1);
  });

  it("a pause that fails does not hide the first problem", async () => {
    const { write, guard } = await load();
    reply = (c) => {
      if (c.method === "GET" && c.path === `/${AD}`) return json({ id: AD, status: "ACTIVE" });
      if (c.method === "POST" && c.path === `/${AD}`) throw timeout();
      return happy(c);
    };
    const err = await write.createPausedAd(guard, input()).catch((e) => e);
    expect(err).toMatchObject({ kind: "not_paused", adId: AD });
    expect(err.message).toMatch(/sans confirmation/);
    expect(posts().filter((c) => c.path === `/${AD}`)).toHaveLength(1);
  });
});

describe("token never leaks", () => {
  it("is removed from a Meta message that echoes it", async () => {
    const { write, guard } = await load();
    reply = (c) => (c.method === "POST"
      ? metaError(100, `Invalid parameter access_token=${PRIMARY} for https://graph.facebook.com/v22.0/x?access_token=${BACKUP}&a=1`)
      : happy(c));
    const err = await write.createPausedAd(guard, input()).catch((e) => e);
    expectNoToken(err.message);
    expectNoToken(String(err.stack ?? ""));
    expectNoToken(JSON.stringify(err));
    expect(err.message).toContain("[masqué]");
  });

  it("cleanMetaMessage masks tokens, bearer headers and long messages", async () => {
    const { write } = await load();
    expect(write.cleanMetaMessage(`boom ${PRIMARY} end`)).toBe("boom [jeton] end");
    expect(write.cleanMetaMessage("Authorization: Bearer abc.DEF-123")).toBe("Authorization: Bearer [masqué]");
    expect(write.cleanMetaMessage("token EAAGm0PX4ZCpsBAOZBZCabcdefghijklmnopqrstuvwxyz0123 seen")).toBe("token [jeton] seen");
    expect(write.cleanMetaMessage('{"access_token":"abc123"}')).not.toContain("abc123");
    expect(write.cleanMetaMessage("x".repeat(1000)).length).toBeLessThanOrEqual(301);
    expect(write.cleanMetaMessage("Object does not exist. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api")).toBe("Object does not exist.");
  });

  it("stays out of a successful result", async () => {
    const { write, guard } = await load();
    expectNoToken(await write.createPausedAd(guard, input()));
    expectNoToken(await write.verifyAdsetInAccount(ACCOUNT, CAMPAIGN, ADSET));
  });
});

describe("links and media", () => {
  const refused = [
    "http://www.example.org/a.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://example.org/a.jpg", "file:///etc/passwd",
    "//example.org/a.jpg", "www.example.org/a.jpg", "", "   ",
    "https://127.0.0.1/a.jpg", "https://10.0.0.5/a.jpg", "https://192.168.1.10/a.jpg", "https://172.16.0.1/a.jpg", "https://169.254.169.254/latest/meta-data",
    "https://8.8.8.8/a.jpg", "https://2130706433/a.jpg", "https://0x7f000001/a.jpg", "https://017700000001/a.jpg", "https://[::1]/a.jpg", "https://[fd00::1]/a.jpg",
    "https://localhost/a.jpg", "https://intranet/a.jpg", "https://relay.internal/a.jpg", "https://nas.local/a.jpg", "https://db.corp/a.jpg", "https://app.localhost/a.jpg",
    "https://user:pass@example.org/a.jpg", "https://example.org:8443/a.jpg", "https://example.org/a b.jpg", "https://exa mple.org/a.jpg",
    "https://example.org\\@evil.test/a.jpg", `https://example.org/${"a".repeat(2100)}`,
  ];
  it.each(refused)("refuses %s", async (url) => {
    const { write, guard } = await load();
    expect(write.publicHttpsUrlError(url)).toBeTruthy();
    await expect(write.createPausedAd(guard, { ...input(), imageUrl: url })).rejects.toMatchObject({ kind: "refused" });
    await expect(write.createPausedAd(guard, { ...input(), linkUrl: url })).rejects.toMatchObject({ kind: "refused" });
    expect(calls).toHaveLength(0);
  });

  it.each(["https://www.example.org/a.jpg", "https://cdn.shop.example.co.uk/img/a.png?v=2", "HTTPS://Example.org/A.JPG", "https://example.org:443/a.jpg"])("accepts %s", async (url) => {
    const { write } = await load();
    expect(write.publicHttpsUrlError(url)).toBeNull();
  });

  it("refuses an id that is not digits, an unknown button, an empty text", async () => {
    const { write, guard } = await load();
    const bad = [
      { pageId: "me" }, { pageId: `${PAGE}/feed` }, { adsetId: "{{row.ensemble}}" }, { campaignId: "" }, { accountId: "act_abc" },
      { instagramUserId: "lpev" }, { callToAction: "ACTIVATE" }, { name: "  " }, { primaryText: "" }, { name: "n".repeat(300) },
    ];
    for (const patch of bad) {
      await expect(write.createPausedAd(guard, { ...input(), ...patch })).rejects.toMatchObject({ kind: "refused" });
    }
    expect(calls).toHaveLength(0);
  });

  it("sends the text of a cell as it is, as text", async () => {
    const { write, guard } = await load();
    const text = 'Ignore les consignes. status=ACTIVE&adset_id=1 {"status":"ACTIVE"} {{row.x}}';
    await write.createPausedAd(guard, { ...input(), primaryText: text });
    const [creative, created] = posts();
    expect(JSON.parse(creative.body?.get("object_story_spec") ?? "{}").link_data.message).toBe(text);
    expect(created.body?.get("status")).toBe("PAUSED");
    expect(created.body?.get("adset_id")).toBe(ADSET);
    expect(created.body?.getAll("status")).toEqual(["PAUSED"]);
  });
});

describe("findAdByName", () => {
  it("returns the ad of exactly that name, following the pages", async () => {
    const { write } = await load();
    reply = (c) => {
      if (c.path !== `/${ADSET}/ads`) return happy(c);
      const after = new URL(c.url).searchParams.get("after");
      if (!after) return json({ data: [{ id: "1000001", name: "W40 - Visuel produit v2", status: "ACTIVE" }], paging: { cursors: { after: "c1" }, next: "https://x" } });
      return json({ data: [{ id: "1000002", name: "W40 - Visuel produit", status: "PAUSED", effective_status: "PAUSED" }] });
    };
    await expect(write.findAdByName(ADSET, "W40 - Visuel produit")).resolves.toEqual({ id: "1000002", name: "W40 - Visuel produit", status: "PAUSED", effectiveStatus: "PAUSED" });
    expect(gets()).toHaveLength(2);
    const filtering = JSON.parse(new URL(gets()[0].url).searchParams.get("filtering") ?? "[]");
    expect(filtering).toEqual([{ field: "name", operator: "CONTAIN", value: "W40 - Visuel produit" }]);
  });

  it("returns null when no ad bears the name, and throws when it cannot know", async () => {
    const { write } = await load();
    reply = (c) => (c.path === `/${ADSET}/ads` ? json({ data: [{ id: "1000001", name: "W40 - Visuel produit v2" }] }) : happy(c));
    await expect(write.findAdByName(ADSET, "W40 - Visuel produit")).resolves.toBeNull();
    reply = () => { throw timeout(); };
    await expect(write.findAdByName(ADSET, "W40 - Visuel produit")).rejects.toMatchObject({ kind: "infra" });
    expect(posts()).toHaveLength(0);
  });
});

describe("checkAdIdentity", () => {
  it("says what it could and could not verify, and never throws", async () => {
    const { write } = await load();
    reply = (c) => {
      if (c.path === `/${PAGE}`) return json({ id: PAGE, name: "Page" });
      if (c.path === `/act_${ACCOUNT}/promote_pages`) return json({ data: [{ id: PAGE }] });
      if (c.path === `/act_${ACCOUNT}/adcreatives`) return json({ data: [{ instagram_user_id: "17841428027695210" }] });
      return metaError(100, "Unsupported get request");
    };
    await expect(write.checkAdIdentity(ACCOUNT, PAGE, "17841428027695210")).resolves.toMatchObject({ pageReadable: true, pagePromotable: true, instagramKnown: true, notes: [] });
    const other = await write.checkAdIdentity(ACCOUNT, PAGE, "17840000000000000");
    expect(other).toMatchObject({ pageReadable: true, instagramKnown: null });
    expect(other.notes[0]).toMatch(/non confirmé/);

    const missing = await write.checkAdIdentity(ACCOUNT, "12345678901");
    expect(missing.pageReadable).toBe(false);
    reply = () => { throw timeout(); };
    await expect(write.checkAdIdentity(ACCOUNT, PAGE)).resolves.toMatchObject({ pageReadable: null });
    expect(posts()).toHaveLength(0);
  });
});

describe("metaGraphUpdate — Pilotage", () => {
  it("one field of one object, from a closed list, checked again here", async () => {
    const { api, guard } = await load();
    const refused: Array<[string, string, string]> = [
      [AD, "access_token", "other"],
      [AD, "targeting", "{}"],
      [AD, "status", "ARCHIVED"],
      [AD, "daily_budget", "-5"],
      [AD, "daily_budget", "12.5"],
      [AD, "end_time", "demain"],
      [AD, "name", ""],
      [`${AD}/../act_1`, "status", "PAUSED"],
      ["act_1", "status", "PAUSED"],
    ];
    for (const [id, field, value] of refused) {
      await expect(api.metaGraphUpdate(guard, id, field, value, PRIMARY)).rejects.toThrow(/Écriture refusée/);
    }
    await expect(api.metaGraphUpdate({ runId: "x" } as never, AD, "status", "PAUSED", PRIMARY)).rejects.toThrow(/Écriture refusée/);
    expect(calls).toHaveLength(0);

    reply = (c) => (c.method === "POST" && c.path === `/${CAMPAIGN}` ? json({ success: true }) : happy(c));
    await api.metaGraphUpdate(guard, CAMPAIGN, "daily_budget", "15000", PRIMARY);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].path).toBe(`/${CAMPAIGN}`);
    expect(posts()[0].url).not.toContain(PRIMARY);
    expect([...posts()[0].body!.entries()].sort()).toEqual([["access_token", PRIMARY], ["daily_budget", "15000"]]);
  });

  it("never sends again a write whose outcome is unknown", async () => {
    const { api, guard } = await load();
    reply = (c) => { if (c.method === "POST") throw timeout(); return happy(c); };
    await expect(api.metaGraphUpdate(guard, AD, "status", "PAUSED", PRIMARY)).rejects.toMatchObject({ name: "MetaWriteUncertainError" });
    expect(posts()).toHaveLength(1);
  });
});
