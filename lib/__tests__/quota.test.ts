import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQuotaMonitor, looksLikeUsageLimit } from "../../server/quota.mjs";

describe("looksLikeUsageLimit", () => {
  it("recognises subscription limit errors, not max-turns", () => {
    expect(looksLikeUsageLimit("You've hit your usage limit. Resets at 6pm")).toBe(true);
    expect(looksLikeUsageLimit("Rate limit reached for this organization")).toBe(true);
    expect(looksLikeUsageLimit("Reached max turns (15)")).toBe(false);
    expect(looksLikeUsageLimit("")).toBe(false);
  });
});

describe("createQuotaMonitor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-"));
  const credentialsPath = path.join(dir, "creds.json");
  fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function stubUsage(fiveHour: number, sevenDay: number, resetsAt = "2026-09-22T18:10:00+00:00") {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: fiveHour, resets_at: resetsAt }, seven_day: { utilization: sevenDay, resets_at: "2026-09-28T10:00:00+00:00" } }), { status: 200 })) as unknown as typeof fetch;
  }

  it("warns once per window, switches to Bedrock above the threshold, and exposes a snapshot", async () => {
    const notify = vi.fn(async (_n: { kind: string; message: string; value: number }) => {});
    const q = createQuotaMonitor({ credentialsPath, warnPct: 80, switchPct: 95, notify, log: () => {} });
    stubUsage(37, 21);
    await q.probe();
    expect(q.fallbackActive()).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    stubUsage(85, 21);
    await q.probe();
    await q.probe();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: "warn", value: 85 });
    expect(q.fallbackActive()).toBe(false);
    stubUsage(97, 21);
    await q.probe();
    expect(q.fallbackActive()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatchObject({ kind: "switch" });
    expect(q.snapshot()).toMatchObject({ level: 97, fallbackActive: true, switchPct: 95 });
  });

  it("markExhausted forces Bedrock until the window resets, once", async () => {
    const notify = vi.fn(async (_n: { kind: string; message: string; value: number }) => {});
    const q = createQuotaMonitor({ credentialsPath, warnPct: 80, switchPct: 95, notify, log: () => {} });
    stubUsage(40, 10, new Date(Date.now() + 3600_000).toISOString());
    await q.probe();
    await q.markExhausted("You've hit your usage limit");
    await q.markExhausted("again");
    expect(q.fallbackActive()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(q.snapshot().exhaustedUntil).not.toBeNull();
  });

  it("keeps the last state and reports the error when the endpoint fails", async () => {
    const q = createQuotaMonitor({ credentialsPath, notify: async () => {}, log: () => {} });
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const snap = await q.probe();
    expect(snap.error).toMatch(/500/);
    expect(snap.fallbackActive).toBe(false);
  });
});
