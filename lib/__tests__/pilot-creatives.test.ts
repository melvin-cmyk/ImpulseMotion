import { describe, expect, it } from "vitest";
import { flagOf, type CreativeWindow } from "@/lib/pilot/creatives";

const w = (over: Partial<CreativeWindow> = {}): CreativeWindow => ({ spend: 300, impressions: 20_000, clicks: 300, ctr: 1.5, frequency: 1.8, conversions: 10, cpa: 30, ...over });

describe("créas — ce que les chiffres disent", () => {
  it("dépense sans conversion, fatigue, gagnante, nouvelle, rien", () => {
    expect(flagOf(w({ conversions: 0, cpa: null }), w()).flag).toBe("burn");
    expect(flagOf(w({ frequency: 3.1, ctr: 1.0 }), w({ ctr: 1.5 })).flag).toBe("fatigue");
    expect(flagOf(w({ frequency: 3.1, ctr: 1.4 }), w({ ctr: 1.5 })).flag).toBeNull();
    expect(flagOf(w({ cpa: 20 }), w({ cpa: 30 })).flag).toBe("winner");
    expect(flagOf(w(), null).flag).toBe("new");
    expect(flagOf(w({ impressions: 500, spend: 10, conversions: 0, cpa: null, clicks: 5 }), null).flag).toBeNull();
    expect(flagOf(w(), w()).flag).toBeNull();
  });
});
