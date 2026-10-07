import { describe, expect, it } from "vitest";
import { describeRule, readRule, ruleFires } from "@/lib/pilot/rules";
import type { ComputedMetrics } from "@/lib/alerts";

const m = (over: Partial<ComputedMetrics> = {}): ComputedMetrics => ({ spend: 500, roas: 2.5, cpa: 50, ctr: 1.2, frequency: 1.5, roasAvailable: true, roasEstimated: false, conversions: 10, ...over });

describe("règles automatiques", () => {
  it("lit une règle et refuse ce qui ne tient pas", () => {
    const ok = readRule({ name: "CPA trop haut", platform: "meta", accountId: "act_1", objectType: "campaign", metric: "cpa", op: "gt", threshold: "40,5", days: 7, action: "budget_pct", actionValue: -20, cooldownDays: 3 });
    expect(ok).toMatchObject({ ok: true, rule: { threshold: 40.5, action: "budget_pct", actionValue: -20, minConversions: 5, objectId: null, enabled: true } });
    expect(readRule({ name: "x", platform: "tiktok", accountId: "1", objectType: "campaign", metric: "cpa", op: "gt", threshold: 1, days: 7, action: "pause" }).ok).toBe(false);
    expect(readRule({ name: "x", platform: "meta", accountId: "1", objectType: "campaign", metric: "cpa", op: "gt", threshold: 1, days: 3, action: "pause" }).ok).toBe(false);
    expect(readRule({ name: "x", platform: "meta", accountId: "1", objectType: "campaign", metric: "cpa", op: "gt", threshold: 1, days: 7, action: "budget_pct", actionValue: 0 }).ok).toBe(false);
  });

  it("déclenche sur le seuil, jamais sur un CPA sans assez de conversions, jamais sur un ROAS inconnu", () => {
    const rule = { metric: "cpa" as const, op: "gt" as const, threshold: 40, minConversions: 5 };
    expect(ruleFires(rule, m({ cpa: 52 }))).toMatchObject({ fires: true, value: 52 });
    expect(ruleFires(rule, m({ cpa: 30 })).fires).toBe(false);
    expect(ruleFires(rule, m({ cpa: 52, conversions: 3 })).fires).toBe(false);
    expect(ruleFires({ ...rule, metric: "roas", op: "lt", threshold: 2 }, m({ roas: 1, roasAvailable: false })).fires).toBe(false);
    expect(ruleFires({ ...rule, metric: "spend", op: "gt", threshold: 400, minConversions: 0 }, m({ conversions: 0 })).fires).toBe(true);
    expect(ruleFires(rule, m({ cpa: 52 })).reason).toContain("CPA 52 > 40");
  });

  it("dit la règle en une ligne", () => {
    expect(describeRule({ metric: "cpa", op: "gt", threshold: 40, days: 7, action: "budget_pct", actionValue: -20, objectType: "campaign", objectName: null }, "EUR").replace(/[  ]/g, " ")).toBe("Si CPA de chaque campagne sur 7 j dépasse 40 € → budget -20 %");
    expect(describeRule({ metric: "roas", op: "lt", threshold: 2, days: 14, action: "pause", actionValue: null, objectType: "adset", objectName: "Retargeting" })).toBe("Si ROAS de « Retargeting » sur 14 j passe sous 2.00× → mettre en pause");
  });
});
