import { describe, expect, it } from "vitest";
import {
  ACTIVATION_DOUBLE, DYNAMIC_TEXTS_LOCKED, budgetDouble, describeOperation, doubleReason, inverseRequest, isActivation, newAdLabel, prepareOperation, readGoal, readRequest, sameValue,
  type PilotObjectState,
} from "@/lib/pilot/ops";
import { adFormat } from "@/lib/pilot/meta";
import { buildHqEntry } from "@/lib/pilot/hq-entry";

const NOW = new Date("2026-10-02T10:00:00Z");

const campaign = (over: Partial<PilotObjectState> = {}): PilotObjectState => ({
  id: "1200001", type: "campaign", accountId: "555", name: "Prospection", status: "ACTIVE", effectiveStatus: "ACTIVE",
  dailyBudget: 12000, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "", ...over,
});
const adset = (over: Partial<PilotObjectState> = {}): PilotObjectState => ({
  id: "1200002", type: "adset", accountId: "555", name: "Retargeting 30j", status: "ACTIVE", effectiveStatus: "ACTIVE",
  dailyBudget: null, lifetimeBudget: null, endTime: null, bidAmount: 250, parentName: "Prospection", ...over,
});
const ad = (over: Partial<PilotObjectState> = {}): PilotObjectState => ({
  id: "1200003", type: "ad", accountId: "555", name: "UGC Julie v3", status: "ACTIVE", effectiveStatus: "ACTIVE",
  dailyBudget: null, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "Retargeting 30j", ...over,
});

describe("pilotage — lecture des demandes", () => {
  it("ne lit qu'un changement connu, sur un objet nommé par un identifiant numérique", () => {
    expect(readRequest({ kind: "set_status", objectType: "ad", objectId: "1200003", value: "PAUSED" })).toEqual({ kind: "set_status", objectType: "ad", objectId: "1200003", value: "PAUSED" });
    expect(readRequest({ kind: "delete_account", objectType: "ad", objectId: "1200003", value: "x" })).toBeNull();
    expect(readRequest({ kind: "set_status", objectType: "account", objectId: "1200003", value: "PAUSED" })).toBeNull();
    expect(readRequest({ kind: "set_status", objectType: "ad", objectId: "act_1/../x", value: "PAUSED" })).toBeNull();
    expect(readRequest({ kind: "set_status", objectType: "ad", objectId: "1200003", value: { evil: true } })).toBeNull();
  });

  it("lit l'objectif sans jamais le rendre obligatoire", () => {
    expect(readGoal({ metric: "cpa", target: "45,5", note: " sous 45 € " })).toEqual({ metric: "cpa", target: 45.5, note: "sous 45 €" });
    expect(readGoal({ metric: "vanity", target: "abc" })).toEqual({ metric: null, target: null, note: "" });
  });
});

