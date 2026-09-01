/**
 * HubSpot REST transport (private-app Bearer token).
 *
 * Reliability contract (same spirit as lib/meta-api.ts `metaFetch`):
 * - every call goes through `hubspotFetch`: bounded concurrency
 *   (HUBSPOT_MAX_CONCURRENCY, default 3), 25 s timeout, typed `HubspotApiError`,
 *   exponential retry ONLY on retryable errors (429 / 5xx / network), honouring
 *   `Retry-After` (seconds or HTTP date);
 * - the CRM search API is capped at ~4 req/s per portal: `/search` calls are
 *   additionally spaced by HUBSPOT_SEARCH_MIN_INTERVAL_MS (default 260 ms);
 * - errors are never swallowed here — the caller decides between propagating
 *   and degrading into `warnings` + `partial: true`.
 *
 * Docs: https://developers.hubspot.com/docs/api/usage-details
 *       https://developers.hubspot.com/docs/api/crm/search
 */

export const HUBSPOT_API_BASE = "https://api.hubapi.com";

export type HubspotErrorCategory =
  | "auth" // 401 — token invalid / revoked
  | "scope" // 403 MISSING_SCOPES — private app lacks a scope
  | "permission" // other 403
  | "rate_limit" // 429
  | "transient" // 5xx / network / timeout
  | "not_found" // 404
  | "invalid" // 400 / 4xx validation
  | "unknown";

export interface HubspotErrorBody {
  status?: string;
  message?: string;
  correlationId?: string;
  category?: string;
  subCategory?: string;
  errors?: Array<{
    message?: string;
    context?: { requiredGranularScopes?: string[]; requiredScopes?: string[] } & Record<string, unknown>;
  }>;
}

/** Scopes listed by HubSpot in a MISSING_SCOPES body (deduplicated, sorted). */
export function extractRequiredScopes(body: HubspotErrorBody | null | undefined): string[] {
  const out = new Set<string>();
  for (const e of body?.errors ?? []) {
    const ctx = e?.context;
    for (const s of ctx?.requiredGranularScopes ?? []) if (typeof s === "string") out.add(s);
    for (const s of ctx?.requiredScopes ?? []) if (typeof s === "string") out.add(s);
  }
  return [...out].sort();
}

export function classifyHubspotError(input: {
  status: number;
  hubspotCategory?: string | null;
}): { category: HubspotErrorCategory; retryable: boolean } {
  const status = input.status;
  const cat = (input.hubspotCategory ?? "").toUpperCase();
  if (status === 429 || cat === "RATE_LIMITS") return { category: "rate_limit", retryable: true };
  if (status === 0 || status >= 500) return { category: "transient", retryable: true };
  if (status === 401 || cat === "INVALID_AUTHENTICATION" || cat === "EXPIRED_AUTHENTICATION") {
    return { category: "auth", retryable: false };
  }
  if (status === 403) {
    return cat === "MISSING_SCOPES" ? { category: "scope", retryable: false } : { category: "permission", retryable: false };
  }
  if (status === 404) return { category: "not_found", retryable: false };
  if (status >= 400) return { category: "invalid", retryable: false };
  return { category: "unknown", retryable: false };
}

export class HubspotApiError extends Error {
  readonly name = "HubspotApiError";
  status: number;
  category: HubspotErrorCategory;
  retryable: boolean;
  /** HubSpot's own `category` field (e.g. MISSING_SCOPES, RATE_LIMITS). */
  hubspotCategory: string | null;
  /** Scopes HubSpot says are required (only for `scope` errors). */
  missingScopes: string[];
  correlationId: string | null;
  /** API path that failed (never contains the token), for logs. */
  path: string;

