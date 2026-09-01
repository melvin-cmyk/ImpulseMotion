import { describe, it, expect } from "vitest";
import {
  buildRecommendations,
  buildSnapshot,
  contactSource,
  detectUtmProperties,
  diagnosticLevel,
  extractContactCampaign,
  matchCampaign,
  normalizeCampaign,
  parseUtmCampaignFromUrl,
  pickCurrency,
  rangeBoundsMs,
  stageIndex,
  zonedToEpochMs,
  type BuildSnapshotInput,
} from "@/lib/hubspot/aggregate";
import type { HsObject, HsPipelineRaw, KnownCampaign } from "@/lib/hubspot/types";

const RANGE = { since: "2026-08-01", until: "2026-08-31" };
const D = (ymd: string, hms = "12:00:00") => `${ymd}T${hms}.000Z`;

function contact(id: string, props: Record<string, string | null | undefined>): HsObject {
  return { id, properties: { createdate: D("2026-08-10"), ...props } };
}
function deal(id: string, props: Record<string, string | null | undefined>): HsObject {
  return { id, properties: { createdate: D("2026-08-12"), pipeline: "default", dealstage: "appointmentscheduled", ...props } };
}

const PIPELINES: HsPipelineRaw[] = [
  {
    id: "default",
    label: "Sales Pipeline",
    displayOrder: 0,
    stages: [
      { id: "appointmentscheduled", label: "Rendez-vous", displayOrder: 0, metadata: { isClosed: "false", probability: "0.2" } },
      { id: "qualifiedtobuy", label: "Qualifié", displayOrder: 1, metadata: { isClosed: "false", probability: "0.4" } },
      { id: "closedwon", label: "Gagné", displayOrder: 2, metadata: { isClosed: "true", probability: "1.0" } },
      { id: "closedlost", label: "Perdu", displayOrder: 3, metadata: { isClosed: "true", probability: "0.0" } },
    ],
  },
];

const KNOWN: KnownCampaign[] = [
  { platform: "meta", name: "Prospection FR – Été 2026", id: "120001" },
  { platform: "meta", name: "Retargeting", id: "120002" },
  { platform: "google", name: "Search Brand", id: "998877" },
];

function base(over: Partial<BuildSnapshotInput> = {}): BuildSnapshotInput {
  return {
    portalId: "42",
    fetchedAt: "2026-09-01T07:00:00.000Z",
    range: RANGE,
    tz: "UTC",
    contacts: [],
    deals: [],
    associations: new Map(),
    pipelines: PIPELINES,
    utmCampaignProperty: "utm_campaign",
    knownCampaigns: KNOWN,
    ...over,
  };
}

describe("normalizeCampaign", () => {
  it("is case/accent/space/punctuation insensitive and URL-decodes", () => {
    expect(normalizeCampaign("Prospection FR – Été 2026")).toBe("prospectionfrete2026");
    expect(normalizeCampaign("prospection_fr-ete_2026")).toBe("prospectionfrete2026");
    expect(normalizeCampaign("Prospection+FR+%E2%80%93+%C3%89t%C3%A9+2026")).toBe("prospectionfrete2026");
    expect(normalizeCampaign("")).toBe("");
    expect(normalizeCampaign(null)).toBe("");
    expect(normalizeCampaign("100%")).toBe("100");
  });
});

describe("matchCampaign", () => {
  it("matches exactly, ignoring case/accents/spaces", () => {
    expect(matchCampaign("prospection fr ete 2026", KNOWN)).toEqual({ platform: "meta", campaignName: "Prospection FR – Été 2026" });
  });
  it("matches a numeric platform campaign id", () => {
    expect(matchCampaign("998877", KNOWN)).toEqual({ platform: "google", campaignName: "Search Brand" });
    expect(matchCampaign("12", KNOWN)).toBeNull();
  });
  it("matches by inclusion in both directions, longest known name wins", () => {
    expect(matchCampaign("Retargeting_video_v2", KNOWN)).toEqual({ platform: "meta", campaignName: "Retargeting" });
    expect(matchCampaign("brand", KNOWN)).toEqual({ platform: "google", campaignName: "Search Brand" });
    const known = [...KNOWN, { platform: "meta" as const, name: "Retargeting video", id: "1" }];
    expect(matchCampaign("retargeting_video_v2", known)).toEqual({ platform: "meta", campaignName: "Retargeting video" });
  });
  it("does not fuzzy-match and ignores short values", () => {
    expect(matchCampaign("Prospecting", KNOWN)).toBeNull();
    expect(matchCampaign("FR", KNOWN)).toBeNull();
    expect(matchCampaign("anything", [])).toBeNull();
    expect(matchCampaign(null, KNOWN)).toBeNull();
  });
});