describe("pilotage — préparer un changement contre l'état réel", () => {
  it("met en pause une annonce : valeur avant et après, sans seconde confirmation", () => {
    const r = prepareOperation({ kind: "set_status", objectType: "ad", objectId: "1200003", value: "PAUSED" }, ad(), "EUR", NOW);
    expect(r).toMatchObject({ ok: true, op: { field: "status", before: "ACTIVE", after: "PAUSED", double: null, irreversible: false, parentName: "Retargeting 30j" } });
  });

  it("demande une seconde confirmation pour arrêter une campagne entière et pour toute suppression", () => {
    const stop = prepareOperation({ kind: "set_status", objectType: "campaign", objectId: "1200001", value: "PAUSED" }, campaign(), "EUR", NOW);
    expect(stop.ok && stop.op.double).toBe("arrêt d'une campagne entière");
    const del = prepareOperation({ kind: "set_status", objectType: "ad", objectId: "1200003", value: "DELETED" }, ad(), "EUR", NOW);
    expect(del.ok && del.op).toMatchObject({ double: "suppression", irreversible: true });
    // Pausing an ad set or reactivating a campaign is an ordinary change.
    expect(prepareOperation({ kind: "set_status", objectType: "campaign", objectId: "1200001", value: "ACTIVE" }, campaign({ status: "PAUSED" }), "EUR", NOW)).toMatchObject({ ok: true, op: { double: null } });
  });

  it("budget : en centimes comme Meta, seconde confirmation au-delà de +50 % ou de +300 €/jour", () => {
    const small = prepareOperation({ kind: "set_daily_budget", objectType: "campaign", objectId: "1200001", value: 150 }, campaign(), "EUR", NOW);
    expect(small).toMatchObject({ ok: true, op: { field: "daily_budget", before: 12000, after: 15000, double: null } });
    const ratio = prepareOperation({ kind: "set_daily_budget", objectType: "campaign", objectId: "1200001", value: "181" }, campaign(), "EUR", NOW);
    expect(ratio.ok && ratio.op.double).toMatch(/50 %/);
    const big = prepareOperation({ kind: "set_daily_budget", objectType: "campaign", objectId: "1200001", value: 1400 }, campaign({ dailyBudget: 100000 }), "EUR", NOW);
    expect(big.ok && big.op.double).toMatch(/300 EUR/);
    // A lower budget never asks twice.
    expect(budgetDouble(100000, 10000, "EUR")).toBeNull();
    expect(budgetDouble(100000, 140000, "EUR")).toMatch(/300/);
    expect(budgetDouble(100000, 129000, "EUR")).toBeNull();
  });

  it("refuse un budget sur le mauvais niveau, en le disant", () => {
    expect(prepareOperation({ kind: "set_daily_budget", objectType: "adset", objectId: "1200002", value: 50 }, adset(), "EUR", NOW))
      .toMatchObject({ ok: false, error: expect.stringContaining("porté par sa campagne") });
    expect(prepareOperation({ kind: "set_lifetime_budget", objectType: "campaign", objectId: "1200001", value: 50 }, campaign(), "EUR", NOW))
      .toMatchObject({ ok: false, error: expect.stringContaining("budget journalier, pas total") });
    expect(prepareOperation({ kind: "set_daily_budget", objectType: "ad", objectId: "1200003", value: 50 }, ad(), "EUR", NOW).ok).toBe(false);
  });

  it("refuse ce qui ne changerait rien, un objet supprimé, une date passée, une enchère automatique", () => {
    expect(prepareOperation({ kind: "set_status", objectType: "ad", objectId: "1200003", value: "ACTIVE" }, ad(), "EUR", NOW)).toMatchObject({ ok: false, error: expect.stringContaining("déjà active") });
    expect(prepareOperation({ kind: "set_status", objectType: "ad", objectId: "1200003", value: "PAUSED" }, ad({ status: "DELETED" }), "EUR", NOW).ok).toBe(false);
    expect(prepareOperation({ kind: "set_end_time", objectType: "adset", objectId: "1200002", value: "2026-10-01T10:00:00Z" }, adset(), "EUR", NOW).ok).toBe(false);
    expect(prepareOperation({ kind: "set_bid_amount", objectType: "adset", objectId: "1200002", value: 3 }, adset({ bidAmount: null }), "EUR", NOW).ok).toBe(false);
    expect(prepareOperation({ kind: "rename", objectType: "ad", objectId: "1200003", value: "  UGC  Julie v3 " }, ad(), "EUR", NOW).ok).toBe(false);
    expect(prepareOperation({ kind: "set_status", objectType: "adset", objectId: "1200003", value: "PAUSED" }, ad(), "EUR", NOW).ok).toBe(false);
  });

  it("date de fin : stop_time sur une campagne, end_time sur un ensemble", () => {
    const c = prepareOperation({ kind: "set_end_time", objectType: "campaign", objectId: "1200001", value: "2026-10-20T22:00:00Z" }, campaign(), "EUR", NOW);
    expect(c.ok && c.op.field).toBe("stop_time");
    const a = prepareOperation({ kind: "set_end_time", objectType: "adset", objectId: "1200002", value: "2026-10-20T22:00:00Z" }, adset(), "EUR", NOW);
    expect(a.ok && a.op).toMatchObject({ field: "end_time", before: null, after: "2026-10-20T22:00:00.000Z" });
  });
});

