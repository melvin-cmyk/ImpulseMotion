import { describe, expect, it } from "vitest";
import { cleanMulti, cleanValue, isGlossaryKey, replaceInTag } from "@/lib/ads-warehouse/glossary";

describe("glossary", () => {
  it("renames, merges and removes inside multi-valued tags", () => {
    expect(replaceInTag("UGC", "ugc", "Témoignage")).toBe("Témoignage");
    expect(replaceInTag("UGC | Démo", "UGC", "Démo")).toBe("Démo");
    expect(replaceInTag("UGC | Démo", "Démo", null)).toBe("UGC");
    expect(replaceInTag("UGC", "UGC", null)).toBeNull();
  });
  it("cleans values", () => {
    expect(cleanValue("  a |  b ")).toBe("a b");
    expect(cleanValue("   ")).toBeNull();
    expect(cleanMulti("UGC | ugc |  Démo ")).toBe("UGC | Démo");
    expect(isGlossaryKey("ai:msg")).toBe(true);
    expect(isGlossaryKey("c")).toBe(false);
  });
});
