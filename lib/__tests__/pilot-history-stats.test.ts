import { describe, expect, it } from "vitest";
import { categoryOf, deltaPct, historyCsv, historyStats, movingAverage, summarizeSession } from "@/lib/pilot/history-stats";
import type { PilotActionView } from "@/lib/pilot/service";
import type { DailyPoint, PlatformChangeView } from "@/lib/pilot/history";

const change = (over: Partial<PlatformChangeView>): PlatformChangeView => ({
  id: "c1", platform: "meta", accountId: "1", alertClientId: "k", currency: "EUR", at: "2026-10-05T20:08:00.000Z", actorName: "Nael", actorEmail: null, via: "HubSpot Ads",
  source: "external", sourceText: "hors ImpulseMotion", pilotActionId: null, objectType: "ad", objectId: "9", objectName: "Annonce A", eventType: "update_ad_creative", field: "creative",
  before: null, after: "x", line: "🖼 …", significant: true, note: "", noteByName: null, noteAt: null, hqWrittenAt: null, hqError: null, impacts: [], ...over,
});
const action = (over: Partial<PilotActionView>): PilotActionView => ({
  id: "a1", alertClientId: "k", clientName: "Client", platform: "meta", accountId: "1", accountName: "Compte", currency: "EUR", createdByName: "Marina", createdByEmail: null, mine: false,
  status: "done", why: "test", goal: { metric: null, target: null, note: "" }, needsDouble: false, doubleReasons: [], hqProject: null, hqWrittenAt: null, hqError: null, undoOfId: null, undoneById: null,
  executedAt: "2026-10-02T10:46:00.000Z", createdAt: "2026-10-02T10:46:00.000Z", expiresAt: null, scheduledAt: null, revertAt: null, revertedAt: null, ruleId: null,
  operations: [{ id: "o1", kind: "set_daily_budget", objectType: "adset", objectId: "2", objectName: "Ensemble B", parentName: "", field: "daily_budget", before: 1000, after: 1200, readBack: 1200, status: "done", error: null, line: "💶 …", double: null, irreversible: false }],
  impacts: [{ horizon: 7, status: "done", verdict: "improved", summary: "", computedAt: null, dueOn: null, hqWritten: false, result: null }], ...over,
});

describe("historique — statistiques", () => {
  it("classe les réglages et résume une session", () => {
    expect(categoryOf("daily_budget")).toBe("budget");
    expect(categoryOf("status", "DELETED")).toBe("suppression");
    expect(categoryOf("rsa")).toBe("créa");
    expect(summarizeSession([{ field: "creative" }, { field: "creative" }, { field: "daily_budget" }, { field: "status", after: "PAUSED" }, { field: "status", after: "PAUSED" }, { field: "status", after: "PAUSED" }])).toBe("3 statuts, 2 créas, 1 budget");
  });

  it("compte par source, par personne, par objet, par réglage ; une modif rattachée à une action n'est comptée qu'une fois", () => {
    const stats = historyStats(
      [action({})],
      [change({ id: "c1" }), change({ id: "c2", objectName: "Annonce C", field: "status", after: "PAUSED" }), change({ id: "c3", pilotActionId: "a1", source: "impulsemotion", sourceText: "ImpulseMotion", actorName: "Conversion api" }), change({ id: "c4", source: "automated", sourceText: "automatique", actorName: "Meta" })],
      null,
    );
    expect(stats.bySource).toEqual({ impulsemotion: 1, external: 2, automated: 1 });
    expect(stats.actors[0]).toEqual({ name: "Nael", count: 2, source: "external" });
    expect(stats.objects.map((o) => o.name)).toContain("Ensemble B");
    expect(stats.byCategory.find((c) => c.category === "créa")?.count).toBe(2);
    expect(stats.verdicts).toEqual([{ verdict: "improved", label: "en progrès", count: 1 }]);
    expect(stats.last7).toBeNull();
  });

  it("7 derniers jours pleins contre les 7 d'avant, moyenne mobile sur les sommes", () => {
    const points: DailyPoint[] = Array.from({ length: 16 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, spend: 100, conversions: i < 8 ? 2 : 4, revenue: null }));
    const s = historyStats([], [], points);
    expect(s.prev7).toMatchObject({ spend: 700, conversions: 14, cpa: 50, days: 7 });
    expect(s.last7).toMatchObject({ spend: 700, conversions: 28, cpa: 25 });
    expect(deltaPct(50, 25)).toBe(-50);
    const avg = movingAverage(points, "cpa", 7);
    expect(avg[5]).toBeNull();
    expect(avg[6]).toBe(50);
    expect(avg[15]).toBe(25);
    expect(movingAverage(points, "spend", 7)[6]).toBe(100);
  });

  it("exporte un CSV lisible par Excel", () => {
    const csv = historyCsv([action({})], [change({ id: "c1", note: 'test "guillemets"' })]);
    const lines = csv.split("\n");
    expect(lines[0].startsWith("﻿date;source;auteur")).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Nael;HubSpot Ads;meta;1;ad;Annonce A;creative;;x;\"test \"\"guillemets\"\"\"");
    expect(lines[2]).toContain("ImpulseMotion;Marina;Pilotage;meta;Compte;adset;Ensemble B;daily_budget;1000;1200;test;en progrès;");
  });
});
