import { describe, expect, it } from "vitest";
import { describeOperation, inverseRequest, prepareOperation, readKeyword, readRequest, type PilotObjectState } from "@/lib/pilot/ops";
import { googleKeywordCreation, googleMutation } from "@/lib/pilot/google";

const NOW = new Date("2026-10-07T10:00:00Z");
const keyword = (over: Partial<PilotObjectState> = {}): PilotObjectState => ({
  id: "555~999", type: "keyword", accountId: "6823803493", name: "« chaussures running » [expression]", status: "ACTIVE", effectiveStatus: "ACTIVE",
  dailyBudget: null, lifetimeBudget: null, endTime: null, bidAmount: 120, strategyLock: null, negative: false, parentName: "Groupe A", ...over,
});
const adGroup = (): PilotObjectState => ({ id: "555", type: "adset", accountId: "6823803493", name: "Groupe A", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: null, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "Search" });

describe("pilotage — mots-clés Google Ads", () => {
  it("lit un mot-clé à ajouter : texte nettoyé, type de correspondance, caractères interdits", () => {
    expect(readKeyword({ text: "  Chaussures   Running ", matchType: "phrase" })).toEqual({ ok: true, spec: { text: "chaussures running", matchType: "PHRASE" } });
    expect(readKeyword({ text: "x", matchType: "EXACT" }).ok).toBe(false);
    expect(readKeyword({ text: "prix!", matchType: "EXACT" }).ok).toBe(false);
    expect(readKeyword({ text: "ok", matchType: "LOOSE" }).ok).toBe(false);
  });

  it("un mot-clé est nommé par son groupe et son critère ; une demande sur un autre identifiant est illisible", () => {
    expect(readRequest({ kind: "set_status", objectType: "keyword", objectId: "555~999", value: "PAUSED" })).toMatchObject({ objectType: "keyword", objectId: "555~999" });
    expect(readRequest({ kind: "set_status", objectType: "keyword", objectId: "555", value: "PAUSED" })).toBeNull();
    expect(readRequest({ kind: "set_status", objectType: "campaign", objectId: "555~999", value: "PAUSED" })).toBeNull();
  });

  it("pause, enchère et suppression d'un mot-clé ; un négatif se supprime seulement ; rien sur Meta", () => {
    expect(prepareOperation({ kind: "set_status", objectType: "keyword", objectId: "555~999", value: "PAUSED" }, keyword(), "EUR", NOW, "google")).toMatchObject({ ok: true, op: { field: "status", before: "ACTIVE", after: "PAUSED", double: null } });
    expect(prepareOperation({ kind: "set_bid_amount", objectType: "keyword", objectId: "555~999", value: "1,5" }, keyword(), "EUR", NOW, "google")).toMatchObject({ ok: true, op: { field: "bid_amount", before: 120, after: 150 } });
    expect(prepareOperation({ kind: "set_bid_amount", objectType: "keyword", objectId: "555~999", value: 2 }, keyword({ bidAmount: null, strategyLock: "CPC manuel seulement." }), "EUR", NOW, "google").ok).toBe(false);
    expect(prepareOperation({ kind: "rename", objectType: "keyword", objectId: "555~999", value: "x" }, keyword(), "EUR", NOW, "google").ok).toBe(false);
    const neg = keyword({ id: "1~999", negative: true, parentName: "Search" });
    expect(prepareOperation({ kind: "set_status", objectType: "keyword", objectId: "1~999", value: "PAUSED" }, neg, "EUR", NOW, "google").ok).toBe(false);
    expect(prepareOperation({ kind: "set_status", objectType: "keyword", objectId: "1~999", value: "DELETED" }, neg, "EUR", NOW, "google")).toMatchObject({ ok: true, op: { field: "status", after: "DELETED", double: "suppression", irreversible: true } });
    expect(prepareOperation({ kind: "set_status", objectType: "keyword", objectId: "555~999", value: "PAUSED" }, keyword(), "EUR", NOW, "meta").ok).toBe(false);
  });

  it("ajout d'un mot-clé sur un groupe, d'un négatif sur une campagne ; jamais remis en place", () => {
    const add = prepareOperation({ kind: "add_keyword", objectType: "adset", objectId: "555", value: '{"text":"chaussures running","matchType":"PHRASE"}' }, adGroup(), "EUR", NOW, "google");
    expect(add).toMatchObject({ ok: true, op: { field: "new_keyword", before: null, after: '{"text":"chaussures running","matchType":"PHRASE"}' } });
    expect(prepareOperation({ kind: "add_negative_keyword", objectType: "adset", objectId: "555", value: '{"text":"gratuit","matchType":"BROAD"}' }, adGroup(), "EUR", NOW, "google").ok).toBe(false);
    expect(prepareOperation({ kind: "add_keyword", objectType: "adset", objectId: "555", value: '{"text":"x","matchType":"PHRASE"}' }, adGroup(), "EUR", NOW, "meta").ok).toBe(false);
    expect(describeOperation({ kind: "add_keyword", objectType: "adset", objectName: "Groupe A", field: "new_keyword", before: null, after: '{"text":"chaussures running","matchType":"PHRASE"}' }, "EUR", "google")).toBe("🔑 Groupe d'annonces « Groupe A » — mot-clé ajouté « chaussures running » [expression]");
    expect(inverseRequest({ kind: "add_keyword", objectType: "adset", objectId: "555", field: "new_keyword", before: null, after: "{}" }, "EUR")).toBeNull();
  });

  it("les écritures Google : critère de groupe (statut, CPC, suppression), négatif (suppression seulement), créations", () => {
    expect(googleMutation("6823803493", "555~999", "keyword", "status", "PAUSED", "EUR")).toEqual({ resource: "adGroupCriteria", operation: { update: { resourceName: "customers/6823803493/adGroupCriteria/555~999", status: "PAUSED" }, updateMask: "status" } });
    expect(googleMutation("6823803493", "555~999", "keyword", "bid_amount", 150, "EUR")).toEqual({ resource: "adGroupCriteria", operation: { update: { resourceName: "customers/6823803493/adGroupCriteria/555~999", cpcBidMicros: "1500000" }, updateMask: "cpc_bid_micros" } });
    expect(googleMutation("6823803493", "1~999", "keyword", "status", "DELETED", "EUR", null, null, true)).toEqual({ resource: "campaignCriteria", operation: { remove: "customers/6823803493/campaignCriteria/1~999" } });
    expect(googleMutation("6823803493", "1~999", "keyword", "status", "PAUSED", "EUR", null, null, true)).toBeNull();
    expect(googleMutation("6823803493", "555", "keyword", "status", "PAUSED", "EUR")).toBeNull();
    expect(googleKeywordCreation("6823803493", "555", { text: "chaussures running", matchType: "PHRASE" }, false)).toEqual({ resource: "adGroupCriteria", operation: { create: { adGroup: "customers/6823803493/adGroups/555", status: "ENABLED", keyword: { text: "chaussures running", matchType: "PHRASE" } } } });
    expect(googleKeywordCreation("6823803493", "1", { text: "gratuit", matchType: "BROAD" }, true)).toEqual({ resource: "campaignCriteria", operation: { create: { campaign: "customers/6823803493/campaigns/1", negative: true, keyword: { text: "gratuit", matchType: "BROAD" } } } });
  });
});
