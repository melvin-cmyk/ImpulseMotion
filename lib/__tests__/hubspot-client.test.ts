import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// In-memory stand-in for lib/kpi-cache (hoisted: vi.mock factories run first).
const { cacheStore, cachedMock } = vi.hoisted(() => {
  const cacheStore = new Map<string, unknown>();
  const cachedMock = vi.fn(async (key: string, fetcher: () => Promise<unknown>, opts?: { refresh?: boolean }) => {
    if (!opts?.refresh && cacheStore.has(key)) return cacheStore.get(key);
    const v = await fetcher();
    cacheStore.set(key, v);
    return v;
  });
  return { cacheStore, cachedMock };
});
vi.mock("@/lib/kpi-cache", () => ({ cached: cachedMock, ttlForRange: vi.fn(() => 15 * 60 * 1000) }));

import {
  BATCH_SIZE,
  SEARCH_MAX_RESULTS,
  fetchCrmSnapshot,
  getCrmSnapshotCached,
  snapshotCacheKey,
  testHubspotConnection,
} from "@/lib/hubspot/client";
import type { HsObject } from "@/lib/hubspot/types";

type Handler = (req: { path: string; query: URLSearchParams; method: string; body: Record<string, unknown> | null }) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const MISSING_SCOPES = (scopes: string[]) =>
  json(403, {
    status: "error",
    message: "This app hasn't been granted all required scopes to make this call.",
    category: "MISSING_SCOPES",
    errors: [{ message: "One or more of the following scopes are required.", context: { requiredGranularScopes: scopes } }],
  });

const calls: Array<{ path: string; method: string; body: Record<string, unknown> | null; query: URLSearchParams }> = [];
let routes: Record<string, Handler> = {};

function route(path: string, handler: Handler) {
  routes[path] = handler;
}

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const u = new URL(url);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  const req = { path: u.pathname, query: u.searchParams, method: init?.method ?? "GET", body };
  calls.push(req);
  const h = routes[u.pathname];
  if (!h) return json(404, { message: `no route ${u.pathname}` });
  return h(req);
});

const D = (ymd: string, hms = "12:00:00") => `${ymd}T${hms}.000Z`;
const contact = (id: string, props: Record<string, string | null>): HsObject => ({ id, properties: { createdate: D("2026-08-10"), ...props } });
const deal = (id: string, props: Record<string, string | null>): HsObject => ({
  id,
  properties: { createdate: D("2026-08-12"), pipeline: "default", dealstage: "appointmentscheduled", amount: "100", deal_currency_code: "EUR", ...props },
});

/** Standard happy-path portal: 2 contacts, 2 deals, 1 pipeline, utm_campaign property. */
function happyPortal(opts: { contacts?: HsObject[]; dealsCreated?: HsObject[]; dealsWon?: HsObject[] } = {}) {
  const contacts = opts.contacts ?? [
    contact("c1", { hs_analytics_source: "PAID_SOCIAL", utm_campaign: "Retargeting", lifecyclestage: "marketingqualifiedlead" }),
    contact("c2", { hs_analytics_source: "ORGANIC_SEARCH", lifecyclestage: "lead" }),
  ];
  const dealsCreated = opts.dealsCreated ?? [deal("d1", { amount: "1000" })];
  const dealsWon = opts.dealsWon ?? [deal("d2", { amount: "500", createdate: D("2026-05-01"), dealstage: "closedwon", hs_is_closed_won: "true", hs_is_closed: "true", closedate: D("2026-08-20") })];
  route("/account-info/v3/details", () => json(200, { portalId: 4242, uiDomain: "app-eu1.hubspot.com", timeZone: "Europe/Paris" }));
  route("/crm/v3/properties/contacts", () => json(200, { results: [{ name: "email" }, { name: "utm_campaign", label: "UTM Campaign" }, { name: "utm_source" }] }));
  route("/crm/v3/objects/contacts/search", () => json(200, { total: contacts.length, results: contacts }));
  route("/crm/v3/objects/deals/search", ({ body }) => {
    const filters = (body?.filterGroups as Array<{ filters: Array<{ propertyName: string }> }>)[0].filters;
    const isWon = filters.some((f) => f.propertyName === "hs_is_closed_won");
    const rows = isWon ? dealsWon : dealsCreated;
    return json(200, { total: rows.length, results: rows });
  });
  route("/crm/v4/associations/deals/contacts/batch/read", ({ body }) => {
    const inputs = body?.inputs as Array<{ id: string }>;
    return json(200, {
      results: inputs.map(({ id }) => ({ from: { id }, to: id === "d1" ? [{ toObjectId: "c1" }, { toObjectId: "c2" }] : [{ toObjectId: "c0" }] })),
    });
  });
  route("/crm/v3/objects/contacts/batch/read", ({ body }) => {
    const inputs = body?.inputs as Array<{ id: string }>;
    return json(200, { results: inputs.map(({ id }) => contact(id, { createdate: D("2026-04-01"), hs_analytics_source: "PAID_SEARCH", utm_campaign: "Search Brand" })) });
  });
  route("/crm/v3/pipelines/deals", () =>
    json(200, {
      results: [
        {
          id: "default",
          label: "Sales",
          stages: [
            { id: "appointmentscheduled", label: "RDV", displayOrder: 0, metadata: { isClosed: "false", probability: "0.2" } },
            { id: "closedwon", label: "Gagné", displayOrder: 1, metadata: { isClosed: "true", probability: "1.0" } },
          ],
        },
      ],
    }),
  );
}

