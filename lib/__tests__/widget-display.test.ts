import { describe, expect, it } from "vitest";
import {
  emptyMessage, failedPlatforms, kpiValueClass, pacingView, partialNote,
} from "@/components/dashboard/widget-display";
import { fmtMetric, fmtMoney, fmtRoas } from "@/components/portfolio/format";

describe("failedPlatforms()", () => {
  it("names the platforms the resolver could not reach", () => {
    expect(failedPlatforms(["Google: relay timeout"])).toEqual(["Google"]);
    expect(failedPlatforms(["Meta: token expiré", "Google: 500"])).toEqual(["Meta", "Google"]);
    expect(failedPlatforms(["Devises différentes: Meta EUR / Google ZAR"])).toEqual([]);
    expect(failedPlatforms(undefined)).toEqual([]);
  });
});

describe("emptyMessage()", () => {
  it("says « pas de données » only when nothing failed", () => {
    expect(emptyMessage({})).toBe("Pas de données sur la période");
    expect(emptyMessage({}, "Pas de créas actives sur la période")).toBe("Pas de créas actives sur la période");
  });

  it("names the outage instead of an absence of traffic", () => {
    const msg = emptyMessage({ partial: true, errors: ["Google: 500"] });
    expect(msg).toContain("Google");
    expect(msg).toContain("indisponibles");
    expect(msg).not.toContain("Pas de données");
  });
});

describe("partialNote()", () => {
  it("is silent on a complete payload", () => {
    expect(partialNote({})).toBeNull();
    expect(partialNote({ currency: "ZAR" })).toBeNull();
  });

  it("warns that the rates below exclude the failed source", () => {
    const note = partialNote({ partial: true, errors: ["Google: quota"] });
    expect(note).toContain("Google");
    expect(note).toContain("les totaux et les taux");
  });
});

describe("kpiValueClass()", () => {
  it("never paints an unavailable KPI red", () => {
    expect(kpiValueClass("roas", 0, { unavailable: true })).toBe("text-gray-500");
    expect(kpiValueClass("roas", 0.4, { unavailable: true })).toBe("text-gray-500");
  });

  it("keeps the ROAS judgement on real values", () => {
    expect(kpiValueClass("roas", 2.5)).toBe("text-emerald-400");
    expect(kpiValueClass("roas", 0.4)).toBe("text-red-400");
    expect(kpiValueClass("roas", 0)).toBe("text-white");
    expect(kpiValueClass("spend", 0.4)).toBe("text-white");
  });
});

describe("pacingView()", () => {
  it("translates a status instead of showing the raw key", () => {
    expect(pacingView({ status: "critical_under" })).toMatchObject({ unknown: false, label: "Très en retard", tone: "red" });
    expect(pacingView({ status: "on_track" })).toMatchObject({ label: "Dans la cible", tone: "emerald" });
    expect(pacingView({ status: "over" }).tone).toBe("amber");
  });

  it("surfaces the reason when Meta did not answer", () => {
    const v = pacingView({ status: "unknown", reason: "token Meta expiré" });
    expect(v).toMatchObject({ unknown: true, label: "Inconnu", tone: "default", reason: "token Meta expiré" });
    expect(pacingView({ status: "unknown" }).reason).toBe("données indisponibles");
  });
});

describe("widget amounts follow the account currency", () => {
  it("renders a ZAR account in ZAR and never falls back to €", () => {
    const spend = fmtMoney(85_000, "ZAR", { digits: 0 });
    expect(spend).toContain("ZAR");
    expect(spend).not.toContain("€");
    expect(fmtMetric("cpa", 12.5, "ZAR")).toContain("ZAR");
  });

  it("shows the bare number when no currency reached the payload", () => {
    const spend = fmtMoney(85_000, undefined, { digits: 0 });
    expect(spend).not.toContain("€");
    expect(spend.replace(/\s/g, "")).toBe("85000");
  });

  it("shows « — » for an unavailable ROAS instead of 0.0x", () => {
    expect(fmtRoas(0, { unavailable: true })).toBe("—");
    expect(fmtRoas(0)).toBe("—");
    expect(fmtRoas(2.4, { estimated: true })).toBe("2,4x*");
  });
});
