import { describe, expect, it } from "vitest";
import { metaStoryWithTexts, metaTextsDiff, readMetaAdTexts, readMetaCreative, readRsa, readRsaFromAd, rsaCreateAd, rsaDiff, type MetaAdCreative } from "@/lib/pilot/creative";
import { describeOperation, inverseRequest, prepareOperation, type PilotObjectState } from "@/lib/pilot/ops";
import { googleMutation, googleRsaCreation } from "@/lib/pilot/google";

const NOW = new Date("2026-10-07T10:00:00Z");

describe("créas Meta — lecture, nouvelle créa, différence", () => {
  const creative = { id: "900000001", name: "Créa été", object_story_spec: { page_id: "259", instagram_user_id: "178", link_data: { link: "https://naturalia.fr/bio", message: "Le bio pour tous", name: "Naturalia", description: "Livraison offerte", image_hash: "abc123", call_to_action: { type: "SHOP_NOW", value: { link: "https://naturalia.fr/bio" } } } } };

  it("lit une annonce image avec lien ; refuse une publication existante, un carrousel", () => {
    const c = readMetaCreative(creative)!;
    expect(c).toMatchObject({ kind: "link", creativeId: "900000001", pageId: "259", instagramUserId: "178", primaryText: "Le bio pour tous", headline: "Naturalia", description: "Livraison offerte", linkUrl: "https://naturalia.fr/bio", callToAction: "SHOP_NOW", imageHash: "abc123" });
    expect(readMetaCreative({ id: "1", object_story_spec: { page_id: "259" } })).toBeNull();
    expect(readMetaCreative({ id: "1", object_story_spec: { page_id: "259", template_data: { link: "x" } } as never })).toBeNull();
    const video = readMetaCreative({ id: "2", object_story_spec: { page_id: "259", video_data: { video_id: "v1", image_url: "https://x.fr/i.jpg", message: "Regardez", title: "T", call_to_action: { type: "LEARN_MORE", value: { link: "https://x.fr" } } } } })!;
    expect(video).toMatchObject({ kind: "video", videoId: "v1", videoImageUrl: "https://x.fr/i.jpg", linkUrl: "https://x.fr", headline: "T" });
  });

  it("la nouvelle créa garde la Page, l'image et change les textes ; la différence est dite", () => {
    const current = readMetaCreative(creative) as MetaAdCreative;
    const texts = { kind: "link" as const, primaryText: "Le bio pour tous, -20 %", headline: "Naturalia", description: "", linkUrl: "https://naturalia.fr/promo", callToAction: "NO_BUTTON" };
    expect(metaStoryWithTexts(current, texts)).toEqual({ page_id: "259", instagram_user_id: "178", link_data: { link: "https://naturalia.fr/promo", message: "Le bio pour tous, -20 %", call_to_action: { type: "NO_BUTTON" }, name: "Naturalia", image_hash: "abc123" } });
    expect(metaTextsDiff(current, texts)).toEqual(["texte principal « Le bio pour tous » → « Le bio pour tous, -20 % »", "description « Livraison offerte » → «  »", "lien https://naturalia.fr/bio → https://naturalia.fr/promo", "bouton SHOP_NOW → NO_BUTTON"]);
    expect(readMetaAdTexts({ ...texts, linkUrl: "http://x.fr" }).ok).toBe(false);
    expect(readMetaAdTexts({ ...texts, primaryText: " " }).ok).toBe(false);
    expect(readMetaAdTexts({ ...texts, callToAction: "FLY" }).ok).toBe(false);
  });

  it("opération set_ad_texts : avant = créa montrée + textes, après = textes ; annulation = remettre la créa", () => {
    const current = readMetaCreative(creative) as MetaAdCreative;
    const adTexts = JSON.stringify({ kind: current.kind, primaryText: current.primaryText, headline: current.headline, description: current.description, linkUrl: current.linkUrl, callToAction: current.callToAction });
    const ad: PilotObjectState = { id: "1200003", type: "ad", accountId: "555", name: "UGC Julie v3", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: null, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "Retargeting 30j", creativeId: "900000001", adTexts };
    const op = prepareOperation({ kind: "set_ad_texts", objectType: "ad", objectId: "1200003", value: JSON.stringify({ primaryText: "Nouveau texte", headline: "Naturalia", description: "Livraison offerte", linkUrl: "https://naturalia.fr/bio", callToAction: "SHOP_NOW" }) }, ad, "EUR", NOW, "meta");
    expect(op).toMatchObject({ ok: true, op: { field: "ad_texts", double: null } });
    if (op.ok) {
      expect(JSON.parse(String(op.op.before))).toMatchObject({ creativeId: "900000001", primaryText: "Le bio pour tous" });
      expect(describeOperation(op.op, "EUR")).toBe("✍️ Annonce « UGC Julie v3 » (Retargeting 30j) — nouveaux textes (nouvelle créa) : texte principal « Le bio pour tous » → « Nouveau texte »");
      expect(inverseRequest({ ...op.op, before: op.op.before, after: op.op.after }, "EUR")).toEqual({ kind: "set_ad_creative", objectType: "ad", objectId: "1200003", value: "900000001" });
    }
    expect(prepareOperation({ kind: "set_ad_texts", objectType: "ad", objectId: "1200003", value: adTexts }, ad, "EUR", NOW, "meta").ok).toBe(false);
    expect(prepareOperation({ kind: "set_ad_texts", objectType: "ad", objectId: "1200003", value: adTexts }, { ...ad, adTexts: null }, "EUR", NOW, "meta").ok).toBe(false);
    expect(prepareOperation({ kind: "set_ad_creative", objectType: "ad", objectId: "1200003", value: "900000002" }, ad, "EUR", NOW, "meta")).toMatchObject({ ok: true, op: { field: "creative", before: "900000001", after: "900000002" } });
  });
});