const KNOWN = [
  { platform: "meta" as const, name: "Retargeting", id: "1" },
  { platform: "google" as const, name: "Search Brand", id: "2" },
];
const INPUT = { token: "pat-eu1-xxx", since: "2026-08-01", until: "2026-08-31", knownCampaigns: KNOWN, now: new Date("2026-09-01T07:00:00Z") };

beforeEach(() => {
  process.env.HUBSPOT_RETRY_BASE_MS = "0";
  process.env.HUBSPOT_SEARCH_MIN_INTERVAL_MS = "0";
  routes = {};
  calls.length = 0;
  cacheStore.clear();
  cachedMock.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("testHubspotConnection", () => {
  it("returns the portal identity and scopesOk when every probe succeeds", async () => {
    happyPortal();
    route("/crm/v3/objects/contacts", () => json(200, { results: [] }));
    route("/crm/v3/objects/deals", () => json(200, { results: [] }));
    const r = await testHubspotConnection("pat");
    expect(r).toEqual({ ok: true, portalId: "4242", hubDomain: "app-eu1.hubspot.com", scopesOk: true, missingScopes: [], timeZone: "Europe/Paris" });
    expect(calls.filter((c) => c.path === "/crm/v3/objects/contacts")[0].query.get("limit")).toBe("1");
  });

  it("lists missing scopes from the 403 bodies (and the expected scope when HubSpot gives none)", async () => {
    happyPortal();
    route("/crm/v3/objects/contacts", () => json(200, { results: [] }));
    route("/crm/v3/objects/deals", () => MISSING_SCOPES(["crm.objects.deals.read"]));
    route("/crm/v3/pipelines/deals", () => json(403, { category: "MISSING_SCOPES", message: "nope" }));
    const r = await testHubspotConnection("pat");
    expect(r).toMatchObject({ ok: true, portalId: "4242", scopesOk: false, missingScopes: ["crm.objects.deals.read", "crm.schemas.deals.read"] });
  });

  it("fails clearly on an invalid token", async () => {
    route("/account-info/v3/details", () => json(401, { category: "INVALID_AUTHENTICATION", message: "Authentication credentials not found." }));
    const r = await testHubspotConnection("bad");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Token HubSpot invalide/);
    expect(await testHubspotConnection("")).toEqual({ ok: false, error: "Token HubSpot vide." });
  });

  it("falls back to /integrations/v1/me when account-info is forbidden", async () => {
    happyPortal();
    route("/account-info/v3/details", () => MISSING_SCOPES(["oauth"]));
    route("/integrations/v1/me", () => json(200, { portalId: 777 }));
    route("/crm/v3/objects/contacts", () => json(200, { results: [] }));
    route("/crm/v3/objects/deals", () => json(200, { results: [] }));
    const r = await testHubspotConnection("pat");
    expect(r).toMatchObject({ ok: true, portalId: "777", hubDomain: null });
  });

  it("does not report a bogus missing scope when a probe fails for another reason", async () => {
    happyPortal();
    route("/crm/v3/objects/contacts", () => json(200, { results: [] }));
    route("/crm/v3/objects/deals", () => json(503, { message: "down" }));
    const r = await testHubspotConnection("pat");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/deals/);
  });
});