describe("parseUtmCampaignFromUrl", () => {
  it("reads utm_campaign from query, encoded values and hash routers", () => {
    expect(parseUtmCampaignFromUrl("https://x.fr/lp?utm_source=facebook&utm_campaign=Prospection%20FR")).toBe("Prospection FR");
    expect(parseUtmCampaignFromUrl("x.fr/?utm_campaign=a+b")).toBe("a b");
    expect(parseUtmCampaignFromUrl("https://x.fr/#/lp?utm_campaign=hashed")).toBe("hashed");
    expect(parseUtmCampaignFromUrl("https://x.fr/lp?utm_source=facebook")).toBeNull();
    expect(parseUtmCampaignFromUrl("")).toBeNull();
    expect(parseUtmCampaignFromUrl("not a url utm_campaign=raw")).toBe("raw");
  });
});

describe("detectUtmProperties", () => {
  const props = [
    { name: "email", label: "Email" },
    { name: "hs_utm_source", label: "UTM source" },
    { name: "campagne_utm", label: "Campagne UTM (custom)" },
    { name: "utm_campaign_last", label: "Last UTM campaign" },
    { name: "utm_medium", label: "Medium" },
  ];
  it("prefers exact utm_* / hs_utm_* names, then name/label containment (case-insensitive)", () => {
    const u = detectUtmProperties(props);
    expect(u.source).toBe("hs_utm_source");
    expect(u.medium).toBe("utm_medium");
    expect(u.campaign).toBe("utm_campaign_last");
    expect(u.content).toBeNull();
  });
  it("uses the configured override when it exists, ignores it otherwise", () => {
    expect(detectUtmProperties(props, "campagne_utm").campaign).toBe("campagne_utm");
    expect(detectUtmProperties(props, "CAMPAGNE_UTM").campaign).toBe("campagne_utm");
    expect(detectUtmProperties(props, "does_not_exist").campaign).toBe("utm_campaign_last");
    expect(detectUtmProperties([{ name: "utm_campaign" }, { name: "UTM_Campaign_2" }]).campaign).toBe("utm_campaign");
  });
});

describe("contactSource / extractContactCampaign", () => {
  it("maps HubSpot sources and falls back to hs_latest_source", () => {
    expect(contactSource(contact("1", { hs_analytics_source: "PAID_SOCIAL" }))).toBe("PAID_SOCIAL");
    expect(contactSource(contact("1", { hs_analytics_source: "paid_search" }))).toBe("PAID_SEARCH");
    expect(contactSource(contact("1", { hs_analytics_source: null, hs_latest_source: "EMAIL_MARKETING" }))).toBe("EMAIL_MARKETING");
    expect(contactSource(contact("1", { hs_analytics_source: "WEIRD" }))).toBe("UNKNOWN");
  });
  it("applies the priority utm property > first url > source_data_2 (paid only)", () => {
    const c = contact("1", {
      hs_analytics_source: "PAID_SOCIAL",
      utm_campaign: "From Prop",
      hs_analytics_first_url: "https://x.fr/?utm_campaign=FromUrl",
      hs_analytics_source_data_2: "FromData",
    });
    expect(extractContactCampaign(c, "utm_campaign")).toEqual({ campaign: "From Prop", origin: "utm_property" });
    expect(extractContactCampaign(c, null)).toEqual({ campaign: "FromUrl", origin: "first_url" });
    const noUrl = contact("2", { hs_analytics_source: "PAID_SEARCH", hs_analytics_source_data_2: "FromData" });
    expect(extractContactCampaign(noUrl, null)).toEqual({ campaign: "FromData", origin: "source_data" });
    const organic = contact("3", { hs_analytics_source: "ORGANIC_SEARCH", hs_analytics_source_data_2: "google" });
    expect(extractContactCampaign(organic, null)).toEqual({ campaign: null, origin: null });
    const blankProp = contact("4", { hs_analytics_source: "PAID_SOCIAL", utm_campaign: "  ", hs_analytics_source_data_2: "D2" });
    expect(extractContactCampaign(blankProp, "utm_campaign")).toEqual({ campaign: "D2", origin: "source_data" });
  });
});

