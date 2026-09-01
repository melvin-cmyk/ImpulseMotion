import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the KpiCache table (hoisted: vi.mock factories run first).
const { store, upsert } = vi.hoisted(() => {
  const store = new Map<string, { key: string; payload: string; expiresAt: Date; createdAt: Date }>();
  const upsert = vi.fn(async (args: { where: { key: string }; create: { key: string; payload: string; expiresAt: Date } }) => {
    const existing = store.get(args.where.key);
    const row = { ...args.create, createdAt: existing?.createdAt ?? new Date() };
    store.set(args.where.key, row);
    return row;
  });
  return { store, upsert };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    kpiCache: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => store.get(where.key) ?? null),
      upsert,
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

import { cached, cachedWithMeta, ttlForRange, versionedKey, CACHE_VERSION, isEmptyPayload } from "@/lib/kpi-cache";

beforeEach(() => {
  store.clear();
  upsert.mockClear();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // disable opportunistic cleanup
});

describe("cached()", () => {
  it("stores an envelope {v:2,data,fetchedAt} under a versioned key and serves it back", async () => {
    const fetcher = vi.fn(async () => ({ spend: "10" }));
    const first = await cachedWithMeta("meta:account:1:a_b", fetcher, { ttlMs: 60_000 });
    expect(first.fromCache).toBe(false);
    expect(first.data).toEqual({ spend: "10" });
    const row = store.get(versionedKey("meta:account:1:a_b"));
    expect(row).toBeDefined();
    expect(row!.key.startsWith(`${CACHE_VERSION}:`)).toBe(true);
    const env = JSON.parse(row!.payload);
    expect(env.v).toBe(2);
    expect(env.data).toEqual({ spend: "10" });
    expect(typeof env.fetchedAt).toBe("string");

    const second = await cachedWithMeta("meta:account:1:a_b", fetcher, { ttlMs: 60_000 });
    expect(second.fromCache).toBe(true);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never stores null or undefined", async () => {
    expect(await cached("k-null", async () => null)).toBeNull();
    expect(await cached("k-undef", async () => undefined)).toBeUndefined();
    expect(upsert).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("stores nothing when the fetcher throws, and rethrows", async () => {
    await expect(cached("k-err", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(store.size).toBe(0);
  });

  it("caches empty arrays with the short emptyTtlMs, or not at all with cacheEmpty:false", async () => {
    const before = Date.now();
    await cached("k-empty", async () => [], { ttlMs: 60 * 60 * 1000, emptyTtlMs: 1000 });
    const row = store.get(versionedKey("k-empty"))!;
    expect(row).toBeDefined();
    expect(row.expiresAt.getTime() - before).toBeLessThanOrEqual(1000 + 50);

    await cached("k-empty-2", async () => [], { cacheEmpty: false });
    expect(store.has(versionedKey("k-empty-2"))).toBe(false);

    // hasData:false rows are "empty" too
    await cached("k-nodata", async () => ({ spend: "0", hasData: false }), { ttlMs: 60 * 60 * 1000, emptyTtlMs: 1000 });
    expect(store.get(versionedKey("k-nodata"))!.expiresAt.getTime() - before).toBeLessThanOrEqual(1000 + 50);
    expect(isEmptyPayload({ data: [], truncated: false })).toBe(true);
    expect(isEmptyPayload({ data: [1] })).toBe(false);
  });

  it("reads legacy rows (raw payload, no v) with fetchedAt = createdAt", async () => {
    const createdAt = new Date("2026-08-01T10:00:00Z");
    store.set(versionedKey("legacy"), {
      key: versionedKey("legacy"),
      payload: JSON.stringify([{ spend: "5" }]),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt,
    });
    const r = await cachedWithMeta("legacy", async () => [{ spend: "fresh" }]);
    expect(r.fromCache).toBe(true);
    expect(r.data).toEqual([{ spend: "5" }]);
    expect(r.fetchedAt).toBe(createdAt.toISOString());
  });

  it("treats a legacy cached null as a miss", async () => {
    store.set(versionedKey("legacy-null"), {
      key: versionedKey("legacy-null"),
      payload: "null",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    const r = await cachedWithMeta("legacy-null", async () => ({ ok: true }));
    expect(r.fromCache).toBe(false);
    expect(r.data).toEqual({ ok: true });
  });

  it("refresh:true bypasses the read and overwrites", async () => {
    await cached("k-refresh", async () => 1, { ttlMs: 60_000 });
    expect(await cached("k-refresh", async () => 2, { ttlMs: 60_000 })).toBe(1);
    expect(await cached("k-refresh", async () => 3, { ttlMs: 60_000, refresh: true })).toBe(3);
    expect(await cached("k-refresh", async () => 4, { ttlMs: 60_000 })).toBe(3);
  });

  it("accepts a legacy numeric ttl as third argument", async () => {
    const before = Date.now();
    await cached("k-num", async () => ({ a: 1 }), 5000);
    const row = store.get(versionedKey("k-num"))!;
    expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(4900);
    expect(row.expiresAt.getTime() - before).toBeLessThanOrEqual(5050);
  });
});

describe("ttlForRange", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  it("is 15 min when the range touches today, 24 h once closed", () => {
    expect(ttlForRange({ since: "2026-08-01", until: "2026-08-31" }, { now })).toBe(15 * 60 * 1000);
    expect(ttlForRange({ since: "2026-08-01", until: "2026-09-05" }, { now })).toBe(15 * 60 * 1000);
    expect(ttlForRange({ since: "2026-08-01", until: "2026-08-30" }, { now })).toBe(24 * 60 * 60 * 1000);
  });
  it("respects the account timezone", () => {
    // 2026-08-31T23:30Z is already 2026-09-01 in Europe/Paris
    const late = new Date("2026-08-31T23:30:00Z");
    expect(ttlForRange({ since: "2026-08-01", until: "2026-08-31" }, { now: late, tz: "UTC" })).toBe(15 * 60 * 1000);
    expect(ttlForRange({ since: "2026-08-01", until: "2026-08-31" }, { now: late, tz: "Europe/Paris" })).toBe(24 * 60 * 60 * 1000);
  });
});