describe("fetchCrmSnapshot", () => {
  it("runs the full pipeline: UTM detection, tz-aware search bounds, associations, related contacts, pipelines", async () => {
    happyPortal();
    const s = await fetchCrmSnapshot(INPUT);
    expect(s.portalId).toBe("4242");
    expect(s.fetchedAt).toBe("2026-09-01T07:00:00.000Z");
    expect(s.range).toEqual({ since: "2026-08-01", until: "2026-08-31" });
    expect(s.partial).toBe(false);
    expect(s.warnings).toEqual([]);

    const search = calls.find((c) => c.path === "/crm/v3/objects/contacts/search")!;
    expect(search.method).toBe("POST");
    const filters = (search.body!.filterGroups as Array<{ filters: Array<Record<string, string>> }>)[0].filters;
    // Portal timezone Europe/Paris (UTC+2 in August) drives the day boundaries
    expect(filters).toEqual([
      { propertyName: "createdate", operator: "BETWEEN", value: String(Date.parse("2026-07-31T22:00:00Z")), highValue: String(Date.parse("2026-08-31T21:59:59.999Z")) },
    ]);
    expect(search.body!.properties).toEqual(expect.arrayContaining(["createdate", "hs_analytics_source", "hs_analytics_first_url", "utm_campaign", "utm_source"]));
    expect(search.body!.limit).toBe(200);
    expect(search.body!.sorts).toEqual([{ propertyName: "createdate", direction: "ASCENDING" }]);

    const dealSearches = calls.filter((c) => c.path === "/crm/v3/objects/deals/search");
    expect(dealSearches).toHaveLength(2);
    const wonFilters = dealSearches.map((c) => (c.body!.filterGroups as Array<{ filters: Array<Record<string, string>> }>)[0].filters.map((f) => f.propertyName));
    expect(wonFilters).toContainEqual(["createdate"]);
    expect(wonFilters).toContainEqual(["closedate", "hs_is_closed_won"]);

    const batchRead = calls.find((c) => c.path === "/crm/v3/objects/contacts/batch/read")!;
    expect(batchRead.body!.inputs).toEqual([{ id: "c0" }]);

    expect(s.totals).toEqual({ contacts: 2, qualified: 1, dealsCreated: 1, dealsWon: 1, wonAmount: 500, openAmount: 1000 });
    expect(s.bySource.PAID_SOCIAL).toMatchObject({ contacts: 1, qualified: 1, dealsCreated: 1, openAmount: 1000 });
    expect(s.bySource.PAID_SEARCH).toMatchObject({ contacts: 0, dealsWon: 1, wonAmount: 500 });
    expect(s.byCampaign.map((r) => [r.campaign, r.matched?.platform])).toEqual([
      ["Retargeting", "meta"],
      ["Search Brand", "google"],
    ]);
    expect(s.currency).toBe("EUR");
    expect(s.pipelines[0].stages.map((st) => [st.id, st.count])).toEqual([
      ["appointmentscheduled", 1],
      ["closedwon", 1],
    ]);
    expect(s.diagnostic).toMatchObject({ level: 2, utmProperty: "utm_campaign", paidSource: 1, matchedToCampaign: 1 });
  });

  it("paginates contacts with `after` and merges pages in a stable order", async () => {
    happyPortal();
    let page = 0;
    route("/crm/v3/objects/contacts/search", ({ body }) => {
      page++;
      if (!body?.after) {
        return json(200, { total: 3, results: [contact("c2", { hs_analytics_source: "PAID_SOCIAL" }), contact("c1", { hs_analytics_source: "PAID_SOCIAL" })], paging: { next: { after: "200" } } });
      }
      expect(body.after).toBe("200");
      return json(200, { total: 3, results: [contact("c3", { hs_analytics_source: "PAID_SEARCH", createdate: D("2026-08-11") })] });
    });
    route("/crm/v3/objects/deals/search", () => json(200, { total: 0, results: [] }));
    const s = await fetchCrmSnapshot(INPUT);
    expect(page).toBe(2);
    expect(s.totals.contacts).toBe(3);
    expect(s.partial).toBe(false);
  });

  it("flags partial with an explicit warning when the 10 000 search cap is hit", async () => {
    happyPortal();
    route("/crm/v3/objects/contacts/search", ({ body }) => {
      const after = Number(body?.after ?? 0);
      const results = Array.from({ length: 200 }, (_, i) => contact(`c${after + i}`, { hs_analytics_source: "PAID_SOCIAL" }));
      return json(200, { total: 12_345, results, paging: { next: { after: String(after + 200) } } });
    });
    route("/crm/v3/objects/deals/search", () => json(200, { total: 0, results: [] }));
    const s = await fetchCrmSnapshot(INPUT);
    expect(s.partial).toBe(true);
    expect(s.totals.contacts).toBe(SEARCH_MAX_RESULTS);
    expect(s.warnings).toContainEqual(expect.stringMatching(/plafonne à 10\s?000 résultats/));
    expect(calls.filter((c) => c.path === "/crm/v3/objects/contacts/search")).toHaveLength(50);
  });

  it("reads associations in batches of 100 deals", async () => {
    const many = Array.from({ length: 250 }, (_, i) => deal(`d${i}`, {}));
    happyPortal({ dealsCreated: many, dealsWon: [] });
    route("/crm/v4/associations/deals/contacts/batch/read", ({ body }) => {
      const inputs = body?.inputs as Array<{ id: string }>;
      expect(inputs.length).toBeLessThanOrEqual(BATCH_SIZE);
      return json(200, { results: inputs.map(({ id }) => ({ from: { id }, to: [{ toObjectId: "c1" }] })) });
    });
    const s = await fetchCrmSnapshot(INPUT);
    expect(calls.filter((c) => c.path === "/crm/v4/associations/deals/contacts/batch/read")).toHaveLength(3);
    expect(s.totals.dealsCreated).toBe(250);
    expect(s.bySource.PAID_SOCIAL?.dealsCreated).toBe(250);
    expect(calls.filter((c) => c.path === "/crm/v3/objects/contacts/batch/read")).toHaveLength(0);
  });

  it("degrades to partial + warning when deals are not readable (missing scope), contacts remain", async () => {
    happyPortal();
    route("/crm/v3/objects/deals/search", () => MISSING_SCOPES(["crm.objects.deals.read"]));
    const s = await fetchCrmSnapshot(INPUT);
    expect(s.partial).toBe(true);
    expect(s.warnings).toContainEqual(expect.stringMatching(/Deals non lus.*crm\.objects\.deals\.read/));
    expect(s.totals.contacts).toBe(2);
    expect(s.totals.dealsCreated).toBe(0);
    expect(s.currency).toBeNull();
  });

  it("degrades when contact properties cannot be listed: no custom UTM property requested, URL parsing still works", async () => {
    happyPortal({ contacts: [contact("c1", { hs_analytics_source: "PAID_SOCIAL", hs_analytics_first_url: "https://x.fr/?utm_campaign=Retargeting" })] });
    route("/crm/v3/properties/contacts", () => MISSING_SCOPES(["crm.schemas.contacts.read"]));
    const s = await fetchCrmSnapshot(INPUT);
    expect(s.partial).toBe(true);
    expect(s.warnings).toContainEqual(expect.stringMatching(/Propriétés contacts non lues/));
    const search = calls.find((c) => c.path === "/crm/v3/objects/contacts/search")!;
    expect(search.body!.properties).not.toContain("utm_campaign");
    expect(s.diagnostic.utmProperty).toBeNull();
    expect(s.byCampaign[0]).toMatchObject({ campaign: "Retargeting", matched: { platform: "meta" } });
  });

  it("warns when the configured utm property does not exist and falls back to detection", async () => {
    happyPortal();
    const s = await fetchCrmSnapshot({ ...INPUT, config: { utmCampaignProperty: "ma_campagne" } });
    expect(s.warnings).toContainEqual(expect.stringMatching(/« ma_campagne » n'existe pas/));
    expect(s.diagnostic.utmProperty).toBe("utm_campaign");
  });

  it("propagates a 401 (token) instead of degrading", async () => {
    happyPortal();
    route("/crm/v3/objects/contacts/search", () => json(401, { category: "INVALID_AUTHENTICATION", message: "expired" }));
    await expect(fetchCrmSnapshot(INPUT)).rejects.toMatchObject({ name: "HubspotApiError", category: "auth" });
    route("/crm/v3/objects/contacts/search", () => json(200, { total: 0, results: [] }));
    route("/crm/v3/pipelines/deals", () => json(401, { category: "INVALID_AUTHENTICATION", message: "expired" }));
    await expect(fetchCrmSnapshot(INPUT)).rejects.toMatchObject({ category: "auth" });
  });

  it("propagates a contacts-search failure after retries (never an empty snapshot from an error)", async () => {
    happyPortal();
    route("/crm/v3/objects/contacts/search", () => json(500, { message: "boom" }));
    await expect(fetchCrmSnapshot(INPUT)).rejects.toMatchObject({ category: "transient", status: 500 });
  });

  it("retries a 429 on the search API and still succeeds", async () => {
    happyPortal();
    let n = 0;
    const ok = routes["/crm/v3/objects/contacts/search"];
    route("/crm/v3/objects/contacts/search", (req) => (n++ === 0 ? json(429, { category: "RATE_LIMITS", message: "slow down" }, { "retry-after": "0" }) : ok(req)));
    const s = await fetchCrmSnapshot(INPUT);
    expect(n).toBe(2);
    expect(s.totals.contacts).toBe(2);
    expect(s.partial).toBe(false);
  });

  it("uses the explicit tz over the portal timezone and passes pipelineIds to the deal searches", async () => {
    happyPortal();
    await fetchCrmSnapshot({ ...INPUT, tz: "UTC", config: { pipelineIds: ["default"] } });
    const search = calls.find((c) => c.path === "/crm/v3/objects/contacts/search")!;
    const f = (search.body!.filterGroups as Array<{ filters: Array<Record<string, string>> }>)[0].filters[0];
    expect(f.value).toBe(String(Date.parse("2026-08-01T00:00:00Z")));
    const dealSearch = calls.find((c) => c.path === "/crm/v3/objects/deals/search")!;
    const df = (dealSearch.body!.filterGroups as Array<{ filters: Array<Record<string, unknown>> }>)[0].filters;
    expect(df).toContainEqual({ propertyName: "pipeline", operator: "IN", values: ["default"] });
  });
});

describe("getCrmSnapshotCached", () => {
  it("builds the documented cache key and reports cached/refresh correctly", async () => {
    happyPortal();
    const key = snapshotCacheKey({ dashboardId: "dash1", since: "2026-08-01", until: "2026-08-31", knownCampaigns: KNOWN });
    expect(key).toMatch(/^hubspot:snapshot:dash1:2026-08-01_2026-08-31:[0-9a-f]{12}$/);
    expect(snapshotCacheKey({ dashboardId: "dash1", since: "2026-08-01", until: "2026-08-31", knownCampaigns: [] })).not.toBe(key);
    expect(snapshotCacheKey({ dashboardId: "dash1", since: "2026-08-01", until: "2026-08-31", knownCampaigns: [...KNOWN].reverse() })).toBe(key);

    const first = await getCrmSnapshotCached({ ...INPUT, dashboardId: "dash1" });
    expect(first.cached).toBe(false);
    expect(first.totals.contacts).toBe(2);
    expect(cachedMock).toHaveBeenLastCalledWith(key, expect.any(Function), { ttlMs: 15 * 60 * 1000, refresh: undefined });
    const fetches = fetchMock.mock.calls.length;

    const second = await getCrmSnapshotCached({ ...INPUT, dashboardId: "dash1" });
    expect(second.cached).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(fetches);

    const third = await getCrmSnapshotCached({ ...INPUT, dashboardId: "dash1", refresh: true });
    expect(third.cached).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(fetches);
  });
});
