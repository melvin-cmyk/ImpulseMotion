import { describe, expect, it } from "vitest";
import { compactText, compactToolResult } from "../../server/mcp-compact.mjs";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

describe("mcp-compact — Meta insights", () => {
  const rows = [1, 2, 3].map((i) => ({
    campaign_name: `Camp ${i}`,
    spend: `${100 * i}.123456`,
    impressions: `${1000 * i}`,
    ctr: "3.731954",
    date_start: "2026-09-15",
    date_stop: "2026-09-21",
    actions: [
      { action_type: "link_click", value: `${10 * i}` },
      { action_type: "landing_page_view", value: "7" },
      { action_type: "omni_landing_page_view", value: "7" },
      { action_type: "post_reaction", value: "80" },
      { action_type: "offsite_conversion.fb_pixel_custom", value: "12" },
    ],
    cost_per_action_type: [
      { action_type: "link_click", value: "0.5" },
      { action_type: "offsite_conversion.fb_pixel_custom", value: "8.333333" },
    ],
  }));
  const text = pretty({ data: rows, paging: { cursors: { before: "A", after: "B" }, next: "https://graph…" } });

  it("aplatit les actions en colonnes, retire le bruit et remonte les constantes", () => {
    const { text: out, stats } = compactText(text, { server: "meta-ads-impulse", tool: "Campaign_Performance1" });
    expect(stats.mode).toBe("table");
    expect(out.length).toBeLessThan(text.length / 3);
    expect(out).toContain("date_start=2026-09-15 ; date_stop=2026-09-21");
    expect(out).toContain("has_more=true");
    expect(out).toContain("actions.link_click");
    expect(out).toContain("actions.offsite_conversion.fb_pixel_custom");
    expect(out).not.toContain("omni_landing_page_view");
    expect(out).not.toContain("post_reaction");
    expect(out).not.toContain("cost_per_action_type.link_click");
    expect(out).toContain("cost_per_action_type.offsite_conversion.fb_pixel_custom");
    expect(out).toContain("100.12");
    expect(out).not.toContain("cursors");
  });

  it("garde les identifiants Meta longs sous forme de texte", () => {
    const { text: out } = compactText(pretty({ data: [{ id: "36806030465676950", name: "x", spend: "1" }] }), { server: "meta-ads-impulse", tool: "Get_Campaigns1" });
    expect(out).toContain("36806030465676950");
  });
});

describe("mcp-compact — Google Ads", () => {
  const results = Array.from({ length: 4 }, (_, i) => ({
    campaign: { resourceName: `customers/6010469196/campaigns/${100 + i}`, name: "IA - [PUR - ACQ] - Brand" },
    adGroup: { resourceName: `customers/6010469196/adGroups/${200 + i}`, name: `AG ${i}` },
    metrics: { clicks: `${40 + i}`, costMicros: "545019246", ctr: 0.117519042437432, averageCpc: 1261618.625, viewThroughConversions: 0 },
    // Deux jeux de titres partagés par deux annonces chacun (dédoublonnage, pas hissage).
    adGroupAd: { ad: { responsiveSearchAd: { headlines: Array.from({ length: 6 }, (_, h) => ({ text: `Headline ${h + (i % 2) * 10}`, assetPerformanceLabel: "PENDING", policySummaryInfo: { reviewStatus: "REVIEWED" } })) } } },
  }));
  const text = pretty([{ results, fieldMask: "campaign.name", requestId: "abc", queryResourceConsumption: "3334" }]);

  it("convertit les micros, retire les resourceName et partage les tableaux répétés", () => {
    const { text: out } = compactText(text, { server: "mcp-google-ads", tool: "Ads_Performance" });
    expect(out).not.toContain("resourceName");
    expect(out).not.toContain("requestId");
    // v2 : préfixe metrics. omis (annoncé) ; les valeurs et leur arrondi sont ceux de la v1.
    expect(out).toContain("préfixes metrics. omis");
    expect(out).not.toContain("metrics.cost");
    expect(out).toContain("cost=545.02");
    expect(out).toContain("averageCpc=1.26");
    expect(out).toContain("ctr=0.1175");
    expect(out).toContain("_shared:");
    expect(out).toContain("Headline 0");
    // v2 : chaque occurrence d'un tableau partagé est remplacée par sa référence, dernière comprise.
    expect(out.match(/Headline 0"/g)).toHaveLength(1);
    expect(out).toContain("AG 2\t42\t#1");
    expect(out).not.toContain("PENDING");
    expect(out).toContain("campaign.name=IA - [PUR - ACQ] - Brand");
  });

  it("remplace un resourceName orphelin par l'id court (Daily_Performance)", () => {
    const daily = pretty([{ results: [777, 778, 779].map((id, i) => ({ campaign: { resourceName: `customers/1/campaigns/${id}` }, segments: { date: `2026-09-2${i}` }, metrics: { clicks: "3" } })) }]);
    const { text: out } = compactText(daily, { server: "mcp-google-ads", tool: "Daily_Performance" });
    expect(out).toContain("campaign.id");
    expect(out).toContain("777");
  });
});

describe("mcp-compact — GA4 runReport", () => {
  it("replie les en-têtes en colonnes", () => {
    const report = pretty({
      dimensionHeaders: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
      metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }, { name: "purchaseRevenue", type: "TYPE_CURRENCY" }],
      rows: [
        { dimensionValues: [{ value: "20260921" }, { value: "Paid Search" }], metricValues: [{ value: "463" }, { value: "1200.5" }] },
        { dimensionValues: [{ value: "20260920" }, { value: "Direct" }], metricValues: [{ value: "12" }, { value: "0" }] },
      ],
      rowCount: 2,
      metadata: { currencyCode: "EUR", timeZone: "Europe/Paris", schemaRestrictionResponse: {} },
      kind: "analyticsData#runReport",
    });
    const { text: out } = compactText(report, { server: "mcp-google-analytics", tool: "run_report" });
    expect(out).toContain("currency=EUR");
    expect(out).toContain("date\t");
    expect(out).toContain("20260921\tPaid Search\t463\t1200.5");
    expect(out).not.toContain("dimensionValues");
    expect(out).not.toContain("analyticsData#runReport");
  });
});