describe("time bounds", () => {
  it("computes day boundaries in the given timezone, UTC by default", () => {
    expect(zonedToEpochMs("2026-08-01", null, false)).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
    expect(zonedToEpochMs("2026-08-31", "UTC", true)).toBe(Date.parse("2026-08-31T23:59:59.999Z"));
    // Paris is UTC+2 in August
    expect(zonedToEpochMs("2026-08-01", "Europe/Paris", false)).toBe(Date.parse("2026-07-31T22:00:00.000Z"));
    expect(zonedToEpochMs("2026-08-31", "Europe/Paris", true)).toBe(Date.parse("2026-08-31T21:59:59.999Z"));
    // and UTC+1 in January
    expect(zonedToEpochMs("2026-01-15", "Europe/Paris", false)).toBe(Date.parse("2026-01-14T23:00:00.000Z"));
    expect(zonedToEpochMs("2026-08-01", "Not/AZone", false)).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
  });
  it("rejects invalid ranges", () => {
    expect(() => rangeBoundsMs("2026-08-31", "2026-08-01")).toThrow(/Invalid range/);
    expect(() => zonedToEpochMs("2026-8-1", null, false)).toThrow(/Invalid date/);
  });
});

describe("stageIndex / pickCurrency", () => {
  it("derives won/closed from probability, isClosed and config.wonStageIds", () => {
    const idx = stageIndex(PIPELINES, { wonStageIds: ["qualifiedtobuy"] });
    expect(idx.get("closedwon")).toEqual({ pipelineId: "default", isWon: true, isClosed: true });
    expect(idx.get("closedlost")).toEqual({ pipelineId: "default", isWon: false, isClosed: true });
    expect(idx.get("appointmentscheduled")).toEqual({ pipelineId: "default", isWon: false, isClosed: false });
    expect(idx.get("qualifiedtobuy")?.isWon).toBe(true);
  });
  it("takes the majority deal currency, then config, then null — never a guess", () => {
    const deals = [deal("1", { deal_currency_code: "EUR" }), deal("2", { deal_currency_code: "usd" }), deal("3", { deal_currency_code: "EUR" })];
    expect(pickCurrency(deals)).toBe("EUR");
    expect(pickCurrency([deal("1", {})], { currency: "chf" })).toBe("CHF");
    expect(pickCurrency([], {})).toBeNull();
    expect(pickCurrency([deal("1", { deal_currency_code: "USD" })], { currency: "EUR" })).toBe("USD");
  });
});

