import { describe, it, expect } from "vitest";
import { afterFailure, isLocked, LIMITS, WINDOW_MS, LOCK_MS } from "@/lib/login-throttle";
import { evaluateRule } from "@/lib/alerts";
import { isOwnImage } from "@/components/ai/safe-image";
import { detectFromDays } from "@/lib/auto-alerts/detect";

const now = new Date("2026-10-05T12:00:00Z");

describe("limite de connexion", () => {
  it("bloque au 5e échec en 15 min, repart à zéro après la fenêtre", () => {
    let row = null as ReturnType<typeof afterFailure> | null;
    for (let i = 0; i < LIMITS.email - 1; i++) row = afterFailure(row, LIMITS.email, now);
    expect(isLocked(row, now)).toBe(false);
    row = afterFailure(row, LIMITS.email, now);
    expect(isLocked(row, now)).toBe(true);
    expect(isLocked(row, new Date(now.getTime() + LOCK_MS + 1))).toBe(false);
    const later = afterFailure(row, LIMITS.email, new Date(now.getTime() + WINDOW_MS + 1000));
    expect(later.failures).toBe(1);
  });
});

const m = (o: Partial<{ spend: number; roas: number; cpa: number; ctr: number; conversions: number; roasAvailable: boolean }>) =>
  ({ spend: 0, roas: 0, cpa: 0, ctr: 0, frequency: 0, roasAvailable: true, roasEstimated: false, conversions: 0, ...o });

describe("règles d'alerte classiques — pires cas", () => {
  it("ROAS < seuil : se déclenche avec de la dépense et aucune vente", () => {
    expect(evaluateRule("roas", "below", 1.5, m({ spend: 200, roas: 0 }), m({})).triggered).toBe(true);
    expect(evaluateRule("roas", "below", 1.5, m({ spend: 0, roas: 0 }), m({})).triggered).toBe(false);
  });
  it("dépense < seuil : se déclenche quand le compte s'arrête après avoir dépensé, pas sur un compte dormant", () => {
    expect(evaluateRule("spend", "below", 50, m({ spend: 0 }), m({ spend: 300 })).triggered).toBe(true);
    expect(evaluateRule("spend", "below", 50, m({ spend: 0 }), m({ spend: 0 })).triggered).toBe(false);
  });
  it("CPA > seuil : sans aucune conversion, la dépense au-delà du seuil déclenche", () => {
    expect(evaluateRule("cpa", "above", 40, m({ spend: 120, conversions: 0, cpa: 0 }), m({})).triggered).toBe(true);
    expect(evaluateRule("cpa", "above", 40, m({ spend: 20, conversions: 0, cpa: 0 }), m({})).triggered).toBe(false);
    expect(evaluateRule("cpa", "above", 40, m({ spend: 300, conversions: 10, cpa: 30 }), m({})).triggered).toBe(false);
  });
});

describe("images des réponses de l'IA", () => {
  it("seules les images de l'application sont chargées", () => {
    expect(isOwnImage("/api/ai/files/x.png")).toBe(true);
    expect(isOwnImage("data:image/png;base64,AAAA")).toBe(true);
    expect(isOwnImage("https://evil.example/?d=secret")).toBe(false);
    expect(isOwnImage("//evil.example/x.png")).toBe(false);
  });
});

describe("devise sans taux de change", () => {
  it("un compte dans une devise inconnue n'est pas jugé (ni fausse alerte, ni euros supposés)", () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(20 + i).padStart(2, "0")}`, spend: i < 9 ? 50000 : 0, conversions: 5, revenue: null }));
    expect(detectFromDays({ platform: "meta", full: full as never, today: { spend: 0, hour: 12 }, currency: "KZT" })).toEqual([]);
  });
});
