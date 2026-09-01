import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetaApiError, classifyMetaError, isMetaApiError, isMetaNoData } from "@/lib/meta-errors";

describe("classifyMetaError", () => {
  it.each([
    [4, undefined, 400, "rate_limit", true],
    [17, undefined, 400, "rate_limit", true],
    [32, undefined, 400, "rate_limit", true],
    [613, undefined, 400, "rate_limit", true],
    [80000, undefined, 400, "rate_limit", true],
    [80004, undefined, 400, "rate_limit", true],
    [80008, undefined, 400, "rate_limit", true],
    [2, undefined, 500, "transient", true],
    [190, undefined, 400, "auth", false],
    [102, undefined, 400, "auth", false],
    [10, undefined, 400, "permission", false],
    [100, 33, 400, "permission", false],
    [100, undefined, 400, "invalid", false],
    [200, undefined, 400, "permission", false],
    [299, undefined, 400, "permission", false],
    [1, undefined, 500, "transient", true],
  ])("code=%s subcode=%s http=%s → %s (retryable=%s)", (code, subcode, http, kind, retryable) => {
    expect(classifyMetaError({ code, subcode, httpStatus: http })).toEqual({ kind, retryable });
  });

  it("maps HTTP-only signals", () => {
    expect(classifyMetaError({ httpStatus: 500 })).toEqual({ kind: "transient", retryable: true });
    expect(classifyMetaError({ httpStatus: 503 })).toEqual({ kind: "transient", retryable: true });
    expect(classifyMetaError({ httpStatus: 429 })).toEqual({ kind: "rate_limit", retryable: true });
    expect(classifyMetaError({ httpStatus: 0 })).toEqual({ kind: "transient", retryable: true }); // network
    expect(classifyMetaError({ httpStatus: 401 })).toEqual({ kind: "auth", retryable: false });
    expect(classifyMetaError({ httpStatus: 400 })).toEqual({ kind: "invalid", retryable: false });
    expect(classifyMetaError({ httpStatus: 418 })).toEqual({ kind: "unknown", retryable: false });
  });
});

describe("MetaApiError", () => {
  it("carries code/subcode/httpStatus/fbtrace and derives kind/retryable", () => {
    const e = new MetaApiError({
      message: "Application request limit reached",
      code: 4,
      subcode: 1504022,
      httpStatus: 400,
      fbtraceId: "AbC",
      path: "/act_1/insights",
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("MetaApiError");
    expect(e.kind).toBe("rate_limit");
    expect(e.retryable).toBe(true);
    expect(e.code).toBe(4);
    expect(e.subcode).toBe(1504022);
    expect(e.httpStatus).toBe(400);
    expect(e.describe()).toContain("[rate_limit] code=4/1504022 http=400 trace=AbC");
    expect(isMetaApiError(e)).toBe(true);
    expect(isMetaApiError(new Error("x"))).toBe(false);
  });

  it("auth errors are not retryable", () => {
    const e = new MetaApiError({ message: "Invalid OAuth access token", code: 190, httpStatus: 400 });
    expect(e.kind).toBe("auth");
    expect(e.retryable).toBe(false);
  });
});

describe("isMetaNoData", () => {
  it("is true only for actual empty payloads, never for errors", () => {
    expect(isMetaNoData([])).toBe(true);
    expect(isMetaNoData({ data: [] })).toBe(true);
    expect(isMetaNoData({ hasData: false, spend: "0" })).toBe(true);
    expect(isMetaNoData([{ spend: "1" }])).toBe(false);
    expect(isMetaNoData({ data: [{ spend: "1" }] })).toBe(false);
    expect(isMetaNoData(new MetaApiError({ message: "x", code: 4, httpStatus: 400 }))).toBe(false);
  });
});

// ── metaFetch retry decision (integration through getAccountInsights) ───────

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("metaFetch retry policy", () => {
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  beforeEach(() => {
    vi.resetModules();
    process.env.META_RETRY_BASE_MS = "0";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.META_RETRY_BASE_MS;
  });

  it("retries a rate-limit error (code 4, HTTP 400) and succeeds", async () => {
    const { getAccountInsights } = await import("@/lib/meta-api");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Application request limit reached", code: 4, fbtrace_id: "t" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "User request limit reached", code: 17 } }, 400))
      .mockResolvedValueOnce(jsonResponse({ data: [{ spend: "12.5", impressions: "100", clicks: "3", ctr: "3", cpm: "1", account_currency: "EUR", date_start: "2026-01-01", date_stop: "2026-01-31" }] }));
    const r = await getAccountInsights("tok", "123", { since: "2026-01-01", until: "2026-01-31" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.spend).toBe("12.5");
    expect(r.currency).toBe("EUR");
    expect(r.hasData).toBe(true);
    expect(r.account_id).toBe("act_123");
    // every insights call requests unified attribution + account_currency
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("use_unified_attribution_setting")).toBe("true");
    expect(url.searchParams.get("fields")).toContain("account_currency");
  });

  it("does NOT retry an auth error (code 190) and throws a MetaApiError", async () => {
    const { getAccountInsights } = await import("@/lib/meta-api");
    fetchMock.mockImplementation(async () => jsonResponse({ error: { message: "Invalid OAuth access token", code: 190 } }, 400));
    await expect(getAccountInsights("tok", "123")).rejects.toMatchObject({ name: "MetaApiError", code: 190, kind: "auth", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after 4 attempts on persistent rate limiting (never returns null)", async () => {
    const { getAccountInsights } = await import("@/lib/meta-api");
    fetchMock.mockImplementation(async () => jsonResponse({ error: { message: "limit", code: 4 } }, 400));
    await expect(getAccountInsights("tok", "123")).rejects.toMatchObject({ kind: "rate_limit" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries HTTP 5xx without a JSON body", async () => {
    const { getAccountInsights } = await import("@/lib/meta-api");
    fetchMock
      .mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    const r = await getAccountInsights("tok", "act_9", { since: "2026-01-01", until: "2026-01-02" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.hasData).toBe(false);
    expect(r.spend).toBe("0");
    expect(r.date_start).toBe("2026-01-01");
  });

  it("paginates and reports truncation", async () => {
    const { getAdInsightsPaged } = await import("@/lib/meta-api");
    const row = (i: number) => ({ ad_id: String(i), ad_name: `a${i}`, spend: "1", impressions: "1", clicks: "1", ctr: "1", cpc: "1", cpm: "1", date_start: "d", date_stop: "d" });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [row(1), row(2)], paging: { cursors: { after: "c1" }, next: "https://x" } }))
      .mockResolvedValueOnce(jsonResponse({ data: [row(3), row(4)], paging: { cursors: { after: "c2" }, next: "https://x" } }))
      .mockResolvedValueOnce(jsonResponse({ data: [row(5)] }));
    const full = await getAdInsightsPaged("tok", "1", { since: "a", until: "b" });
    expect(full.data.map((r) => r.ad_id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(full.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("after")).toBe("c1");

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [row(1), row(2)], paging: { cursors: { after: "c1" }, next: "https://x" } }))
      .mockResolvedValueOnce(jsonResponse({ data: [row(3), row(4)], paging: { cursors: { after: "c2" }, next: "https://x" } }));
    const capped = await getAdInsightsPaged("tok", "1", { since: "a", until: "b" }, { max: 3 });
    expect(capped.data).toHaveLength(3);
    expect(capped.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