describe("mcp-compact — garde-fous", () => {
  it("plafonne les lignes en gardant les dates les plus récentes, et l'annonce", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, spend: `${i}` }));
    const { text: out, stats } = compactText(pretty({ data: rows }), { server: "meta-ads-impulse", tool: "Daily_Performance1", cap: 5 });
    expect(stats.truncated).toMatchObject({ shown: 5, total: 12 });
    expect(out).toContain("12 lignes, 5 affichées");
    expect(out).toContain("2026-09-12");
    expect(out).not.toContain("2026-09-01\t");
  });

  it("plafonne par dépense décroissante quand il n'y a pas de date", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `n${i}`, spend: `${i * 10}` }));
    const { text: out } = compactText(pretty({ data: rows }), { server: "meta-ads-impulse", tool: "Ad_Performance1", cap: 3 });
    expect(out).toContain("n9");
    expect(out).not.toContain("n0\t");
    expect(out).toContain("top spend");
  });

  it("laisse passer les erreurs et la prose, tronque la prose trop longue", () => {
    expect(compactText("Erreur GAQL : PROHIBITED_METRIC", {}).text).toBe("Erreur GAQL : PROHIBITED_METRIC");
    const long = "x".repeat(20_000);
    expect(compactText(long, {}).text.length).toBeLessThan(12_200);
    const err = { isError: true, content: [{ type: "text", text: pretty({ data: [{ a: 1 }] }) }] };
    expect(compactToolResult(err, { server: "meta-ads-impulse", tool: "X" }).result).toBe(err);
  });

  it("ne renvoie jamais plus lourd que le JSON minifié", () => {
    const tiny = pretty({ data: [{ a: 1 }] });
    const { text: out } = compactText(tiny, {});
    expect(out.length).toBeLessThanOrEqual(JSON.stringify(JSON.parse(tiny)).length);
  });

  it("compactToolResult ne touche que les blocs texte et remonte les tailles", () => {
    const res = { content: [{ type: "text", text: pretty({ data: [{ a: "1" }, { a: "2" }, { a: "3" }] }) }, { type: "image", data: "…" }] };
    const { result, stats } = compactToolResult(res, { server: "meta-ads-impulse", tool: "T" });
    expect(result.content[1]).toEqual({ type: "image", data: "…" });
    expect(stats!.out).toBeLessThan(stats!.raw);
  });
});

// ── v2 : regroupement, doublons, en-têtes, synthèse, recalculables, arrondis ──

/** Série Google jour × campagne synthétique, valeurs déterministes. */
function googleDaily(campaigns: number, days: number, extra: (c: number, d: number) => Record<string, unknown> = () => ({})) {
  const results = [];
  for (let d = 0; d < days; d++) {
    for (let c = 0; c < campaigns; c++) {
      const date = new Date(Date.UTC(2026, 7, 3 + d)).toISOString().slice(0, 10); // le 3 août 2026 est un lundi
      const clicks = 10 + ((c * 7 + d * 3) % 40);
      const impressions = 1000 + c * 137 + d * 11;
      const costMicros = 1_000_000 * (5 + c) + 10_000 * ((d * 37 + c * 11) % 100);
      results.push({
        campaign: { resourceName: `customers/1/campaigns/${500 + c}`, name: `Synth - [PUR - ACQ] - Campagne de test numéro ${c}` },
        metrics: {
          clicks: String(clicks), impressions: String(impressions), costMicros: String(costMicros),
          conversions: (c + d) % 5 === 0 ? 0 : 1.5 + c * 0.25, conversionsValue: ((c + d) % 5 === 0 ? 0 : 80.4 + d),
          ctr: clicks / impressions, averageCpc: costMicros / clicks,
        },
        segments: { date },
        ...extra(c, d),
      });
    }
  }
  return results;
}

