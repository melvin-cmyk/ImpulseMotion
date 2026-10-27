import { describe, expect, it } from "vitest";
import { parseNamingTags, conventionKeys } from "@/lib/ads-warehouse/naming";
import { deriveMetrics } from "@/lib/ads-warehouse/query";

describe("parseNamingTags", () => {
  it("reads Motion-style key:value pairs", () => {
    expect(parseNamingTags("c:Lavender halways_f:Video_o:BOGO_lp:LP_i:Optimus Prime")).toEqual({ c: "Lavender halways", f: "Video", o: "BOGO", lp: "LP", i: "Optimus Prime" });
  });
  it("reads the agency KEY-Value convention and joins repeated keys", () => {
    const t = parseNamingTags("SGL_IMG_S-Pulse_V-CAD_C-Parent_M-Autorité_M-SurMesure_cta-NoCta");
    expect(t.s).toBe("Pulse"); expect(t.v).toBe("CAD"); expect(t.c).toBe("Parent"); expect(t.m).toBe("Autorité | SurMesure"); expect(t.cta).toBe("NoCta");
    expect(t.s1).toBe("SGL"); expect(t.s2).toBe("IMG");
    expect(conventionKeys(t).sort()).toEqual(["c", "cta", "m", "s", "v"]);
  });
  it("reads a convention block inside brackets (TikTok names of the agency)", () => {
    const t = parseNamingTags("W33Y26 - SGL - VID - [g-desti_ca1-maroc_ca2_solo_m-experience_f-testi_h-sionestcommemoi_pc-solo]");
    expect(t.g).toBe("desti"); expect(t.ca1).toBe("maroc"); expect(t.m).toBe("experience"); expect(t.f).toBe("testi"); expect(t.pc).toBe("solo");
    expect(t.s1).toBe("W33Y26"); expect(t.s2).toBe("SGL"); expect(t.s3).toBe("VID");
    expect(Object.values(t).some((v) => v.includes("[") || v.includes("]"))).toBe(false);
  });
  it("keeps positional segments when there is no convention", () => {
    expect(parseNamingTags("UGC_Hook3_Promo_FR")).toEqual({ s1: "UGC", s2: "Hook3", s3: "Promo", s4: "FR" });
  });
  it("does not mistake a dash in a word for a convention", () => {
    expect(parseNamingTags("Black-Friday video")).toEqual({});
    expect(parseNamingTags("Copy of ad - final")).toEqual({ s1: "Copy of ad", s2: "final" });
  });
  it("handles empty names", () => {
    expect(parseNamingTags("")).toEqual({});
    expect(parseNamingTags(null)).toEqual({});
  });
});

describe("deriveMetrics", () => {
  const sums = { spend: 100, impressions: 10000, reach: 5000, clicks: 300, linkClicks: 200, conversions: 10, conversionValue: 0, purchases: 0, purchaseValue: 0, leads: 10, videoPlays: 4000, video3s: 2500, thruPlays: 800, p25: 2000, p50: 1200, p75: 900, p100: 500 };
  it("computes ratios from sums", () => {
    const m = deriveMetrics(sums, null);
    expect(m.ctr).toBe(2); expect(m.ctrAll).toBe(3); expect(m.cpc).toBe(0.5); expect(m.cpm).toBe(10); expect(m.cpa).toBe(10); expect(m.frequency).toBe(2);
    expect(m.hookRate).toBe(25); expect(m.holdRate).toBe(8); expect(m.p100Rate).toBe(5);
    expect(m.roasUnavailable).toBe(true); expect(m.roas).toBe(0);
  });
  it("estimates value with a configured AOV when nothing is tracked", () => {
    const m = deriveMetrics(sums, 50);
    expect(m.estimated).toBe(true); expect(m.conversionValue).toBe(500); expect(m.roas).toBe(5); expect(m.roasUnavailable).toBe(false);
  });
  it("prefers the tracked value", () => {
    const m = deriveMetrics({ ...sums, conversionValue: 800 }, 50);
    expect(m.estimated).toBe(false); expect(m.roas).toBe(8);
  });
});
