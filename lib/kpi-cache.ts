/**
 * Server-side KPI cache backed by the KpiCache table.
 *
 * `cached(key, fetcher, opts)` returns the cached payload when fresh,
 * otherwise runs the fetcher and stores the result. Cache failures are never
 * fatal — a broken cache degrades to a direct fetch.
 *
 * Reliability rules (Lot F1):
 * - a fetcher that throws stores NOTHING (errors are never cached as data);
 * - `null` / `undefined` results are never stored;
 * - "empty" results ([] or `{ hasData: false }`) are legit "no data" and are
 *   stored with a short TTL (`emptyTtlMs`, 60 s) unless `cacheEmpty: false`;
 * - payloads are wrapped `{ v: 2, data, fetchedAt }`; legacy rows (raw JSON,
 *   no `v`) are still readable (fetchedAt = row.createdAt);
 * - every key is prefixed with CACHE_VERSION so a bump invalidates all rows.
 */

import { prisma } from "@/lib/prisma";
import { isClosedRange, type DateRange } from "@/lib/date-ranges";

export const CACHE_VERSION = "v3";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_EMPTY_TTL_MS = 60 * 1000;
const OPEN_RANGE_TTL_MS = 15 * 60 * 1000;
const CLOSED_RANGE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CacheOptions {
  /** Freshness window for a non-empty payload (default 15 min). */
  ttlMs?: number;
  /** Freshness window for an empty payload (default 60 s). */
  emptyTtlMs?: number;
  /** Store empty payloads at all (default true, with emptyTtlMs). */
  cacheEmpty?: boolean;
  /** Skip the read and overwrite the row with a fresh fetch. */
  refresh?: boolean;
}

export interface CachedResult<T> {
  data: T;
  /** ISO timestamp of when the payload was fetched from the source. */
  fetchedAt: string;
  fromCache: boolean;
}

interface Envelope<T> {
  v: 2;
  data: T;
  fetchedAt: string;
}

/** TTL policy: 15 min when the range touches today (partial day), else 24 h. */
export function ttlForRange(range: DateRange, opts: { tz?: string | null; now?: Date } = {}): number {
  return isClosedRange(range, opts) ? CLOSED_RANGE_TTL_MS : OPEN_RANGE_TTL_MS;
}

/** [] or `{ hasData: false }` count as empty; null/undefined are handled separately. */
export function isEmptyPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") {
    const v = value as { hasData?: unknown; data?: unknown };
    if (v.hasData === false) return true;
    if (Array.isArray(v.data) && v.data.length === 0 && Object.keys(v).every((k) => k === "data" || k === "truncated")) {
      return true;
    }
  }
  return false;
}

export function versionedKey(key: string): string {
  return `${CACHE_VERSION}:${key}`;
}

function normalizeOptions(opts?: number | CacheOptions): Required<Omit<CacheOptions, "refresh">> & { refresh: boolean } {
  const o: CacheOptions = typeof opts === "number" ? { ttlMs: opts } : (opts ?? {});
  return {
    ttlMs: o.ttlMs ?? DEFAULT_TTL_MS,
    emptyTtlMs: o.emptyTtlMs ?? DEFAULT_EMPTY_TTL_MS,
    cacheEmpty: o.cacheEmpty ?? true,
    refresh: o.refresh ?? false,
  };
}

function decode<T>(payload: string, createdAt: Date): { data: T; fetchedAt: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v === 2 && "data" in (parsed as object)) {
    const env = parsed as Envelope<T>;
    return { data: env.data, fetchedAt: env.fetchedAt ?? createdAt.toISOString() };
  }
  // Legacy row: raw payload. A cached `null` is treated as a miss.
  if (parsed === null || parsed === undefined) return null;
  return { data: parsed as T, fetchedAt: createdAt.toISOString() };
}

// Coalesce concurrent fetches of the same key within this server instance —
// widgets resolving in parallel would otherwise fire N identical API calls
// before the first response lands in the cache.
const inFlight = new Map<string, Promise<CachedResult<unknown>>>();

/**
 * Returns `{ data, fetchedAt, fromCache }`. The third argument accepts either
 * a TTL in ms (legacy) or a CacheOptions object.
 */
export async function cachedWithMeta<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts?: number | CacheOptions,
): Promise<CachedResult<T>> {
  const options = normalizeOptions(opts);
  const vkey = versionedKey(key);
  if (!options.refresh) {
    const pending = inFlight.get(vkey);
    if (pending) return pending as Promise<CachedResult<T>>;
  }
  const promise = cachedInner<T>(vkey, fetcher, options).finally(() => {
    if (inFlight.get(vkey) === promise) inFlight.delete(vkey);
  });
  inFlight.set(vkey, promise as Promise<CachedResult<unknown>>);
  return promise;
}

/** Backward-compatible wrapper: returns the payload only. */
export async function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts?: number | CacheOptions,
): Promise<T> {
  return (await cachedWithMeta(key, fetcher, opts)).data;
}

async function cachedInner<T>(
  vkey: string,
  fetcher: () => Promise<T>,
  options: ReturnType<typeof normalizeOptions>,
): Promise<CachedResult<T>> {
  if (!options.refresh) {
    try {
      const row = await prisma.kpiCache.findUnique({ where: { key: vkey } });
      if (row && row.expiresAt.getTime() > Date.now()) {
        const decoded = decode<T>(row.payload, row.createdAt);
        if (decoded) return { ...decoded, fromCache: true };
      }
    } catch {
      // cache read failure → fall through to fetcher
    }
  }

  // No try/catch here on purpose: a throwing fetcher must propagate and must
  // never leave anything in the cache.
  const value = await fetcher();
  const fetchedAt = new Date().toISOString();

  const empty = isEmptyPayload(value);
  const storable = value !== null && value !== undefined && (!empty || options.cacheEmpty);
  if (storable) {
    try {
      const ttl = empty ? options.emptyTtlMs : options.ttlMs;
      const expiresAt = new Date(Date.now() + ttl);
      const envelope: Envelope<T> = { v: 2, data: value, fetchedAt };
      const payload = JSON.stringify(envelope);
      await prisma.kpiCache.upsert({
        where: { key: vkey },
        create: { key: vkey, payload, expiresAt },
        update: { payload, expiresAt },
      });
      // Opportunistic cleanup, ~1% of writes
      if (Math.random() < 0.01) {
        await prisma.kpiCache.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      }
    } catch {
      // cache write failure → still return the fresh value
    }
  }

  return { data: value, fetchedAt, fromCache: false };
}

/** Drops one key (versioned) — used after settings changes. */
export async function invalidate(key: string): Promise<void> {
  try {
    await prisma.kpiCache.deleteMany({ where: { key: versionedKey(key) } });
  } catch {
    // best effort
  }
}