/** Série Meta jour × campagne synthétique. */
function metaDaily(campaigns: number, days: number, extra: (c: number, d: number) => Record<string, unknown> = () => ({})) {
  const data = [];
  for (let d = 0; d < days; d++) {
    for (let c = 0; c < campaigns; c++) {
      const day = new Date(Date.UTC(2026, 5, 1 + d)).toISOString().slice(0, 10);
      data.push({
        campaign_name: `Synth Meta - campagne ${c}`, date_start: day, date_stop: day,
        impressions: `${2000 + 10 * d + c}`, clicks: `${20 + c + d}`, spend: (30 + c * 2 + d * 0.25).toFixed(2),
        ...extra(c, d),
      });
    }
  }
  return data;
}

/** Découpe une sortie en lignes de cellules, hors lignes d'annonce et titres. */
const table = (lines: string[]) => lines.filter((l) => !/^[_#]/.test(l)).map((l) => l.split("\t"));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const section = (lines: string[], letter: string) => {
  const from = lines.findIndex((l) => l.startsWith(`## ${letter}.`));
  const to = lines.findIndex((l, i) => i > from && l.startsWith("## "));
  return table(lines.slice(from + 1, to < 0 ? undefined : to));
};
const col = (t: string[][], name: string) => t.slice(1).map((r) => Number(r[t[0].indexOf(name)] || 0));

describe("mcp-compact v2 — regroupement sans perte", () => {
  const results = googleDaily(3, 10);
  const { text: out, stats } = compactText(pretty([{ results }]), { server: "mcp-google-ads", tool: "Daily_Performance" });
  const lines = out.split("\n");

  it("n'écrit chaque nom de campagne qu'une fois, en titre de bloc", () => {
    expect(stats.mode).toBe("table");
    expect(lines[0]).toContain("regroupées par campaign.name");
    for (let c = 0; c < 3; c++) expect(out.split(`Campagne de test numéro ${c}`)).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("# "))).toHaveLength(3);
  });

  it("garde toutes les lignes et toutes les valeurs, ratios compris (tableau court)", () => {
    const [header, ...rows] = table(lines);
    expect(header).toEqual(["date", "clicks", "impressions", "cost", "conversions", "conversionsValue", "ctr", "averageCpc"]);
    expect(rows).toHaveLength(30);
    expect(sum(rows.map((r) => Number(r[1])))).toBe(sum(results.map((r) => Number(r.metrics.clicks))));
    expect(sum(rows.map((r) => Number(r[3])))).toBeCloseTo(sum(results.map((r) => Number(r.metrics.costMicros) / 1e6)), 2);
    // La première ligne du bloc de la campagne 1 est bien celle de la campagne 1.
    const at = lines.findIndex((l) => l.startsWith("# ") && l.includes("numéro 1"));
    const first = results.find((r) => r.campaign.name.endsWith("numéro 1"))!;
    expect(lines[at + 1].split("\t").slice(0, 2)).toEqual([first.segments.date, first.metrics.clicks]);
  });

  it("ne regroupe pas quand la colonne ne se répète pas", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ campaign_name: `Campagne ${i}`, spend: `${i + 1}.5`, impressions: `${100 * i}` }));
    const { text } = compactText(pretty({ data: rows }), { server: "meta-ads-impulse", tool: "Campaign_Performance1" });
    expect(text).not.toContain("regroupées");
    expect(text).toContain("Campagne 3\t4.5\t300");
  });

  it("sous le plafond de l'outil, garde le détail jour × campagne en blocs, sans synthèse", () => {
    const long = googleDaily(5, 30); // 150 lignes, plafond 400
    const r = compactText(pretty([{ results: long }]), { server: "mcp-google-ads", tool: "Daily_Performance" });
    expect(r.stats.mode).toBe("table");
    expect(r.stats.truncated).toBeNull();
    expect(r.text).not.toContain("## A.");
    expect(table(r.text.split("\n"))).toHaveLength(151);
    expect(r.text.split("\n").filter((l) => l.startsWith("# "))).toHaveLength(5);
  });
});

