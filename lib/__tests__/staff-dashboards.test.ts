/**
 * « Mes dashboards » (staff) : lecture d'une définition, connecteurs, paramètres,
 * comptes nommés par un appel et refus hors périmètre, cadre isolé.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
const state = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/relay-tool", () => ({
  relayDirectTool: async (tool: string, input: Record<string, unknown>) => {
    calls.push({ tool, input });
    if (state.fail) throw new Error("Relay http://localhost:3457 /api/tool 502");
    return { results: [{ campaign: { name: "A" } }] };
  },
}));

import { accountsOfCall, connectorServer, loadTemplate, parseDatasets, parseParams, substituteParams, TEMPLATES } from "@/lib/staff-dashboards/model";
import { runDataset, runDatasets, scopeRefusal, forgetDashboardCache } from "@/lib/staff-dashboards/data";
import { buildFrameDocument } from "@/lib/staff-dashboards/frame";
import type { AccountScope } from "@/lib/scope";

beforeEach(() => { calls.length = 0; state.fail = false; });

describe("connecteurs", () => {
  it("reconnaît les noms libres des consultants et les noms de serveurs du relay", () => {
    expect(connectorServer("n8n google ads")).toBe("mcp-google-ads");
    expect(connectorServer("Google Ads")).toBe("mcp-google-ads");
    expect(connectorServer("mcp facebook")).toBe("meta-ads-impulse");
    expect(connectorServer("meta-ads-impulse")).toBe("meta-ads-impulse");
    expect(connectorServer("n8n google spreedsheet")).toBe("mcp-google-sheet");
    expect(connectorServer("Google Sheets")).toBe("mcp-google-sheet");
    expect(connectorServer("tiktok")).toBe("mcp-tiktok-ads");
    expect(connectorServer("BigQuery")).toBeNull();
  });
});

describe("parseDatasets / parseParams", () => {
  it("garde les entrées valides et nomme les autres", () => {
    const { datasets, errors } = parseDatasets({
      ok: { title: "Dépense", description: "Lit GAQL", source: { kind: "query", connector: "n8n google ads", tool: "Custom_GAQL_Query", args: { customer_id: "1", gaql_query: "SELECT 1" } } },
      "bad id!": { title: "x", source: { connector: "meta", tool: "t" } },
      nofile: { title: "f", source: { kind: "file", url: "/_blob/1", name: "a.csv" } },
      unknown: { title: "u", source: { connector: "bigquery", tool: "q" } },
    });
    expect(Object.keys(datasets)).toEqual(["ok"]);
    expect(datasets.ok.source.args).toEqual({ customer_id: "1", gaql_query: "SELECT 1" });
    expect(errors).toHaveLength(3);
    expect(errors[1]).toMatch(/file/);
    expect(parseDatasets("{nope").errors[0]).toMatch(/illisible/);
    expect(parseParams({ region: "FR", n: 3, flag: true, list: ["a", 1], bad: { x: 1 }, "no spaces": 1 })).toEqual({ region: "FR", n: 3, flag: true, list: ["a", 1] });
  });
});

describe("substituteParams", () => {
  it("remplace une chaîne entière par la valeur typée et le reste en texte", () => {
    const out = substituteParams({ customer_id: "{{cid}}", q: "WHERE r = {{region}} AND x IN ({{list}})", n: 3, nested: { s: "{{missing}}", t: "a{{missing}}b" } }, { cid: 12, region: "FR", list: ["a", "b"] });
    expect(out).toEqual({ customer_id: 12, q: "WHERE r = FR AND x IN (a, b)", n: 3, nested: { s: null, t: "ab" } });
  });
});

describe("périmètre", () => {
  const scope: AccountScope = { all: false, meta: new Set(["595800441007042"]), google: new Set(["2389119715"]), tiktok: new Set() };
  it("lit les comptes nommés par Google, Meta (input JSON) et TikTok", () => {
    expect(accountsOfCall("mcp-google-ads", { customer_id: "238-911-9715" })).toEqual([{ platform: "google", id: "2389119715" }]);
    expect(accountsOfCall("meta-ads-impulse", { input: JSON.stringify({ ad_account_id: "act_595800441007042" }) })).toEqual([{ platform: "meta", id: "act_595800441007042" }]);
    expect(accountsOfCall("mcp-tiktok-ads", { input: JSON.stringify({ advertiser_ids: "[\"7000000000000000001\"]" }) })).toEqual([{ platform: "tiktok", id: "7000000000000000001" }]);
    expect(accountsOfCall("mcp-google-sheet", { Document: "abc" })).toEqual([]);
  });
  it("refuse un compte hors périmètre, laisse passer les Sheets", () => {
    expect(scopeRefusal("mcp-google-ads", { customer_id: "2389119715" }, scope)).toBeNull();
    expect(scopeRefusal("mcp-google-ads", { customer_id: "9999999999" }, scope)).toMatch(/hors de votre périmètre/);
    expect(scopeRefusal("meta-ads-impulse", { input: JSON.stringify({ ad_account_id: "act_1" }) }, scope)).toMatch(/meta/);
    expect(scopeRefusal("mcp-google-sheet", { Document: "x", Sheet: "y" }, scope)).toBeNull();
  });
});

describe("runDataset", () => {
  const ds = { title: "t", source: { kind: "query" as const, connector: "n8n google ads", tool: "Custom_GAQL_Query", args: { customer_id: "2389119715", gaql_query: "SELECT {{x}}" } } };
  const all: AccountScope = { all: true };

  it("appelle le relay avec les paramètres remplacés, puis sert le cache", async () => {
    forgetDashboardCache("d1");
    const r1 = await runDataset("d1", "g", ds, { x: 1 }, all);
    expect(r1.status).toBe("ok");
    expect(calls).toEqual([{ tool: "mcp-google-ads.Custom_GAQL_Query", input: { customer_id: "2389119715", gaql_query: "SELECT 1" } }]);
    const r2 = await runDataset("d1", "g", ds, { x: 1 }, all);
    expect(r2.status).toBe("ok");
    expect((r2 as { cached?: boolean }).cached).toBe(true);
    expect(calls).toHaveLength(1);
    // another parameter value → another call ; refresh → another call
    await runDataset("d1", "g", ds, { x: 2 }, all);
    await runDataset("d1", "g", ds, { x: 1 }, all, { refresh: true });
    expect(calls).toHaveLength(3);
  });

  it("refuse hors périmètre sans appeler, et rend une erreur lisible si le relay tombe", async () => {
    forgetDashboardCache("d2");
    const scope: AccountScope = { all: false, meta: new Set(), google: new Set(), tiktok: new Set() };
    const r = await runDataset("d2", "g", ds, {}, scope);
    expect(r.status).toBe("declined");
    expect(calls).toHaveLength(0);
    state.fail = true;
    const e = await runDataset("d2", "g", ds, {}, all);
    expect(e.status).toBe("error");
    expect((e as { message: string }).message).toMatch(/502/);
  });

  it("runDatasets lit plusieurs jeux et signale les inconnus", async () => {
    forgetDashboardCache("d3");
    const out = await runDatasets("d3", { g: ds }, ["g", "zz"], {}, all);
    expect(out.g.status).toBe("ok");
    expect(out.zz.status).toBe("error");
  });
});

describe("modèles et cadre", () => {
  it("le modèle Cours Legendre se charge : 15 jeux, page avec ses scripts", () => {
    expect(TEMPLATES.map((t) => t.key)).toContain("cours-legendre");
    const t = loadTemplate("cours-legendre")!;
    expect(Object.keys(t.datasets)).toHaveLength(15);
    expect(t.datasets.g_spend.source.tool).toBe("Custom_GAQL_Query");
    expect(connectorServer(t.datasets.meta_spend.source.connector)).toBe("meta-ads-impulse");
    expect(t.html).toContain("dash.calc('pacing'");
    expect(loadTemplate("nope")).toBeNull();
  });

  it("buildFrameDocument charge d3 et le runtime depuis l'origine, puis démarre avec les jeux", () => {
    const doc = buildFrameDocument("<p>hi</p><script>dash.onData(() => {})</script>", ["a", "b"], { r: "FR" }, "https://app.test/");
    expect(doc).toContain('<script src="https://app.test/vendor/d3.v7.min.js"></script>');
    expect(doc).toContain('<script src="https://app.test/dash-runtime.js"></script>');
    expect(doc).toContain('<div id="dash-root"><p>hi</p>');
    expect(doc).toContain('dash.__boot(["a","b"], {"r":"FR"});');
    // a parameter value cannot close the script tag
    expect(buildFrameDocument("", [], { x: "</script><script>alert(1)" })).not.toContain("</script><script>alert");
  });
});
