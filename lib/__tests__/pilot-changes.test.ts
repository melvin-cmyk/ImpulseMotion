import { describe, it, expect } from "vitest";
import { fromMetaActivity, fromGoogleChangeEvent, groupSessions, describeChange, metaActivityId, SIGNIFICANT_FIELDS } from "@/lib/pilot/changes";

const own = new Set(["impulsemcplimite"]);

describe("journal Meta → modifications", () => {
  const budget = {
    event_type: "update_ad_set_budget", event_time: "2026-10-02T10:46:34+0000", object_type: "CAMPAIGN", object_name: "IA - [Broad 18+ Ex Followers]", object_id: "23857040420440567",
    actor_name: "Conversion api ", actor_id: "122112787779254519", application_name: "impulsemcplimite",
    extra_data: JSON.stringify({ old_value: { type: "payment_amount", currency: "EUR", old_value: 1200, additional_type: "status_string", additional_value: "" }, new_value: { type: "payment_amount", currency: "EUR", new_value: 1000, additional_type: "status_string", additional_value: "Par jour" }, type: "composite_data" }),
  };

  it("un budget d'ensemble (objet CAMPAIGN = ensemble, noms hérités de Meta) en centimes, par jour, venu de notre appli", () => {
    const c = fromMetaActivity("1668772300254268", "EUR", budget, own)!;
    expect(c.objectType).toBe("adset");
    expect(c.field).toBe("daily_budget");
    expect(c.before).toBe(1200);
    expect(c.after).toBe(1000);
    expect(c.source).toBe("impulsemotion");
    expect(c.via).toBe("ImpulseMotion");
    expect(c.significant).toBe(true);
    expect(c.line).toContain("Ensemble de publicités « IA - [Broad 18+ Ex Followers] »");
    expect(c.line.replace(/[\u202f\u00a0]/g, " ")).toContain("12 €/jour → 10 €/jour");
    expect(c.externalId).toBe(metaActivityId("1668772300254268", budget));
  });

  it("un statut d'annonce (ADGROUP = annonce) lu comme un statut Pilotage, hors ImpulseMotion quand l'appli n'est pas la nôtre", () => {
    const c = fromMetaActivity("1", "EUR", {
      event_type: "update_ad_run_status", event_time: "2026-10-02T10:46:49+0000", object_type: "ADGROUP", object_name: "NAT - SGL", object_id: "23857162971430567",
      // The id is a bare number in Meta's JSON, beyond what a JS number holds: written as the API sends it.
      actor_name: "Marina Boural", application_name: "Ads Manager", extra_data: '{"old_value":"Actif","new_value":"Inactif","campaign_id":23857040420440567,"type":"run_status"}',
    }, own)!;
    expect(c.objectType).toBe("ad");
    expect(c.field).toBe("status");
    expect(c.before).toBe("ACTIVE");
    expect(c.after).toBe("PAUSED");
    expect(c.source).toBe("external");
    expect(c.campaignId).toBe("23857040420440567");
    expect(c.line).toContain("⏸");
  });

  it("les événements de bruit (validation, phase d'apprentissage, facturation) ne sont pas gardés", () => {
    for (const event_type of ["update_ad_run_status_to_be_set_after_review", "ad_review_approved", "update_ad_set_learning_stage_status", "ad_account_billing_charge"]) {
      expect(fromMetaActivity("1", "EUR", { event_type, event_time: "2026-10-02T10:00:00+0000", object_type: "ADGROUP", object_id: "1" }, own)).toBeNull();
    }
  });

  it("les transitions faites par Meta lui-même (examen, début de diffusion) ne sont pas des modifications ; « en attente de traitement » = activée", () => {
    const base = { event_time: "2026-10-05T15:52:06+0000", object_type: "ADGROUP", object_id: "1", object_name: "Z", application_name: "Ads Manager" };
    expect(fromMetaActivity("1", "EUR", { ...base, event_type: "update_ad_run_status", actor_name: "Meta", extra_data: JSON.stringify({ old_value: "En attente d’examen", new_value: "Actif" }) }, own)).toBeNull();
    expect(fromMetaActivity("1", "EUR", { ...base, event_type: "first_delivery_event", actor_name: "Meta", extra_data: "{}" }, own)).toBeNull();
    const human = fromMetaActivity("1", "EUR", { ...base, event_type: "update_ad_run_status", actor_name: "Orla", extra_data: JSON.stringify({ old_value: "Inactif", new_value: "En attente de traitement" }) }, own)!;
    expect(human).toMatchObject({ before: "PAUSED", after: "ACTIVE", source: "external", via: "Ads Manager" });
    expect(fromMetaActivity("1", "EUR", { ...base, event_type: "update_ad_run_status", actor_name: "Orla", extra_data: JSON.stringify({ old_value: "Actif", new_value: "En attente de traitement" }) }, own)).toBeNull();
  });

  it("un renommage n'est pas significatif ; une règle automatique est dite automatique ; un ciblage l'est", () => {
    const rename = fromMetaActivity("1", "EUR", { event_type: "update_campaign_name", event_time: "2026-10-02T10:00:00+0000", object_type: "CAMPAIGN_GROUP", object_id: "1", object_name: "X", extra_data: JSON.stringify({ old_value: "A", new_value: "B" }) }, own)!;
    expect(rename.field).toBe("name");
    expect(rename.significant).toBe(false);
    expect(rename.objectType).toBe("campaign");
    const rule = fromMetaActivity("1", "EUR", { event_type: "update_ad_set_run_status", event_time: "2026-10-02T10:00:00+0000", object_type: "CAMPAIGN", object_id: "1", actor_name: "Automated Rules", application_name: "Ads Manager", extra_data: JSON.stringify({ old_value: "Actif", new_value: "Inactif" }) }, own)!;
    expect(rule.source).toBe("automated");
    const targeting = fromMetaActivity("1", "EUR", { event_type: "update_ad_set_target_spec", event_time: "2026-10-02T10:00:00+0000", object_type: "CAMPAIGN", object_id: "1", extra_data: JSON.stringify({ old_value: { age_min: 18 }, new_value: { age_min: 25 } }) }, own)!;
    expect(targeting.field).toBe("targeting");
    expect(SIGNIFICANT_FIELDS.has(targeting.field)).toBe(true);
  });
});

