import { describe, it, expect } from "vitest";
import { buildPilotHref, readPilotLink, platformOfAccountId, stepPrompt } from "@/lib/pilot/deep-link";

describe("liens vers le pilotage", () => {
  it("construit et relit un lien complet", () => {
    const href = buildPilotHref({ platform: "meta", account: "act_123456", object: { type: "campaign", id: "987" }, do: "pause", prompt: "Baisse le budget", step: { reportId: "r1", stepId: "ns-2" } });
    expect(href.startsWith("/pilotage?")).toBe(true);
    expect(readPilotLink(href.slice(href.indexOf("?")))).toEqual({
      platform: "meta", account: "act_123456", object: { type: "campaign", id: "987" }, do: "pause", prompt: "Baisse le budget", step: { reportId: "r1", stepId: "ns-2" },
    });
  });

  it("ignore ce qui n'est pas lisible, sans deviner", () => {
    expect(readPilotLink("?platform=tiktok&object=campaign:abc&do=delete&client=../x&preview=ok-1")).toEqual({ preview: "ok-1" });
    expect(buildPilotHref({})).toBe("/pilotage");
  });

  it("reconnaît la plateforme d'un identifiant de compte d'alerte", () => {
    expect(platformOfAccountId("act_1668772300254268")).toBe("meta");
    expect(platformOfAccountId("682-380-3493")).toBe("google");
    expect(platformOfAccountId("6823803493")).toBe("google");
    expect(platformOfAccountId("7012345678901234567")).toBe("tiktok");
    expect(platformOfAccountId("x")).toBeNull();
  });

  it("formule la question de l'IA à partir d'une étape de rapport", () => {
    expect(stepPrompt({ title: "Couper la campagne X", detail: "CPA 80 €." })).toContain("« Couper la campagne X ». CPA 80 €.");
  });
});
