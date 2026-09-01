import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HubspotApiError,
  chunk,
  classifyHubspotError,
  extractRequiredScopes,
  hubspotFetch,
  hubspotLimiterState,
  isHubspotApiError,
  parseRetryAfter,
} from "@/lib/hubspot/http";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

/** Awaits a rejection and returns it typed (fails the test when the promise resolves). */
async function captureError(p: Promise<unknown>): Promise<HubspotApiError> {
  try {
    await p;
  } catch (e) {
    return e as HubspotApiError;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  process.env.HUBSPOT_RETRY_BASE_MS = "0";
  process.env.HUBSPOT_SEARCH_MIN_INTERVAL_MS = "0";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("classifyHubspotError", () => {
  it.each([
    [429, undefined, "rate_limit", true],
    [400, "RATE_LIMITS", "rate_limit", true],
    [500, undefined, "transient", true],
    [503, undefined, "transient", true],
    [0, undefined, "transient", true],
    [401, undefined, "auth", false],
    [400, "INVALID_AUTHENTICATION", "auth", false],
    [403, "MISSING_SCOPES", "scope", false],
    [403, undefined, "permission", false],
    [404, undefined, "not_found", false],
    [400, "VALIDATION_ERROR", "invalid", false],
  ])("status=%s category=%s → %s (retryable=%s)", (status, cat, category, retryable) => {
    expect(classifyHubspotError({ status, hubspotCategory: cat })).toEqual({ category, retryable });
  });
});

describe("HubspotApiError", () => {
  it("lists the missing scopes in its French user message", () => {
    const e = new HubspotApiError({
      message: "This app hasn't been granted all required scopes",
      status: 403,
      path: "/crm/v3/objects/deals",
      hubspotCategory: "MISSING_SCOPES",
      missingScopes: ["crm.objects.deals.read"],
    });
    expect(e.category).toBe("scope");
    expect(e.retryable).toBe(false);
    expect(e.userMessage()).toContain("crm.objects.deals.read");
    expect(e.describe()).toContain("[scope] http=403 path=/crm/v3/objects/deals");
    expect(isHubspotApiError(e)).toBe(true);
    expect(isHubspotApiError(new Error("x"))).toBe(false);
  });

  it("extractRequiredScopes reads requiredGranularScopes and requiredScopes, deduplicated", () => {
    expect(
      extractRequiredScopes({
        errors: [
          { context: { requiredGranularScopes: ["crm.objects.contacts.read", "crm.schemas.deals.read"] } },
          { context: { requiredScopes: ["crm.objects.contacts.read"] } },
        ],
      }),
    ).toEqual(["crm.objects.contacts.read", "crm.schemas.deals.read"]);
    expect(extractRequiredScopes(null)).toEqual([]);
  });
});

describe("parseRetryAfter", () => {
  it("accepts seconds and HTTP dates", () => {
    const now = Date.parse("2026-09-01T10:00:00Z");
    expect(parseRetryAfter(new Headers({ "retry-after": "3" }), now)).toBe(3000);
    expect(parseRetryAfter(new Headers({ "retry-after": "Tue, 01 Sep 2026 10:00:05 GMT" }), now)).toBe(5000);
    expect(parseRetryAfter(new Headers(), now)).toBeUndefined();
    expect(parseRetryAfter(new Headers({ "retry-after": "soon" }), now)).toBeUndefined();
  });
});

describe("hubspotFetch", () => {
  it("sends a Bearer token, JSON accept header and query params on GET", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { portalId: 123 }));
    const res = await hubspotFetch<{ portalId: number }>("tok", "/account-info/v3/details", { query: { limit: 1 } });
    expect(res.portalId).toBe(123);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.hubapi.com/account-info/v3/details?limit=1");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(init?.body).toBeUndefined();
  });

  it("serialises a JSON body as POST with content-type", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { results: [] }));
    await hubspotFetch("tok", "/crm/v3/objects/contacts/search", { body: { limit: 200 } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ limit: 200 });
  });

  it("refuses an empty token without calling the network", async () => {
    await expect(hubspotFetch("", "/x")).rejects.toMatchObject({ name: "HubspotApiError", category: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry a 401 and exposes category=auth", async () => {
    fetchMock.mockResolvedValue(json(401, { status: "error", message: "Authentication credentials not found", category: "INVALID_AUTHENTICATION" }));
    await expect(hubspotFetch("bad", "/crm/v3/objects/contacts")).rejects.toMatchObject({
      status: 401,
      category: "auth",
      retryable: false,
      message: "Authentication credentials not found",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 403 MISSING_SCOPES body to category=scope with the required scopes", async () => {
    fetchMock.mockResolvedValue(
      json(403, {
        status: "error",
        message: "This app hasn't been granted all required scopes to make this call.",
        correlationId: "abc",
        category: "MISSING_SCOPES",
        errors: [{ message: "One or more of the following scopes are required.", context: { requiredGranularScopes: ["crm.objects.deals.read"] } }],
      }),
    );
    const err = await captureError(hubspotFetch("tok", "/crm/v3/objects/deals"));
    expect(isHubspotApiError(err)).toBe(true);
    expect(err.category).toBe("scope");
    expect(err.missingScopes).toEqual(["crm.objects.deals.read"]);
    expect(err.correlationId).toBe("abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and waits for Retry-After before the next attempt", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json(429, { category: "RATE_LIMITS", message: "too many" }, { "retry-after": "2" }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    let settled = false;
    const p = hubspotFetch<{ ok: boolean }>("tok", "/crm/v3/objects/contacts/search", { body: {} }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1_900);
    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx with exponential backoff and gives up after 4 attempts", async () => {
    fetchMock.mockResolvedValue(json(502, { message: "bad gateway" }));
    await expect(hubspotFetch("tok", "/crm/v3/pipelines/deals")).rejects.toMatchObject({ status: 502, category: "transient", retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("treats a network failure as transient (status 0) and retries", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json(200, { fine: 1 }));
    expect(await hubspotFetch("tok", "/x")).toEqual({ fine: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout explicitly", async () => {
    const abort = new Error("aborted");
    abort.name = "TimeoutError";
    fetchMock.mockRejectedValue(abort);
    const err = await captureError(hubspotFetch("tok", "/x", { timeoutMs: 5 }));
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/timeout after 5 ms/);
  });

  it("does not retry a 400 validation error", async () => {
    fetchMock.mockResolvedValue(json(400, { category: "VALIDATION_ERROR", message: "Property x does not exist" }));
    await expect(hubspotFetch("tok", "/crm/v3/objects/contacts/search", { body: {} })).rejects.toMatchObject({ category: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null on 204 and rejects a non-JSON 200 body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await hubspotFetch("tok", "/x")).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 200 }));
    await expect(hubspotFetch("tok", "/y")).rejects.toMatchObject({ category: "unknown", message: expect.stringMatching(/non-JSON/) });
  });

  it("never runs more than HUBSPOT_MAX_CONCURRENCY (3) requests at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          gates.push(() => {
            inFlight--;
            resolve(json(200, { n: 1 }));
          });
        }),
    );
    const calls = Array.from({ length: 7 }, (_, i) => hubspotFetch("tok", `/crm/v3/objects/contacts/${i}`));
    await new Promise((r) => setTimeout(r, 0));
    expect(hubspotLimiterState().max).toBe(3);
    expect(peak).toBe(3);
    expect(hubspotLimiterState().waiting).toBe(4);
    while (gates.length) {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(calls);
    expect(peak).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(hubspotLimiterState().active).toBe(0);
  });
});

describe("chunk", () => {
  it("splits into fixed-size batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
  });
});