describe("pilotage — annulation et lecture", () => {
  it("remet la valeur d'avant, jamais après une suppression ni sur une date qui n'existait pas", () => {
    expect(inverseRequest({ kind: "set_daily_budget", objectType: "campaign", objectId: "1200001", field: "daily_budget", before: 12000, after: 15000 }, "EUR"))
      .toEqual({ kind: "set_daily_budget", objectType: "campaign", objectId: "1200001", value: 120 });
    expect(inverseRequest({ kind: "set_status", objectType: "ad", objectId: "1200003", field: "status", before: "ACTIVE", after: "PAUSED" }, "EUR"))
      .toEqual({ kind: "set_status", objectType: "ad", objectId: "1200003", value: "ACTIVE" });
    expect(inverseRequest({ kind: "set_status", objectType: "ad", objectId: "1200003", field: "status", before: "ACTIVE", after: "DELETED" }, "EUR")).toBeNull();
    expect(inverseRequest({ kind: "set_end_time", objectType: "adset", objectId: "1200002", field: "end_time", before: null, after: "2026-10-20T22:00:00Z" }, "EUR")).toBeNull();
  });

  it("compare les dates comme des instants", () => {
    expect(sameValue("end_time", "2026-10-20T22:00:00+0000", "2026-10-20T22:00:00.000Z")).toBe(true);
    expect(sameValue("daily_budget", "15000", 15000)).toBe(true);
    expect(sameValue("status", "PAUSED", "ACTIVE")).toBe(false);
  });

  it("décrit chaque changement en une ligne lisible", () => {
    expect(describeOperation({ kind: "set_daily_budget", objectType: "campaign", objectName: "Prospection", field: "daily_budget", before: 12000, after: 15000 }, "EUR"))
      .toMatch(/Campagne « Prospection » — budget journalier : 120\s€\/jour → 150\s€\/jour/);
    expect(describeOperation({ kind: "set_status", objectType: "ad", objectName: "UGC", parentName: "Retargeting", field: "status", before: "ACTIVE", after: "PAUSED" }, "EUR"))
      .toBe("⏸ Annonce « UGC » (Retargeting) — statut : active → en pause");
    expect(doubleReason({ objectType: "adset", field: "status", before: "ACTIVE", after: "PAUSED" }, "EUR")).toBeNull();
  });
});

describe("pilotage — l'entrée HQ", () => {
  it("nomme la personne, dit chaque changement, son issue, pourquoi et l'objectif", () => {
    const text = buildHqEntry({
      id: "clxyz123456789", clientName: "LPEV", platform: "meta", accountName: "LPEV Meta", accountId: "555", currency: "EUR",
      authorName: "Léa Martin", authorEmail: "lea@impulse-analytics.com", executedAt: new Date("2026-10-02T12:32:00Z"),
      why: "créas fatiguées", goal: { metric: "cpa", target: 45, note: "" }, undoOf: null,
      operations: [
        { kind: "set_status", objectType: "ad", objectName: "UGC Julie v3", parentName: "Retargeting 30j", field: "status", before: "ACTIVE", after: "PAUSED", status: "done", error: null },
        { kind: "set_daily_budget", objectType: "campaign", objectName: "Prospection", parentName: "", field: "daily_budget", before: 12000, after: 15000, status: "failed", error: "Refusé par Meta : budget trop bas" },
      ],
    });
    expect(text).toContain("**Fait par Léa Martin (lea@impulse-analytics.com)** le 02/10/2026 14:32");
    expect(text).toContain("⏸ Annonce « UGC Julie v3 » (Retargeting 30j) — statut : active → en pause — ✅ appliqué");
    expect(text).toContain("❌ refusé (Refusé par Meta : budget trop bas)");
    expect(text).toContain("**Pourquoi** : créas fatiguées");
    expect(text).toContain("**Objectif** : CPA visé : 45");
  });
});