  constructor(opts: {
    message: string;
    status: number;
    path: string;
    hubspotCategory?: string | null;
    missingScopes?: string[];
    correlationId?: string | null;
    cause?: unknown;
  }) {
    super(opts.message);
    this.status = opts.status;
    this.path = opts.path;
    this.hubspotCategory = opts.hubspotCategory ?? null;
    this.missingScopes = opts.missingScopes ?? [];
    this.correlationId = opts.correlationId ?? null;
    const cls = classifyHubspotError({ status: this.status, hubspotCategory: this.hubspotCategory });
    this.category = cls.category;
    this.retryable = cls.retryable;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  /** "[scope] http=403 path=/crm/v3/objects/deals: message" */
  describe(): string {
    return `[${this.category}] http=${this.status} path=${this.path}${
      this.correlationId ? ` corr=${this.correlationId}` : ""
    }: ${this.message}`;
  }

  /** French, user-facing message (UI is in French). */
  userMessage(): string {
    switch (this.category) {
      case "auth":
        return "Token HubSpot invalide ou révoqué (401). Régénérer le token de l'application privée.";
      case "scope":
        return this.missingScopes.length
          ? `Scope(s) HubSpot manquant(s) sur l'application privée : ${this.missingScopes.join(", ")}.`
          : "Scope HubSpot manquant sur l'application privée (403).";
      case "permission":
        return `Accès refusé par HubSpot (403) : ${this.message}`;
      case "rate_limit":
        return "Limite d'appels HubSpot atteinte (429), réessayer dans quelques instants.";
      case "transient":
        return this.status === 0 ? `HubSpot injoignable : ${this.message}` : `Erreur temporaire HubSpot (${this.status}).`;
      case "not_found":
        return `Ressource HubSpot introuvable (404) : ${this.path}`;
      default:
        return `Erreur HubSpot (${this.status}) : ${this.message}`;
    }
  }
}

export function isHubspotApiError(err: unknown): err is HubspotApiError {
  return (
    err instanceof HubspotApiError ||
    (!!err && typeof err === "object" && (err as { name?: string }).name === "HubspotApiError")
  );
}

// ── Concurrency limiter (per process) ────────────────────────────────────────

function readConcurrency(): number {
  const n = parseInt(process.env.HUBSPOT_MAX_CONCURRENCY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

const MAX_CONCURRENCY = readConcurrency();
let activeSlots = 0;
const slotWaiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeSlots < MAX_CONCURRENCY) {
    activeSlots++;
    return;
  }
  await new Promise<void>((resolve) => slotWaiters.push(resolve));
  activeSlots++;
}

function releaseSlot(): void {
  activeSlots = Math.max(0, activeSlots - 1);
  const next = slotWaiters.shift();
  if (next) next();
}

/** Runs `fn` inside the HubSpot concurrency limiter. */
export async function withHubspotSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

/** Test/observability hook. */
export function hubspotLimiterState(): { active: number; waiting: number; max: number } {
  return { active: activeSlots, waiting: slotWaiters.length, max: MAX_CONCURRENCY };
}

// ── Search-API pacing (~4 req/s per portal) ──────────────────────────────────

function searchMinIntervalMs(): number {
  const n = Number(process.env.HUBSPOT_SEARCH_MIN_INTERVAL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 260;
}

let nextSearchSlotAt = 0;

/** Serialises the *start* of search calls so we stay under the per-second cap. */
async function paceSearch(path: string): Promise<void> {
  if (!path.includes("/search")) return;
  const interval = searchMinIntervalMs();
  if (interval <= 0) return;
  const now = Date.now();
  const at = Math.max(now, nextSearchSlotAt);
  nextSearchSlotAt = at + interval;
  if (at > now) await sleep(at - now);
}

// ── Core fetch ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 30_000;

function retryBaseMs(): number {
  const n = Number(process.env.HUBSPOT_RETRY_BASE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HubspotFetchInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-serialised body (POST/PUT/PATCH). */
  body?: unknown;
  /** Query string parameters (appended to `path`). */
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
}

type OnceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HubspotApiError; retryAfterMs?: number };

/** `Retry-After` as seconds or an HTTP date → ms to wait (undefined when absent). */
export function parseRetryAfter(headers: { get(name: string): string | null }, now: number = Date.now()): number | undefined {
  const ra = headers.get("retry-after");
  if (!ra) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(ra);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return undefined;
}

function buildUrl(path: string, query?: HubspotFetchInit["query"]): string {
  const url = new URL(path.startsWith("http") ? path : `${HUBSPOT_API_BASE}${path.startsWith("/") ? "" : "/"}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function requestOnce<T>(token: string, path: string, init: HubspotFetchInit): Promise<OnceResult<T>> {
  const url = buildUrl(path, init.query);
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      error: new HubspotApiError({
        message: isTimeout
          ? `HubSpot API timeout after ${timeoutMs} ms`
          : `HubSpot API unreachable: ${e instanceof Error ? e.message : String(e)}`,
        status: 0,
        path,
        cause: e,
      }),
    };
  }

  if (res.status === 204) return { ok: true, value: null as T };

  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const eb = (body && typeof body === "object" ? body : null) as HubspotErrorBody | null;
    const hubspotCategory = eb?.category ?? null;
    const missingScopes = extractRequiredScopes(eb);
    return {
      ok: false,
      error: new HubspotApiError({
        message: eb?.message ?? (text ? text.slice(0, 200) : `HubSpot API HTTP ${res.status}`),
        status: res.status,
        path,
        hubspotCategory,
        missingScopes,
        correlationId: eb?.correlationId ?? null,
      }),
      retryAfterMs: parseRetryAfter(res.headers),
    };
  }
  if (text && body === null) {
    return {
      ok: false,
      error: new HubspotApiError({ message: `HubSpot API returned a non-JSON body (HTTP ${res.status})`, status: res.status, path }),
    };
  }
  return { ok: true, value: body as T };
}

/**
 * Authenticated JSON call to api.hubapi.com with limiter + retry + typed errors.
 * Use this for EVERY HubSpot request; never call `fetch(api.hubapi.com)` directly.
 */
export async function hubspotFetch<T>(token: string, path: string, init: HubspotFetchInit = {}): Promise<T> {
  if (!token) {
    throw new HubspotApiError({ message: "HubSpot token manquant", status: 401, path });
  }
  let lastError: HubspotApiError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await withHubspotSlot(async () => {
      await paceSearch(path);
      return requestOnce<T>(token, path, init);
    });
    if (result.ok) return result.value;
    lastError = result.error;
    const last = attempt === MAX_ATTEMPTS || !result.error.retryable;
    console.warn(
      `[hubspot-api] ${path} attempt ${attempt}/${MAX_ATTEMPTS} ${result.error.describe()}${last ? "" : " → retry"}`,
    );
    if (last) break;
    const base = retryBaseMs();
    const backoff = base * 2 ** (attempt - 1) + Math.random() * base * 0.5;
    const wait = Math.min(Math.max(backoff, result.retryAfterMs ?? 0), MAX_BACKOFF_MS);
    await sleep(wait);
  }
  throw lastError ?? new HubspotApiError({ message: "HubSpot API unreachable", status: 0, path });
}

/** Splits `items` into chunks of `size` (for batch endpoints, max 100 inputs). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