describe("annonces responsives Google — lecture, nouvelle version, écritures", () => {
  const gaqlAd = { type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://tse.fr/agri"], responsiveSearchAd: { headlines: [{ text: "Ombrière Photovoltaïque", pinnedField: "HEADLINE_1" }, { text: "Protégez votre bétail" }, { text: "TSE" }], descriptions: [{ text: "Protégez votre bétail des fortes chaleurs." }, { text: "Devis gratuit." }], path1: "agri" } };

  it("lit une RSA, vérifie une nouvelle version, dit la différence", () => {
    const spec = readRsaFromAd(gaqlAd)!;
    expect(spec).toEqual({ headlines: [{ text: "Ombrière Photovoltaïque", pinnedField: "HEADLINE_1" }, { text: "Protégez votre bétail" }, { text: "TSE" }], descriptions: [{ text: "Protégez votre bétail des fortes chaleurs." }, { text: "Devis gratuit." }], finalUrls: ["https://tse.fr/agri"], path1: "agri", path2: "" });
    const next = { ...spec, headlines: [...spec.headlines, { text: "Installez l'AgriPV" }], path2: "pv" };
    expect(readRsa(next).ok).toBe(true);
    expect(rsaDiff(spec, next)).toEqual(["titres + « Installez l'AgriPV »", "chemin /agri/ → /agri/pv"]);
    expect(readRsa({ ...spec, headlines: spec.headlines.slice(0, 2) }).ok).toBe(false);
    expect(readRsa({ ...spec, headlines: [...spec.headlines.slice(0, 2), { text: "x".repeat(31) }] }).ok).toBe(false);
    expect(readRsa({ ...spec, finalUrls: ["http://tse.fr"] }).ok).toBe(false);
    expect(readRsa({ ...spec, path1: "a b" }).ok).toBe(false);
    expect(rsaCreateAd(next)).toEqual({ responsiveSearchAd: { headlines: [{ text: "Ombrière Photovoltaïque", pinnedField: "HEADLINE_1" }, { text: "Protégez votre bétail" }, { text: "TSE" }, { text: "Installez l'AgriPV" }], descriptions: [{ text: "Protégez votre bétail des fortes chaleurs." }, { text: "Devis gratuit." }], path1: "agri", path2: "pv" }, finalUrls: ["https://tse.fr/agri"] });
  });

  it("opération set_rsa_texts sur une annonce Google ; statut d'une annonce Google ; écritures adGroupAds", () => {
    const spec = readRsaFromAd(gaqlAd)!;
    const ad: PilotObjectState = { id: "652897500170", type: "ad", accountId: "6823803493", name: "Ombrière — 3 titres", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: null, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "Ombrière", rsa: JSON.stringify(spec) };
    const op = prepareOperation({ kind: "set_rsa_texts", objectType: "ad", objectId: "652897500170", value: JSON.stringify({ ...spec, descriptions: [...spec.descriptions, { text: "Installation en 3 mois." }] }) }, ad, "EUR", NOW, "google");
    expect(op).toMatchObject({ ok: true, op: { field: "rsa" } });
    if (op.ok) expect(describeOperation(op.op, "EUR", "google")).toContain("nouvelle version de l'annonce (l'ancienne mise en pause) : descriptions + « Installation en 3 mois. »");
    expect(prepareOperation({ kind: "set_rsa_texts", objectType: "ad", objectId: "1", value: "{}" }, { ...ad, rsa: null }, "EUR", NOW, "google").ok).toBe(false);
    expect(prepareOperation({ kind: "set_status", objectType: "ad", objectId: "652897500170", value: "PAUSED" }, ad, "EUR", NOW, "google")).toMatchObject({ ok: true, op: { field: "status", after: "PAUSED" } });
    expect(prepareOperation({ kind: "rename", objectType: "ad", objectId: "652897500170", value: "x" }, ad, "EUR", NOW, "google").ok).toBe(false);
    expect(googleMutation("6823803493", "652897500170", "ad", "status", "PAUSED", "EUR", null, null, false, "customers/6823803493/adGroupAds/148~652")).toEqual({ resource: "adGroupAds", operation: { update: { resourceName: "customers/6823803493/adGroupAds/148~652", status: "PAUSED" }, updateMask: "status" } });
    expect(googleMutation("6823803493", "652897500170", "ad", "status", "DELETED", "EUR", null, null, false, "customers/6823803493/adGroupAds/148~652")).toEqual({ resource: "adGroupAds", operation: { remove: "customers/6823803493/adGroupAds/148~652" } });
    expect(googleMutation("6823803493", "652897500170", "ad", "status", "PAUSED", "EUR")).toBeNull();
    expect(googleRsaCreation("6823803493", "148", spec, "ENABLED")).toEqual({ resource: "adGroupAds", operation: { create: { adGroup: "customers/6823803493/adGroups/148", status: "ENABLED", ad: rsaCreateAd(spec) } } });
    expect(inverseRequest({ kind: "set_rsa_texts", objectType: "ad", objectId: "1", field: "rsa", before: "{}", after: "{}" }, "EUR")).toBeNull();
  });
});