describe("mcp-compact v2 — colonnes identiques et en-têtes", () => {
  const metaRows = (n: number, differ = false) => Array.from({ length: n }, (_, i) => ({
    date_start: `2026-09-${String(i + 1).padStart(2, "0")}`,
    date_stop: `2026-09-${String(i + 1).padStart(2, "0")}`,
    spend: `${50 + i}.10`,
    actions: [
      { action_type: "link_click", value: `${100 + i}` },
      { action_type: "purchase", value: `${3 + i}` },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: `${3 + i + (differ && i === 2 ? 1 : 0)}` },
      { action_type: "add_to_cart", value: `${9 + i}` },
      { action_type: "offsite_conversion.fb_pixel_add_to_cart", value: `${9 + i}` },
      { action_type: "offsite_conversion.fb_pixel_view_content", value: `${40 + i}` },
      { action_type: "offsite_conversion.fb_pixel_custom", value: `${2 + i}` },
      { action_type: "landing_page_view", value: `${60 + i}` },
      { action_type: "initiate_checkout", value: `${5 + i}` },
    ],
    action_values: [
      { action_type: "purchase", value: `${120 + i}.5` },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: `${120 + i}.5` },
      { action_type: "offsite_conversion.fb_pixel_view_content", value: `${900 + i}` },
      { action_type: "offsite_conversion.fb_pixel_custom", value: `${70 + i}` },
      { action_type: "add_to_cart", value: `${300 + i}` },
      { action_type: "initiate_checkout", value: `${200 + i}` },
    ],
  }));

  it("fusionne les doublons pixel Meta et l'annonce en une ligne", () => {
    const { text: out } = compactText(pretty({ data: metaRows(6) }), { server: "meta-ads-impulse", tool: "Daily_Performance1" });
    const lines = out.split("\n");
    const note = lines.filter((l) => l.startsWith("_doublons:"));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain("pixel_purchase=purchase");
    expect(note[0]).toContain("pixel_add_to_cart=add_to_cart");
    expect(note[0]).toContain("date_stop=date_start");
    // Une seule paire pour actions et action_values.
    expect(note[0].split("pixel_purchase=purchase")).toHaveLength(2);
    const header = table(lines)[0];
    expect(header).toEqual(["date_start", "spend", "act.link_click", "act.purchase", "act.add_to_cart", "act.pixel_view_content", "act.pixel_custom",
      "act.landing_page_view", "act.initiate_checkout", "val.purchase", "val.pixel_view_content", "val.pixel_custom", "val.add_to_cart", "val.initiate_checkout"]);
    expect(lines).toContain("_abrév: act.=actions. ; val.=action_values. ; pixel_=offsite_conversion.fb_pixel_");
    expect(out).toContain("2026-09-03\t52.1\t102\t5\t11\t42\t4\t62\t7\t122.5\t902\t72\t302\t202");
  });

  it("garde les noms longs quand la légende coûterait plus qu'elle ne rapporte", () => {
    const rows = [1, 2, 3].map((i) => ({ campaign_name: `C${i}`, spend: `${i}`, actions: [{ action_type: "offsite_conversion.fb_pixel_custom", value: `${i}` }, { action_type: "link_click", value: `${i * 3}` }] }));
    const { text: out } = compactText(pretty({ data: rows }), { server: "meta-ads-impulse", tool: "Campaign_Performance1" });
    expect(out).not.toContain("_abrév");
    expect(out).toContain("actions.offsite_conversion.fb_pixel_custom");
  });

  it("ne fusionne pas deux colonnes qui diffèrent sur une seule ligne", () => {
    const { text: out } = compactText(pretty({ data: metaRows(6, true) }), { server: "meta-ads-impulse", tool: "Daily_Performance1" });
    const note = out.split("\n").find((l) => l.startsWith("_doublons:"))!;
    // Fusion côté valeurs seulement : la colonne act.pixel_purchase, différente, reste affichée.
    // L'annonce porte alors le préfixe de famille, pour ne pas laisser croire que act.pixel_purchase = act.purchase.
    expect(note).toContain("val.pixel_purchase=val.purchase");
    expect(note).not.toContain(" pixel_purchase=purchase");
    expect(table(out.split("\n"))[0]).toContain("act.pixel_purchase");
    expect(table(out.split("\n"))[0]).not.toContain("val.pixel_purchase");
    expect(out).toContain("2026-09-03\t52.1\t102\t5\t6\t");
  });

  // D4 — avant : « purchase=lead », « lead=val.purchase », et « pixel_lead=lead ; pixel_lead=contact ».
  it("D4 : ne fusionne jamais deux colonnes sans lien qui se trouvent égales", () => {
    const wide = (i: number) => ({ impressions: `${1000 + i}`, reach: `${800 + i}`, clicks: `${50 + i}`, cpm: `${4 + i}.5` });
    // Même famille, événements différents, égaux sur toutes les lignes.
    const a = [0, 1, 2, 3].map((i) => ({ campaign_name: `Campagne ${i}`, spend: `${100 + i}`, ...wide(i), actions: [{ action_type: "lead", value: `${4 + i}` }, { action_type: "purchase", value: `${4 + i}` }] }));
    const ra = compactText(pretty({ data: a }), { server: "meta-ads-impulse", tool: "Campaign_Performance1" }).text;
    expect(ra).not.toContain("_doublons");
    expect(table(ra.split("\n"))[0]).toEqual(expect.arrayContaining(["actions.lead", "actions.purchase"]));
    // Familles croisées.
    const b = [0, 1, 2, 3].map((i) => ({ campaign_name: `Campagne ${i}`, spend: `${100 + i}`, ...wide(i), actions: [{ action_type: "lead", value: `${40 + i}` }], action_values: [{ action_type: "lead", value: `${40 + i}` }] }));
    const rb = compactText(pretty({ data: b }), { server: "meta-ads-impulse", tool: "Campaign_Performance1" }).text;
    expect(rb).not.toContain("_doublons");
    expect(table(rb.split("\n"))[0]).toEqual(expect.arrayContaining(["actions.lead", "action_values.lead"]));
    // Colonnes génériques égales.
    const c = [1, 2, 3, 4].map((i) => ({ adset_name: `Adset ${i}`, ...wide(i), clicks: `${i * 10}`, inline_link_clicks: `${i * 10}`, spend: `${i}` }));
    const rc = compactText(pretty({ data: c }), { server: "meta-ads-impulse", tool: "Campaign_Performance1" }).text;
    expect(rc).not.toContain("_doublons");
    expect(table(rc.split("\n"))[0]).toEqual(expect.arrayContaining(["clicks", "inline_link_clicks"]));
    // Cas contradictoire : pixel_lead = lead côté actions, pixel_lead = contact côté valeurs.
    const d = [0, 1, 2, 3].map((i) => ({
      campaign_name: `Campagne ${i}`, spend: `${100 + i}`, ...wide(i),
      actions: [{ action_type: "offsite_conversion.fb_pixel_lead", value: `${4 + i}` }, { action_type: "lead", value: `${4 + i}` }, { action_type: "contact", value: `${9 + i}` }],
      action_values: [{ action_type: "offsite_conversion.fb_pixel_lead", value: `${9 + i}` }, { action_type: "contact", value: `${9 + i}` }, { action_type: "lead", value: `${20 + i}` }],
    }));
    const rd = compactText(pretty({ data: d }), { server: "meta-ads-impulse", tool: "Campaign_Performance1" }).text;
    expect(rd).not.toContain("=contact");
    expect(rd).not.toContain("=lead ;");
    const header = table(rd.split("\n"))[0].join(" ");
    expect(header).toContain("fb_pixel_lead"); // la colonne des valeurs, différente de lead, reste affichée
    expect(header).toContain("contact");
  });

  it("D4 : parmi des colonnes égales, seules les variantes du même événement sont fusionnées", () => {
    const data = Array.from({ length: 8 }, (_, i) => ({
      date_start: `2026-06-0${i + 1}`, date_stop: `2026-06-0${i + 1}`, impressions: `${1000 + i}`, clicks: `${50 + i}`, spend: `${10 + i}`,
      actions: [
        { action_type: "purchase", value: `${7 + i}` }, { action_type: "offsite_conversion.fb_pixel_purchase", value: `${7 + i}` },
        { action_type: "landing_page_view", value: `${7 + i}` }, { action_type: "link_click", value: `${45 + i}` },
        { action_type: "add_to_cart", value: `${9 + i}` }, { action_type: "offsite_conversion.fb_pixel_add_to_cart", value: `${9 + i}` },
      ],
      action_values: [{ action_type: "purchase", value: `${7 + i}` }],
    }));
    const { text: out } = compactText(pretty({ data }), { server: "meta-ads-impulse", tool: "Daily_Performance1" });
    const header = table(out.split("\n"))[0];
    expect(header).toEqual(["date_start", "impressions", "clicks", "spend", "actions.purchase", "actions.landing_page_view", "actions.link_click", "actions.add_to_cart", "action_values.purchase"]);
    expect(out.split("\n")[1]).toBe("_doublons: colonnes retirées car identiques à une colonne gardée (retirée=gardée) : offsite_conversion.fb_pixel_purchase=purchase ; offsite_conversion.fb_pixel_add_to_cart=add_to_cart ; date_stop=date_start");
  });

  // D7 — avant : la ligne _doublons rendait ces sorties plus longues que sans fusion.
  it("D7 : sur un petit tableau, garde la forme sans fusion ni abréviation si elle est plus courte", () => {
    const small = [0, 1, 2, 3].map((i) => ({
      date_start: `2026-06-0${i + 1}`, date_stop: `2026-06-0${i + 1}`, spend: `${10 + i}`,
      actions: [{ action_type: "purchase", value: `${i + 1}` }, { action_type: "offsite_conversion.fb_pixel_purchase", value: `${i + 1}` }],
    }));
    const { text: out } = compactText(pretty({ data: small }), { server: "meta-ads-impulse", tool: "Daily_Performance1" });
    expect(out).not.toContain("_doublons");
    expect(out).toBe([
      "_compact: 4 lignes ; nombres arrondis",
      "date_start\tdate_stop\tspend\tactions.purchase\tactions.offsite_conversion.fb_pixel_purchase",
      "2026-06-01\t2026-06-01\t10\t1\t1", "2026-06-02\t2026-06-02\t11\t2\t2", "2026-06-03\t2026-06-03\t12\t3\t3", "2026-06-04\t2026-06-04\t13\t4\t4",
    ].join("\n"));
  });

  it("garde le préfixe quand le retirer créerait une collision", () => {
    const rows = [1, 2, 3].map((i) => ({ clicks: `${i}`, metrics: { clicks: `${i * 2}`, impressions: `${i * 100}` } }));
    const { text: out } = compactText(pretty({ results: rows }), { server: "mcp-google-ads", tool: "Custom_GAQL_Query" });
    expect(out).toContain("clicks\tmetrics.clicks\tmetrics.impressions");
    expect(out).not.toContain("omis");
  });
});