describe("buildSnapshot", () => {
  it("returns an empty level-0 snapshot with a French recommendation when there are no contacts", () => {
    const s = buildSnapshot(base());
    expect(s.totals).toEqual({ contacts: 0, qualified: 0, dealsCreated: 0, dealsWon: 0, wonAmount: 0, openAmount: 0 });
    expect(s.bySource).toEqual({});
    expect(s.byCampaign).toEqual([]);
    expect(s.diagnostic.level).toBe(0);
    expect(s.diagnostic.recommendations[0]).toMatch(/Aucun contact créé/);
    expect(s.currency).toBeNull();
    expect(s.partial).toBe(false);
    expect(s.pipelines[0].stages.map((st) => st.isWon)).toEqual([false, false, true, false]);
  });

  it("counts contacts by source, qualifies by lifecycle stage and ignores contacts outside the range", () => {
    const s = buildSnapshot(
      base({
        contacts: [
          contact("1", { hs_analytics_source: "PAID_SOCIAL", lifecyclestage: "marketingqualifiedlead" }),
          contact("2", { hs_analytics_source: "PAID_SOCIAL", lifecyclestage: "lead" }),
          contact("3", { hs_analytics_source: "ORGANIC_SEARCH", lifecyclestage: "customer" }),
          contact("4", { hs_analytics_source: null, lifecyclestage: "subscriber" }),
          contact("5", { hs_analytics_source: "PAID_SEARCH", createdate: D("2026-07-31", "23:59:59") }),
          contact("1", { hs_analytics_source: "PAID_SOCIAL" }), // duplicate id ignored
        ],
      }),
    );
    expect(s.totals.contacts).toBe(4);
    expect(s.totals.qualified).toBe(2);
    expect(s.bySource.PAID_SOCIAL).toMatchObject({ contacts: 2, qualified: 1 });
    expect(s.bySource.ORGANIC_SEARCH).toMatchObject({ contacts: 1, qualified: 1 });
    expect(s.bySource.UNKNOWN).toMatchObject({ contacts: 1, qualified: 0 });
    expect(s.bySource.PAID_SEARCH).toBeUndefined();
    expect(s.diagnostic).toMatchObject({ contactsTotal: 4, withSource: 3, paidSource: 2, level: 1 });
  });

  it("distinguishes deals created vs won in the period, open amount, and attributes deals to the first associated contact", () => {
    const contacts = [
      contact("c1", { hs_analytics_source: "PAID_SOCIAL", utm_campaign: "Retargeting" }),
      contact("c2", { hs_analytics_source: "ORGANIC_SEARCH" }),
    ];
    const deals = [
      deal("d1", { amount: "1000", hs_is_closed: "false" }), // created, open, c1
      deal("d2", { amount: "500", dealstage: "closedwon", hs_is_closed_won: "true", hs_is_closed: "true", closedate: D("2026-08-20") }), // created + won, c1
      deal("d3", { amount: "2000", createdate: D("2026-06-01"), dealstage: "closedwon", hs_is_closed_won: "true", hs_is_closed: "true", closedate: D("2026-08-25") }), // won only, c0 (before range)
      deal("d4", { amount: "300", dealstage: "closedlost", hs_is_closed: "true" }), // created, lost, no contact
      deal("d5", { amount: "700", createdate: D("2026-06-01"), dealstage: "closedwon", hs_is_closed_won: "true", closedate: D("2026-09-02") }), // won outside
    ];
    const associations = new Map<string, string[]>([
      ["d1", ["c1", "c2"]],
      ["d2", ["c1"]],
      ["d3", ["c0", "c2"]],
    ]);
    const relatedContacts = [contact("c0", { createdate: D("2026-05-05"), hs_analytics_source: "PAID_SEARCH", utm_campaign: "search brand" })];
    const s = buildSnapshot(base({ contacts, deals, associations, relatedContacts }));
    expect(s.totals).toEqual({ contacts: 2, qualified: 0, dealsCreated: 3, dealsWon: 2, wonAmount: 2500, openAmount: 1000 });
    expect(s.bySource.PAID_SOCIAL).toEqual({ contacts: 1, qualified: 0, dealsCreated: 2, dealsWon: 1, wonAmount: 500, openAmount: 1000 });
    expect(s.bySource.PAID_SEARCH).toEqual({ contacts: 0, qualified: 0, dealsCreated: 0, dealsWon: 1, wonAmount: 2000, openAmount: 0 });
    expect(s.bySource.UNKNOWN).toEqual({ contacts: 0, qualified: 0, dealsCreated: 1, dealsWon: 0, wonAmount: 0, openAmount: 0 });
    expect(s.bySource.ORGANIC_SEARCH).toMatchObject({ contacts: 1, dealsCreated: 0 });
    expect(s.warnings).toContainEqual(expect.stringMatching(/1 deal\(s\) sans contact associé/));
    // byCampaign only lists contacts/deals that carry a campaign; related contact's campaign still gets the won deal
    expect(s.byCampaign.map((r) => [r.campaign, r.contacts, r.dealsWon, r.wonAmount, r.matched?.campaignName])).toEqual([
      ["Retargeting", 1, 1, 500, "Retargeting"],
      ["search brand", 0, 1, 2000, "Search Brand"],
    ]);
    // pipeline stage counts cover every deal in the snapshot (created ∪ won in range); d5 is outside
    const stages = Object.fromEntries(s.pipelines[0].stages.map((st) => [st.id, [st.count, st.amount]]));
    expect(stages.appointmentscheduled).toEqual([1, 1000]);
    expect(stages.closedwon).toEqual([2, 2500]);
    expect(stages.closedlost).toEqual([1, 300]);
  });

  it("uses config.qualifiedStageIds as the qualification rule when set", () => {
    const contacts = [
      contact("c1", { hs_analytics_source: "PAID_SOCIAL", lifecyclestage: "lead" }),
      contact("c2", { hs_analytics_source: "PAID_SOCIAL", lifecyclestage: "marketingqualifiedlead" }),
    ];
    const deals = [deal("d1", { dealstage: "qualifiedtobuy" })];
    const associations = new Map([["d1", ["c1"]]]);
    const s = buildSnapshot(base({ contacts, deals, associations, config: { qualifiedStageIds: ["qualifiedtobuy"] } }));
    expect(s.totals.qualified).toBe(1);
    expect(s.bySource.PAID_SOCIAL?.qualified).toBe(1);
    const noOverride = buildSnapshot(base({ contacts, deals, associations }));
    expect(noOverride.totals.qualified).toBe(1); // c2 by lifecycle
  });

  it("filters deals and pipelines by config.pipelineIds", () => {
    const pipelines: HsPipelineRaw[] = [...PIPELINES, { id: "other", label: "Autre", displayOrder: 1, stages: [{ id: "o1", label: "S", metadata: { probability: "0.5" } }] }];
    const deals = [deal("d1", { amount: "10" }), deal("d2", { amount: "20", pipeline: "other", dealstage: "o1" })];
    const s = buildSnapshot(base({ pipelines, deals, config: { pipelineIds: ["default"] } }));
    expect(s.totals.dealsCreated).toBe(1);
    expect(s.totals.openAmount).toBe(10);
    expect(s.pipelines.map((p) => p.id)).toEqual(["default"]);
    const all = buildSnapshot(base({ pipelines, deals }));
    expect(all.totals.dealsCreated).toBe(2);
    expect(all.pipelines.map((p) => p.id)).toEqual(["default", "other"]);
  });

  it("picks the majority currency from deals, else config, and never invents one", () => {
    const deals = [deal("1", { deal_currency_code: "EUR" }), deal("2", { deal_currency_code: "EUR" }), deal("3", { deal_currency_code: "USD" })];
    expect(buildSnapshot(base({ deals })).currency).toBe("EUR");
    expect(buildSnapshot(base({ deals: [deal("1", {})], config: { currency: "gbp" } })).currency).toBe("GBP");
    expect(buildSnapshot(base({ deals: [deal("1", {})] })).currency).toBeNull();
  });

  it("sorts byCampaign by contacts desc then name, caps at 100 rows with a warning", () => {
    const contacts: HsObject[] = [];
    for (let i = 0; i < 120; i++) {
      const n = i % 110; // campaign 0..9 get 2 contacts, others 1
      contacts.push(contact(`c${i}`, { hs_analytics_source: "PAID_SOCIAL", utm_campaign: `camp-${String(n).padStart(3, "0")}` }));
    }
    const s = buildSnapshot(base({ contacts, knownCampaigns: [] }));
    expect(s.byCampaign).toHaveLength(100);
    expect(s.byCampaign[0]).toMatchObject({ campaign: "camp-000", contacts: 2, source: "PAID_SOCIAL", matched: null });
    expect(s.byCampaign[9].contacts).toBe(2);
    expect(s.byCampaign[10]).toMatchObject({ campaign: "camp-010", contacts: 1 });
    expect(s.warnings).toContainEqual(expect.stringMatching(/110 campagnes distinctes/));
  });

  it("merges campaign spellings into one row and keeps the majority source", () => {
    const contacts = [
      contact("1", { hs_analytics_source: "PAID_SOCIAL", utm_campaign: "Retargeting" }),
      contact("2", { hs_analytics_source: "PAID_SOCIAL", hs_analytics_first_url: "https://x.fr/?utm_campaign=RETARGETING" }),
      contact("3", { hs_analytics_source: "SOCIAL_MEDIA", utm_campaign: "re-targeting" }),
    ];
    const s = buildSnapshot(base({ contacts }));
    expect(s.byCampaign).toHaveLength(1);
    expect(s.byCampaign[0]).toMatchObject({ campaign: "Retargeting", contacts: 3, source: "PAID_SOCIAL", matched: { platform: "meta", campaignName: "Retargeting" } });
  });

  it("reaches level 2 when ≥ 30 % of paid contacts match a known campaign", () => {
    const contacts = [
      contact("1", { hs_analytics_source: "PAID_SOCIAL", utm_campaign: "Retargeting" }),
      contact("2", { hs_analytics_source: "PAID_SOCIAL", utm_campaign: "unknown thing" }),
      contact("3", { hs_analytics_source: "PAID_SEARCH", hs_analytics_source_data_2: "998877" }),
      contact("4", { hs_analytics_source: "PAID_SOCIAL" }),
      contact("5", { hs_analytics_source: "ORGANIC_SEARCH" }),
    ];
    const s = buildSnapshot(base({ contacts }));
    expect(s.diagnostic).toMatchObject({ level: 2, contactsTotal: 5, withSource: 5, paidSource: 4, withUtmCampaign: 2, matchedToCampaign: 2, utmProperty: "utm_campaign" });
    expect(s.diagnostic.recommendations).toContainEqual(expect.stringMatching(/33 % des contacts Paid Social n'ont pas d'utm_campaign : faire poser utm_campaign=\{\{campaign\.name\}\} dans les URL des annonces Meta/));
    expect(s.diagnostic.recommendations).toContainEqual(expect.stringMatching(/100 % des contacts Paid Search n'ont pas d'utm_campaign/));
    expect(s.diagnostic.recommendations).toContainEqual(expect.stringMatching(/« unknown thing »/));
  });

  it("stays at level 1 below the 30 % threshold and asks to link an ad account when no campaign is known", () => {
    const contacts = [
      contact("1", { hs_analytics_source: "PAID_SOCIAL", utm_campaign: "Retargeting" }),
      contact("2", { hs_analytics_source: "PAID_SOCIAL" }),
      contact("3", { hs_analytics_source: "PAID_SOCIAL" }),
      contact("4", { hs_analytics_source: "PAID_SOCIAL" }),
    ];
    expect(buildSnapshot(base({ contacts })).diagnostic.level).toBe(1);
    const noKnown = buildSnapshot(base({ contacts, knownCampaigns: [] }));
    expect(noKnown.diagnostic.level).toBe(1);
    expect(noKnown.diagnostic.recommendations).toContainEqual(expect.stringMatching(/relier un compte publicitaire/));
    const noUtmProp = buildSnapshot(base({ contacts, utmCampaignProperty: null }));
    expect(noUtmProp.diagnostic.utmProperty).toBeNull();
    expect(noUtmProp.diagnostic.recommendations).toContainEqual(expect.stringMatching(/Aucune propriété contact utm_campaign détectée/));
  });

  it("is level 0 when contacts exist but none has a source", () => {
    const s = buildSnapshot(base({ contacts: [contact("1", {}), contact("2", { hs_analytics_source: "" })] }));
    expect(s.diagnostic.level).toBe(0);
    expect(s.diagnostic.recommendations[0]).toMatch(/code de suivi HubSpot/);
    expect(diagnosticLevel({ contactsTotal: 10, withSource: 10, paidSource: 0, matchedToCampaign: 0 })).toBe(1);
    expect(diagnosticLevel({ contactsTotal: 10, withSource: 10, paidSource: 10, matchedToCampaign: 3 })).toBe(2);
    expect(diagnosticLevel({ contactsTotal: 10, withSource: 10, paidSource: 10, matchedToCampaign: 2 })).toBe(1);
  });

  it("passes partial/warnings through and adds a generic warning when partial without details", () => {
    const s = buildSnapshot(base({ partial: true, warnings: ["Deals non lus"] }));
    expect(s.partial).toBe(true);
    expect(s.warnings).toEqual(["Deals non lus"]);
    expect(buildSnapshot(base({ partial: true })).warnings).toEqual(["Données CRM partielles."]);
  });

  it("applies the timezone to the range boundaries", () => {
    const edge = contact("1", { createdate: "2026-07-31T22:30:00.000Z", hs_analytics_source: "PAID_SOCIAL" }); // 00:30 Paris on Aug 1
    expect(buildSnapshot(base({ contacts: [edge], tz: "Europe/Paris" })).totals.contacts).toBe(1);
    expect(buildSnapshot(base({ contacts: [edge], tz: "UTC" })).totals.contacts).toBe(0);
    const epoch = contact("2", { createdate: String(Date.parse("2026-08-15T10:00:00Z")), hs_analytics_source: "PAID_SOCIAL" });
    expect(buildSnapshot(base({ contacts: [epoch] })).totals.contacts).toBe(1);
  });
});

describe("buildRecommendations", () => {
  it("explains a paid-less portal", () => {
    const rec = buildRecommendations(
      { level: 1, contactsTotal: 5, withSource: 5, paidSource: 0, withUtmCampaign: 0, matchedToCampaign: 0, utmProperty: "utm_campaign", recommendations: [] },
      { paidWithoutUtm: new Map(), paidBySource: new Map(), unmatchedCampaigns: [], hasKnownCampaigns: true },
    );
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatch(/source payante/);
  });
});
