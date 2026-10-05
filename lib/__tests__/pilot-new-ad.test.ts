import { describe, it, expect } from "vitest";
import { describeOperation, inverseRequest, prepareOperation, readNewAd, readRequest, type PilotObjectState } from "@/lib/pilot/ops";
import { extractPilotProposals } from "@/lib/pilot/assistant";

const adset: PilotObjectState = { id: "120200000000001", type: "adset", accountId: "1668772300254268", name: "IA - Broad", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: 1000, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "Campagne A" };
const spec = { name: "Gourde plage", primaryText: "Fraîcheur garantie tout l'été", linkUrl: "https://naturalia.fr/gourde", imageUrl: "https://platform-outputs.agnes-ai.space/images/x.png", pageId: "123456789", callToAction: "SHOP_NOW" };

describe("Pilotage — nouvelle publicité Meta", () => {
  it("lit la publicité et refuse ce qui manque", () => {
    expect(readNewAd(JSON.stringify(spec))).toMatchObject({ ok: true, spec: { name: "Gourde plage", pageId: "123456789" } });
    expect(readNewAd(JSON.stringify({ ...spec, linkUrl: "http://x.fr" }))).toMatchObject({ ok: false });
    expect(readNewAd(JSON.stringify({ ...spec, imageUrl: "" }))).toMatchObject({ ok: false });
    expect(readNewAd(JSON.stringify({ ...spec, pageId: "" }))).toMatchObject({ ok: false, error: "Choisissez la Page Facebook de la publicité." });
    expect(readNewAd("pas du json")).toMatchObject({ ok: false });
  });

  it("une opération sur un ensemble Meta, sans seconde confirmation (créée en pause), jamais sur Google ni une campagne", () => {
    const req = readRequest({ kind: "create_ad", objectType: "adset", objectId: adset.id, value: JSON.stringify(spec) })!;
    const p = prepareOperation(req, adset, "EUR", new Date(), "meta");
    expect(p).toMatchObject({ ok: true, op: { field: "new_ad", before: null, double: null, irreversible: false } });
    expect(prepareOperation(req, adset, "EUR", new Date(), "google").ok).toBe(false);
    expect(prepareOperation({ ...req, objectType: "campaign" }, { ...adset, type: "campaign" }, "EUR").ok).toBe(false);
    if (!p.ok) return;
    expect(describeOperation(p.op, "EUR")).toBe("🆕 Ensemble de publicités « IA - Broad » (Campagne A) — nouvelle publicité « Gourde plage » (créée en pause)");
    expect(inverseRequest(p.op, "EUR")).toBeNull();
  });

  it("l'IA ne peut pas proposer de création", () => {
    const text = '```pilot\n{"platform":"meta","accountId":"1","requests":[{"kind":"create_ad","objectType":"adset","objectId":"120200000000001","value":"{}"}]}\n```';
    expect(extractPilotProposals(text)[0]).toMatchObject({ ok: false });
  });
});