describe("mcp-compact v2 — synthèse au-delà du plafond", () => {
  const results = googleDaily(5, 30);
  const { text: out, stats } = compactText(pretty([{ results }]), { server: "mcp-google-ads", tool: "Daily_Performance", cap: 120 });
  const lines = out.split("\n");
  const raw = {
    clicks: sum(results.map((r) => Number(r.metrics.clicks))),
    impressions: sum(results.map((r) => Number(r.metrics.impressions))),
    cost: sum(results.map((r) => Number(r.metrics.costMicros) / 1e6)),
    conversions: sum(results.map((r) => r.metrics.conversions)),
    conversionsValue: sum(results.map((r) => r.metrics.conversionsValue)),
  };

  it("rend trois tableaux sur toutes les lignes et dit comment obtenir le détail", () => {
    expect(stats.mode).toBe("summary");
    expect(stats.summary).toEqual({ rows: 150, groups: 5, days: 30 });
    expect(stats.truncated).toBeNull();
    expect(lines[0]).toContain("150 lignes jour × campaign.name");
    expect(lines[0]).toContain("du 2026-08-03 au 2026-09-01");
    expect(lines[0]).toContain("plus de 120 lignes");
    expect(lines[0]).toContain("refaire l'appel sur une période de 24 jours ou moins");
    expect(section(lines, "A").length - 1).toBe(5);
    expect(section(lines, "B").length - 1).toBe(30);
    expect(section(lines, "C").length - 1).toBe(25); // 5 campagnes × 5 semaines (4 pleines + 2 jours)
  });

  it("les sommes de chaque tableau égalent les sommes des lignes d'origine", () => {
    for (const letter of ["A", "B", "C"]) {
      const t = section(lines, letter);
      expect(sum(col(t, "clicks"))).toBe(raw.clicks);
      expect(sum(col(t, "impressions"))).toBe(raw.impressions);
      // Chaque cellule est arrondie au centime : tolérance d'un demi-centime par ligne.
      const tol = 0.005 * (t.length - 1) + 1e-9;
      expect(Math.abs(sum(col(t, "cost")) - raw.cost)).toBeLessThanOrEqual(tol);
      expect(Math.abs(sum(col(t, "conversions")) - raw.conversions)).toBeLessThanOrEqual(tol);
      expect(Math.abs(sum(col(t, "conversionsValue")) - raw.conversionsValue)).toBeLessThanOrEqual(tol);
    }
    expect(sum(col(section(lines, "A"), "jours"))).toBe(150);
    expect(sum(col(section(lines, "C"), "jours"))).toBe(150);
  });

  it("recalcule les ratios sur les sommes, sans les moyenner", () => {
    expect(lines[0]).toContain("ratios recalculés sur les sommes (ctr=clicks/impressions ; averageCpc=cost/clicks)");
    const a = section(lines, "A");
    const mine = results.filter((r) => r.campaign.name.endsWith("numéro 2"));
    const row = a.find((r) => r[0].endsWith("numéro 2"))!;
    const clicks = sum(mine.map((r) => Number(r.metrics.clicks)));
    const cost = sum(mine.map((r) => Number(r.metrics.costMicros) / 1e6));
    const cpc = Number(row[a[0].indexOf("averageCpc")]);
    expect(cpc).toBeCloseTo(cost / clicks, 2);
    const averaged = sum(mine.map((r) => r.metrics.averageCpc / 1e6)) / mine.length;
    expect(Math.abs(averaged - cost / clicks)).toBeGreaterThan(0.01); // le jeu d'essai distingue bien les deux
    expect(Math.abs(cpc - averaged)).toBeGreaterThan(0.01);
  });

  it("retire des agrégats les métriques connues pour ne pas se sommer, et le dit (Meta)", () => {
    const data = metaDaily(4, 31, (c, d) => {
      const impressions = 2000 + 10 * d + c;
      const clicks = 20 + c + d;
      const spend = Number((30 + c * 2 + d * 0.25).toFixed(2));
      return {
        reach: `${1500 + d}`, frequency: (impressions / (1500 + d)).toFixed(6),
        ctr: ((100 * clicks) / impressions).toFixed(6), cpm: ((1000 * spend) / impressions).toFixed(6),
        actions: [{ action_type: "purchase", value: `${1 + (d % 3)}` }],
        cost_per_action_type: [{ action_type: "purchase", value: (spend / (1 + (d % 3))).toFixed(6) }],
      };
    });
    const r = compactText(pretty({ data }), { server: "meta-ads-impulse", tool: "Campaign_Daily_Trend1", cap: 100 });
    const l = r.text.split("\n");
    expect(r.stats.mode).toBe("summary");
    expect(l[0]).toContain("retirés car non additifs : reach, frequency");
    // Échelles constatées sur les lignes : ctr Meta en %, cpm pour mille.
    expect(l[0]).toContain("ctr=100×clicks/impressions");
    expect(l[0]).toContain("cpm=1000×spend/impressions");
    expect(l[0]).toContain("cost_per_action_type.purchase=spend/actions.purchase");
    const a = section(l, "A");
    expect(a[0]).not.toContain("reach");
    expect(a[0]).not.toContain("frequency");
    const c0 = data.filter((x) => x.campaign_name.endsWith("campagne 0"));
    const expected = (100 * sum(c0.map((x) => Number(x.clicks)))) / sum(c0.map((x) => Number(x.impressions)));
    expect(Number(a.find((x) => x[0].endsWith("campagne 0"))![a[0].indexOf("ctr")])).toBeCloseTo(expected, 2);
  });

  it("ne résume pas quand une autre dimension varie dans le groupe, ni pour un outil fieldDrop:false", () => {
    const byDevice = googleDaily(5, 30, (c, d) => ({ segmentsDevice: d % 2 ? "MOBILE" : "DESKTOP" }));
    const r1 = compactText(pretty([{ results: byDevice }]), { server: "mcp-google-ads", tool: "Daily_Performance", cap: 120 });
    expect(r1.stats.mode).toBe("table");
    expect(r1.stats.truncated).toMatchObject({ shown: 120, total: 150 });
    expect(r1.text).toContain("MOBILE");
    const r2 = compactText(pretty([{ results }]), { server: "mcp-google-ads", tool: "Custom_GAQL_Query", cap: 120 });
    expect(r2.stats.mode).toBe("table");
    expect(r2.text).not.toContain("recalculables");
    expect(table(r2.text.split("\n"))).toHaveLength(121);
    expect(table(r2.text.split("\n"))[0]).toContain("ctr");
  });

  // D1 — avant : synthèse « sommes sur toutes les lignes » sur une page partielle, dernier jour incomplet.
  it("D1 : ne résume jamais une page partielle et l'annonce en première ligne", () => {
    const data = metaDaily(3, 41);
    data.pop(); data.pop(); // dernier jour : 1 campagne sur 3
    const partial = pretty({ data, paging: { cursors: { after: "x" }, next: "https://graph.example/next" } });
    for (const cap of [100, 400]) {
      const r = compactText(partial, { server: "meta-ads-impulse", tool: "Daily_Performance1", cap });
      expect(r.stats.mode).toBe("table");
      expect(r.text).not.toContain("## A.");
      expect(r.text).not.toContain("sommes sur toutes les lignes");
      expect(r.text.split("\n")[0]).toBe("_attention: page partielle : les totaux ci-dessous sont incomplets, demande la suite ou réduis la période");
      expect(r.text).toContain("has_more=true");
    }
    // La même série, complète, est bien résumée au-delà du plafond : c'est has_more qui l'interdit.
    const whole = compactText(pretty({ data }), { server: "meta-ads-impulse", tool: "Daily_Performance1", cap: 100 });
    expect(whole.stats.mode).toBe("summary");
    expect(whole.text).not.toContain("page partielle");
  });

  it("D1 : l'annonce de page partielle vaut aussi pour un tableau court", () => {
    const rows = [1, 2, 3].map((i) => ({ campaign_name: `Camp ${i}`, spend: `${i}`, impressions: `${i * 100}` }));
    const { text: o } = compactText(pretty({ data: rows, paging: { next: "https://graph.example/next" } }), { server: "meta-ads-impulse", tool: "Campaign_Performance1" });
    expect(o.split("\n")[0]).toContain("page partielle");
  });

  // D2 — avant : actions.lead = 1 sur chaque ligne partait en en-tête et son total (135) disparaissait.
  it("D2 : une métrique additive constante est sommée dans la synthèse, pas laissée en en-tête", () => {
    const data = metaDaily(3, 45, () => ({ actions: [{ action_type: "lead", value: "1" }] }));
    const r = compactText(pretty({ data }), { server: "meta-ads-impulse", tool: "Daily_Performance1", cap: 100 });
    const l = r.text.split("\n");
    expect(r.stats.mode).toBe("summary");
    expect(l).not.toContain("actions.lead=1");
    expect(r.text).not.toContain("colonnes constantes");
    for (const letter of ["A", "B", "C"]) expect(sum(col(section(l, letter), "actions.lead"))).toBe(135);
    expect(col(section(l, "A"), "actions.lead")).toEqual([45, 45, 45]);
  });

  it("D2 : hors synthèse, une métrique en en-tête est dite valeur de chaque ligne", () => {
    const data = metaDaily(3, 10, () => ({ actions: [{ action_type: "lead", value: "1" }] }));
    const r = compactText(pretty({ data }), { server: "meta-ads-impulse", tool: "Daily_Performance1" });
    expect(r.text).toContain("actions.lead=1");
    expect(r.text.split("\n")[0]).toContain("colonnes constantes en en-tête (valeur de chaque ligne, pas un total)");
    // Une constante texte seule ne demande pas cette précision.
    const rows = [1, 2, 3].map((i) => ({ campaign_name: `Camp ${i}`, status: "ACTIVE", spend: `${i}` }));
    const t = compactText(pretty({ data: rows }), { server: "meta-ads-impulse", tool: "Get_Campaigns1" }).text;
    expect(t).toContain("colonnes constantes en en-tête");
    expect(t).not.toContain("pas un total");
  });

  // D3 — avant : l'heure était écrasée et annoncée « retirés car non additifs : hour ».
  it("D3 : une dimension numérique (heure, date GA4) empêche la synthèse ou reste une dimension", () => {
    const hourly = [];
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) for (const c of ["Campagne Alpha", "Campagne Beta"]) {
      hourly.push({ campaign: { name: c }, segments: { date: `2026-06-0${d + 1}`, hour: h }, metrics: { clicks: `${h + d}`, impressions: `${100 + h}`, costMicros: `${1_000_000 + h * 1000}` } });
    }
    const r = compactText(pretty({ results: hourly }), { server: "mcp-google-ads", tool: "Daily_Performance", cap: 120 });
    expect(r.stats.mode).toBe("table");
    expect(r.text).not.toContain("non additifs");
    expect(table(r.text.split("\n"))[0]).toContain("hour");

    // GA4 : la date arrive en AAAAMMJJ et devient un nombre ; elle reste la dimension date.
    const rows = [];
    for (let d = 0; d < 45; d++) for (const s of ["google / cpc", "facebook / paid", "(direct) / (none)"]) {
      const day = new Date(Date.UTC(2026, 5, 1 + d)).toISOString().slice(0, 10).replace(/-/g, "");
      rows.push({ dimensionValues: [{ value: day }, { value: s }], metricValues: [{ value: `${100 + d}` }, { value: `${80 + d}` }, { value: `${(0.3 + d / 200).toFixed(4)}` }] });
    }
    const ga4 = { dimensionHeaders: [{ name: "date" }, { name: "sessionSourceMedium" }], metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }, { name: "bounceRate" }], rows, rowCount: 135 };
    const g = compactText(pretty(ga4), { server: "mcp-google-analytics", tool: "run_report", cap: 100 });
    const l = g.text.split("\n");
    expect(g.stats.mode).toBe("summary");
    expect(l[0]).toContain("du 20260601 au 20260715");
    expect(l[0]).toContain("retirés car non additifs : totalUsers, bounceRate");
    expect(l[0]).not.toMatch(/non additifs : [^;]*date/);
    expect(section(l, "B")).toHaveLength(46);
    expect(section(l, "B")[1][0]).toBe("20260601");
    expect(sum(col(section(l, "A"), "sessions"))).toBe(sum(rows.map((x) => Number(x.metricValues[0].value))));
  });

  it("D3 : un nombre dont on ne sait pas s'il se somme empêche la synthèse", () => {
    const odd = googleDaily(5, 30, (c, d) => ({ qualityScore: 3 + ((c + d) % 7) }));
    const r = compactText(pretty([{ results: odd }]), { server: "mcp-google-ads", tool: "Daily_Performance", cap: 120 });
    expect(r.stats.mode).toBe("table");
    expect(table(r.text.split("\n"))[0]).toContain("qualityScore");
  });
});

