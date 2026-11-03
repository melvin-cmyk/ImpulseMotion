import { describe, expect, it } from "vitest";
import { cleanRef, toEntry, PLAYBOOK_KEY_RE } from "@/lib/ads-warehouse/playbook";

describe("playbook", () => {
  it("accepts report keys only", () => {
    expect(PLAYBOOK_KEY_RE.test("client:cmul7aayw000j6m0kgk9owvke")).toBe(true);
    expect(PLAYBOOK_KEY_RE.test("meta:630401743416154")).toBe(true);
    expect(PLAYBOOK_KEY_RE.test("google:123")).toBe(false);
    expect(PLAYBOOK_KEY_RE.test("client:x' OR 1=1")).toBe(false);
  });
  it("keeps only safe image and link URLs", () => {
    expect(cleanRef({ imageUrl: "javascript:alert(1)", linkUrl: "//evil.com", label: "a" })).toEqual({ label: "a" });
    expect(cleanRef({ imageUrl: "/api/ads/image?adId=1", linkUrl: "/analyse?creative=v%3A1", creativeKey: "v:1" })).toEqual({ imageUrl: "/api/ads/image?adId=1", linkUrl: "/analyse?creative=v%3A1", creativeKey: "v:1" });
    expect(cleanRef(null)).toEqual({});
  });
  it("maps a row, tolerating a broken ref", () => {
    const e = toEntry({ id: "1", status: "review", source: "weird", title: "t", userNote: "", aiNote: "n", refJson: "{oops", createdByName: "IA", statusByName: "", createdAt: new Date("2026-11-03T10:00:00Z") });
    expect(e.source).toBe("manual");
    expect(e.ref).toEqual({});
    expect(e.createdAt).toBe("2026-11-03T10:00:00.000Z");
  });
});