describe("pilotage — mise en ligne d'une annonce (lot 3) et formats", () => {
  it("activer une annonce demande la seconde confirmation (la dépense commence) ; un ensemble ou une campagne non", () => {
    const r = prepareOperation({ kind: "set_status", objectType: "ad", objectId: "1200003", value: "ACTIVE" }, ad({ status: "PAUSED", effectiveStatus: "PAUSED" }), "EUR", NOW);
    expect(r).toMatchObject({ ok: true, op: { field: "status", before: "PAUSED", after: "ACTIVE", double: ACTIVATION_DOUBLE, irreversible: false } });
    expect(doubleReason({ objectType: "ad", field: "status", before: "PAUSED", after: "ACTIVE" }, "EUR")).toBe(ACTIVATION_DOUBLE);
    expect(doubleReason({ objectType: "adset", field: "status", before: "PAUSED", after: "ACTIVE" }, "EUR")).toBeNull();
    expect(doubleReason({ objectType: "campaign", field: "status", before: "PAUSED", after: "ACTIVE" }, "EUR")).toBeNull();
    // Pausing an ad stays an ordinary change.
    expect(doubleReason({ objectType: "ad", field: "status", before: "ACTIVE", after: "PAUSED" }, "EUR")).toBeNull();
    expect(isActivation({ objectType: "ad", field: "status", after: "ACTIVE" })).toBe(true);
    expect(isActivation({ objectType: "ad", field: "status", after: "PAUSED" })).toBe(false);
  });

  it("se décrit « mise en ligne de la publicité « X » » dans l'aperçu, le journal et HQ", () => {
    expect(describeOperation({ kind: "set_status", objectType: "ad", objectName: "UGC Julie v3", parentName: "Retargeting 30j", field: "status", before: "PAUSED", after: "ACTIVE" }, "EUR"))
      .toBe("▶️ Annonce « UGC Julie v3 » (Retargeting 30j) — mise en ligne de la publicité « UGC Julie v3 » : en pause → active");
    // The undo of an activation (back to paused) keeps the ordinary wording.
    expect(describeOperation({ kind: "set_status", objectType: "ad", objectName: "UGC", field: "status", before: "ACTIVE", after: "PAUSED" }, "EUR")).toBe("⏸ Annonce « UGC » — statut : active → en pause");
    const text = buildHqEntry({
      id: "clxyz123456789", clientName: "Naturalia", platform: "meta", accountName: "Naturalia IA", accountId: "555", currency: "EUR",
      authorName: "Léa Martin", authorEmail: null, executedAt: new Date("2026-10-28T12:00:00Z"), why: "créa validée", goal: { metric: null, target: null, note: "" }, undoOf: null,
      operations: [{ kind: "set_status", objectType: "ad", objectName: "Gourde plage", parentName: "IA - Broad", field: "status", before: "PAUSED", after: "ACTIVE", status: "done", error: null }],
    });
    expect(text).toContain("mise en ligne de la publicité « Gourde plage » : en pause → active — ✅ appliqué");
  });

  it("nomme le format d'une nouvelle publicité : image, vidéo, carrousel (n cartes)", () => {
    const base = { v: 2, platform: "meta", name: "Gourde", linkUrl: "https://naturalia.fr/g", texts: { primary: ["Texte"], headline: [], description: [] }, identity: { pageId: "123456789" } };
    const image = JSON.stringify({ ...base, format: "image", media: [{ kind: "image", url: "https://cdn.example.org/a.jpg" }] });
    const video = JSON.stringify({ ...base, format: "video", media: [{ kind: "video", url: "https://cdn.example.org/a.mp4", thumbUrl: "https://cdn.example.org/a.jpg" }] });
    const carousel = JSON.stringify({ ...base, format: "carousel", media: [], cards: [1, 2].map((n) => ({ media: { kind: "image", url: `https://cdn.example.org/${n}.jpg` }, link: "https://naturalia.fr/p" })) });
    expect(newAdLabel(image)).toBe("nouvelle publicité image");
    expect(newAdLabel(video)).toBe("nouvelle publicité vidéo");
    expect(newAdLabel(carousel)).toBe("nouvelle publicité carrousel (2 cartes)");
    expect(describeOperation({ kind: "create_ad", objectType: "adset", objectName: "IA - Broad", field: "new_ad", before: null, after: video }, "EUR")).toBe("🆕 Ensemble de publicités « IA - Broad » — nouvelle publicité vidéo « Gourde » (créée en pause)");
    // The first shape (Mo) is an image.
    expect(newAdLabel(JSON.stringify({ name: "G", primaryText: "T", linkUrl: "https://naturalia.fr/g", imageUrl: "https://cdn.example.org/a.jpg", pageId: "123456789" }))).toBe("nouvelle publicité image");
  });

  it("une annonce dynamique (asset_feed_spec) est reconnue pour le badge, et ses textes restent dans le Gestionnaire", () => {
    expect(adFormat({ id: "1", object_story_spec: { page_id: "9" }, asset_feed_spec: { images: [{ hash: "a" }, { hash: "b" }], bodies: [{ text: "x" }], titles: [] } })).toBe("dynamic");
    expect(adFormat({ id: "1", object_story_spec: { page_id: "9", link_data: { link: "https://x.fr", message: "m" } }, asset_feed_spec: { ad_formats: ["SINGLE_IMAGE"] } })).toBe("image");
    expect(adFormat({ id: "1", object_story_spec: { page_id: "9", video_data: { video_id: "77" } } })).toBe("video");
    expect(adFormat({ id: "1", object_story_spec: { page_id: "9" } })).toBeNull();
    expect(adFormat(undefined)).toBeNull();
    const r = prepareOperation({ kind: "set_ad_texts", objectType: "ad", objectId: "1200003", value: JSON.stringify({ primaryText: "x", linkUrl: "https://x.fr" }) }, ad({ format: "dynamic", creativeId: "5", adTexts: null }), "EUR", NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining(DYNAMIC_TEXTS_LOCKED) });
  });
});