describe("mcp-compact v2 — colonnes recalculables et arrondis", () => {
  it("retire ctr et cpc des tableaux de plus de 40 lignes, formule annoncée", () => {
    const results = googleDaily(2, 30);
    const { text: out, stats } = compactText(pretty([{ results }]), { server: "mcp-google-ads", tool: "Daily_Performance" });
    expect(stats.mode).toBe("table");
    expect(out.split("\n")[0]).toContain("colonnes recalculables retirées (ctr=clicks/impressions ; averageCpc=cost/clicks)");
    const t = table(out.split("\n"));
    expect(t[0]).toEqual(["date", "clicks", "impressions", "cost", "conversions", "conversionsValue"]);
    expect(t).toHaveLength(61);
  });

  // D6 — avant : 4 lignes fausses sur 60 (moins de 10 %) et la colonne partait, leurs valeurs avec.
  it("D6 : garde la colonne dès qu'une seule ligne s'écarte de la formule", () => {
    const results = googleDaily(2, 30).map((r, i) => (i === 17 ? { ...r, metrics: { ...r.metrics, averageCpc: 9_990_000 } } : r));
    const { text: out } = compactText(pretty([{ results }]), { server: "mcp-google-ads", tool: "Daily_Performance" });
    expect(out.split("\n")[0]).toContain("colonnes recalculables retirées (ctr=clicks/impressions)");
    const t = table(out.split("\n"));
    expect(t[0]).toContain("averageCpc");
    expect(t.filter((r) => r[t[0].indexOf("averageCpc")] === "9.99")).toHaveLength(1);
  });

  // D5 — avant : 105.6 et 106.4 s'affichaient 106 tous les deux, 0.004 conversion s'affichait 0.
  it("D5 : l'arrondi ne crée pas d'égalité que la v1 n'avait pas, et ne rend jamais 0 une valeur non nulle", () => {
    const results = [["Campagne A", 105.6, 0.228456], ["Campagne B", 106.4, 0.228512], ["Campagne C", 50, 0.02]].map(([n, cpa, ctr]) => ({
      campaign: { name: n }, metrics: { costPerConversion: Number(cpa) * 1e6, ctr, conversions: 0.004, conversionsValue: 0.00004, averageCpc: 123_456_789 },
    }));
    const { text: out } = compactText(pretty({ results }), { server: "mcp-google-ads", tool: "Campaign_Performance" });
    expect(out).toContain("Campagne A\t105.6\t0.2285");
    expect(out).toContain("Campagne B\t106.4\t0.2285"); // égalité déjà présente en v1 (4 décimales sous 1)
    expect(out).toContain("conversions=0.004");
    expect(out).toContain("conversionsValue=0.00004");
    expect(out).toContain("averageCpc=123.46");
  });
});