describe("journal Google Ads → modifications", () => {
  const row = {
    campaign: { resourceName: "customers/6823803493/campaigns/21025591832", name: "IA - [PUR - ACQ] - RLSA", id: "21025591832" },
    changeEvent: {
      resourceName: "customers/6823803493/changeEvents/1791194940878143~0~0", changeDateTime: "2026-10-05 12:09:00.878143", changeResourceType: "CAMPAIGN_BUDGET",
      changeResourceName: "customers/6823803493/campaignBudgets/13373894140", clientType: "GOOGLE_ADS_API", userEmail: "melvin@impulse-analytics.com",
      oldResource: { campaignBudget: { amountMicros: "9000000" } }, newResource: { campaignBudget: { amountMicros: "8000000" } }, resourceChangeOperation: "UPDATE", changedFields: "amountMicros",
    },
  };

  it("un budget de campagne en centimes, rattaché à la campagne, venu de notre accès API", () => {
    const [c] = fromGoogleChangeEvent("6823803493", "EUR", row, new Set(["melvin@impulse-analytics.com"]));
    expect(c.objectType).toBe("campaign");
    expect(c.objectId).toBe("21025591832");
    expect(c.objectName).toBe("IA - [PUR - ACQ] - RLSA");
    expect(c.field).toBe("daily_budget");
    expect(c.before).toBe(900);
    expect(c.after).toBe(800);
    expect(c.source).toBe("impulsemotion");
    expect(c.externalId).toBe("google:customers/6823803493/changeEvents/1791194940878143~0~0#amountMicros");
    expect(c.at.toISOString()).toBe("2026-10-05T10:09:00.878Z");
  });

  it("un renommage depuis l'interface, par un autre utilisateur, est hors ImpulseMotion ; plusieurs champs = plusieurs lignes", () => {
    const list = fromGoogleChangeEvent("6823803493", "EUR", {
      campaign: row.campaign,
      changeEvent: { ...row.changeEvent, changeResourceType: "CAMPAIGN", changeResourceName: row.campaign.resourceName, clientType: "GOOGLE_ADS_WEB_CLIENT", userEmail: "client@exemple.fr",
        oldResource: { campaign: { name: "A", status: "ENABLED" } }, newResource: { campaign: { name: "B", status: "PAUSED" } }, changedFields: "name,status" },
    });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ field: "name", before: "A", after: "B", source: "external", via: "Google Ads (interface)", significant: false });
    expect(list[1]).toMatchObject({ field: "status", before: "ACTIVE", after: "PAUSED", significant: true });
  });

  it("un mot-clé ajouté est une création sur le groupe d'annonces ; une règle automatique est automatique", () => {
    const [c] = fromGoogleChangeEvent("6823803493", "EUR", {
      adGroup: { id: "555", name: "Groupe A" }, campaign: row.campaign,
      changeEvent: { ...row.changeEvent, changeResourceType: "AD_GROUP_CRITERION", changeResourceName: "customers/6823803493/adGroupCriteria/555~999", resourceChangeOperation: "CREATE", changedFields: "", clientType: "GOOGLE_ADS_AUTOMATED_RULE", userEmail: "" },
    });
    expect(c).toMatchObject({ objectType: "adset", objectId: "555", objectName: "Groupe A", field: "created", source: "automated", via: "règle automatique" });
  });
});

describe("sessions et libellés", () => {
  const ch = (id: string, at: string, actor = "A", source = "external", pilotActionId: string | null = null) => ({ id, at, actorName: actor, source, platform: "meta", accountId: "1", pilotActionId });

  it("regroupe les changements d'une même personne à moins de 30 minutes, les plus récents d'abord", () => {
    const s = groupSessions([ch("1", "2026-10-02T10:00:00Z"), ch("2", "2026-10-02T10:20:00Z"), ch("3", "2026-10-02T11:30:00Z"), ch("4", "2026-10-02T11:31:00Z", "B")]);
    expect(s.map((g) => g.map((c) => c.id))).toEqual([["4"], ["3"], ["2", "1"]]);
  });

  it("décrit un changement sans valeurs par son seul réglage", () => {
    expect(describeChange({ platform: "meta", objectType: "adset", objectName: "X", field: "targeting", before: null, after: null, currency: "EUR", eventType: "update_ad_set_target_spec" })).toBe("🎯 Ensemble de publicités « X » — ciblage");
    expect(describeChange({ platform: "google", objectType: "adset", objectName: "G", field: "created", before: null, after: null, currency: "EUR", eventType: "x" })).toBe("🆕 Groupe d'annonces « G » — créé(e)");
  });
});
