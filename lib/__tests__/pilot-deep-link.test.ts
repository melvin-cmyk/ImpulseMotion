import { describe, it, expect } from "vitest";
import { buildPilotHref, readPilotLink, platformObjectUrl, platformOfAccountId, stepPrompt } from "@/lib/pilot/deep-link";

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

  it("« Mettre en ligne » : ?do=activate&ad=<id> nomme l'annonce ; object= garde la main", () => {
    expect(readPilotLink("?client=c1&do=activate&ad=120200000000003")).toEqual({ client: "c1", do: "activate", object: { type: "ad", id: "120200000000003" } });
    expect(readPilotLink("?do=activate&ad=abc")).toEqual({ do: "activate" });
    expect(readPilotLink("?object=adset:1&ad=2")).toEqual({ object: { type: "adset", id: "1" } });
    const href = buildPilotHref({ client: "c1", platform: "meta", account: "act_1668772300254268", object: { type: "ad", id: "120200000000003" }, do: "activate" });
    expect(readPilotLink(href.slice(href.indexOf("?")))).toMatchObject({ do: "activate", object: { type: "ad", id: "120200000000003" } });
  });

  it("donne le lien d'un objet dans le Gestionnaire Meta, rien pour les autres plateformes", () => {
    expect(platformObjectUrl("meta", "act_1668772300254268", "ad", "120200000000003")).toBe("https://adsmanager.facebook.com/adsmanager/manage/ads?act=1668772300254268&selected_ad_ids=120200000000003");
    expect(platformObjectUrl("meta", "1668772300254268", "campaign", "23857030053030567")).toContain("manage/campaigns?act=1668772300254268&selected_campaign_ids=23857030053030567");
    expect(platformObjectUrl("google", "6823803493", "ad", "1")).toBeNull();
    expect(platformObjectUrl("meta", "act_1", "ad", "../x")).toBeNull();
  });

  it("formule la question de l'IA à partir d'une étape de rapport", () => {
    expect(stepPrompt({ title: "Couper la campagne X", detail: "CPA 80 €." })).toContain("« Couper la campagne X ». CPA 80 €.");
  });
});
