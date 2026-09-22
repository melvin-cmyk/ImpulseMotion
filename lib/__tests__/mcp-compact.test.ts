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
    expect(out).toContain("metrics.cost");
    expect(out).toContain("545.02");
    expect(out).toContain("metrics.averageCpc");
    expect(out).toContain("1.26");
    expect(out).toContain("0.1175");
    expect(out).toContain("_shared:");
    expect(out).toContain("Headline 0");
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
