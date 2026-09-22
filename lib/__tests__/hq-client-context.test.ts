import { describe, expect, it } from "vitest";
import { buildHqContextUserPrompt, isHqContextFresh, isValidHqSlug, normalizeClientName, parseHqContextOutput, HQ_CONTEXT_TTL_MS } from "@/lib/hq-client-context";
import { buildReportSystemPrompt, renderDataForPrompt, REPORT_HQ_PROMPT } from "@/lib/report-generate";
import type { ReportData } from "@/lib/report-data";

describe("hq-client-context", () => {
  it("normalizes client names into slug candidates", () => {
    expect(normalizeClientName("Saveurs & Vie")).toBe("saveursvie");
    expect(normalizeClientName("Leroy Merlin South Africa")).toBe("leroymerlinsouthafrica");
    expect(normalizeClientName("Massé na")).toBe("massena");
  });

  it("validates slugs", () => {
    expect(isValidHqSlug("saveursvie")).toBe(true);
    expect(isValidHqSlug("cours-legendre")).toBe(true);
    expect(isValidHqSlug("../secrets")).toBe(false);
    expect(isValidHqSlug("Saveurs Vie")).toBe(false);
    expect(isValidHqSlug(null)).toBe(false);
  });

  it("parses a found brief from a json fence with prose around", () => {
    const raw = 'Voici :\n```json\n{"found": true, "slug": "Saveursvie", "sources": ["projects/saveursvie/client.yaml"], "brief": "### Client\\nPortage de repas seniors, FR.\\n### Objectifs & KPI cible\\nCpCC sur Creation_De_Compte."}\n```\n';
    const r = parseHqContextOutput(raw);
    expect(r.found).toBe(true);
    expect(r.slug).toBe("saveursvie");
    expect(r.sources).toEqual(["projects/saveursvie/client.yaml"]);
    expect(r.brief).toContain("Creation_De_Compte");
  });

  it("reports not-found and unreadable answers without throwing", () => {
    expect(parseHqContextOutput('```json\n{"found": false, "reason": "aucun dossier"}\n```').found).toBe(false);
    expect(parseHqContextOutput("désolé, rien trouvé").found).toBe(false);
    expect(parseHqContextOutput('{"found": true, "slug": "x y", "brief": "trop court"}').found).toBe(false);
  });

  it("builds a prompt that pins the slug and the account ids", () => {
    const p = buildHqContextUserPrompt({ name: "Saveurs & Vie", metaAccountId: "455384377812735", googleCustomerId: "6010469196", slug: "saveursvie" });
    expect(p).toContain("SLUG HQ : saveursvie");
    expect(p).toContain("act_455384377812735");
    expect(p).toContain("6010469196");
  });

  it("freshness follows the TTL", () => {
    const now = Date.now();
    expect(isHqContextFresh({ hqContextMd: "x", hqContextAt: new Date(now - 1000) }, now)).toBe(true);
    expect(isHqContextFresh({ hqContextMd: "x", hqContextAt: new Date(now - HQ_CONTEXT_TTL_MS - 1) }, now)).toBe(false);
    expect(isHqContextFresh({ hqContextMd: null, hqContextAt: new Date(now) }, now)).toBe(false);
  });
});

function minimalData(extra: Partial<ReportData> = {}): ReportData {
  return {
    client: { dashboardId: "d1", name: "Saveurs & Vie", metaAccountId: "1", googleCustomerId: null, platforms: ["meta"] },
    period: { since: "2026-09-01", until: "2026-09-07" },
    compare: null,
    currency: "EUR",
    kpis: [],
    platforms: null,
    daily: {},
    funnel: null,
    demographics: [],
    devices: [],
    countries: [],
    campaigns: { meta: [], google: [] },
    keywords: [],
    searchTerms: [],
    creatives: [],
    pacing: null,
    alerts: [],
    previousReport: null,
    warnings: [],
    generatedAt: "2026-09-08T07:00:00.000Z",
    ...extra,
  };
}

describe("report prompt with HQ context", () => {
  it("injects the brief into the user prompt and the HQ rules into the system prompt", () => {
    const data = minimalData({ hqContext: { slug: "saveursvie", brief: "### Objectifs & KPI cible\nCpCC max 25 €.", fetchedAt: "2026-09-07T10:00:00.000Z" } });
    const user = renderDataForPrompt(data);
    expect(user).toContain("CONTEXTE AGENCE (HQ — dossier projects/saveursvie, lu le 2026-09-07)");
    expect(user).toContain("CpCC max 25 €");
    expect(buildReportSystemPrompt(data)).toContain(REPORT_HQ_PROMPT);
  });

  it("stays silent without HQ context", () => {
    const data = minimalData();
    expect(renderDataForPrompt(data)).not.toContain("CONTEXTE AGENCE");
    expect(buildReportSystemPrompt(data)).not.toContain(REPORT_HQ_PROMPT);
  });
});
