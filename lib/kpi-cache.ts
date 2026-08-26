/**
 * Server-side KPI cache backed by the KpiCache table.
 *
 * `cached(key, ttlMs, fetcher)` returns the cached payload when fresh,
 * otherwise runs the fetcher and stores the result. Cache failures are never
 * fatal — a broken cache degrades to a direct fetch.
 */

import { prisma } from "@/lib/prisma";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

// Coalesce concurrent fetches of the same key within this server instance —
// widgets resolving in parallel would otherwise fire N identical API calls
// before the first response lands in the cache.
const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const promise = cachedInner(key, fetcher, ttlMs).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function cachedInner<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number,
): Promise<T> {
  try {
    const row = await prisma.kpiCache.findUnique({ where: { key } });
    if (row && row.expiresAt.getTime() > Date.now()) {
      return JSON.parse(row.payload) as T;
    }
  } catch {
    // cache read failure → fall through to fetcher
  }

  const value = await fetcher();

  try {
    const expiresAt = new Date(Date.now() + ttlMs);
    const payload = JSON.stringify(value ?? null);
    await prisma.kpiCache.upsert({
      where: { key },
      create: { key, payload, expiresAt },
      update: { payload, expiresAt },
    });
    // Opportunistic cleanup, ~1% of writes
    if (Math.random() < 0.01) {
      await prisma.kpiCache.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    }
  } catch {
    // cache write failure → still return the fresh value
  }

  return value;
}
