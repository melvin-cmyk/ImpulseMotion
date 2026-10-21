/**
 * Sources cochées d'un dashboard du staff : lecture, normalisation des
 * identifiants, texte donné au copilote et action set_sources.
 */
import { describe, it, expect } from "vitest";
import { parseSources, sourcesContextText, sourceSummary, normalizeSourceAccountId, SOURCE_KINDS } from "@/lib/staff-dashboards/sources";
import { applyProposal, coerceProposal, proposalLabel, stateDiff, type StaffDashboardState } from "@/lib/staff-dashboards/proposals";
import { buildStaffCopilotSystemPrompt, buildStaffCopilotTurnContext } from "@/lib/staff-dashboards/copilot";

const base: StaffDashboardState = { title: "Pacing", description: "", datasets: {}, params: {}, html: "" };

describe("parseSources", () => {
  it("garde une source par type, dédoublonne et normalise les comptes", () => {
    const out = parseSources([
      { kind: "google", accounts: [{ id: "973-316-6788", name: "Liferay" }, { accountId: "9733166788" }, "123"] },
      { kind: "meta", accounts: ["123456", { id: "act_123456", name: "LPEV" }], detail: "  deux   espaces  " },
      { kind: "google", accounts: [{ id: "999" }] },
      { kind: "inconnu", accounts: [] },
      "n'importe quoi",
    ]);
    expect(out).toEqual([
      { kind: "google", accounts: [{ id: "9733166788", name: "Liferay" }, { id: "123", name: "123" }], detail: "" },
      { kind: "meta", accounts: [{ id: "act_123456", name: "act_123456" }], detail: "deux espaces" },
    ]);
  });

  it("lit une chaîne JSON et rend [] pour tout ce qui n'est pas une liste", () => {
    expect(parseSources('[{"kind":"tiktok","accounts":[],"detail":""}]')).toEqual([{ kind: "tiktok", accounts: [], detail: "" }]);
    expect(parseSources("{")).toEqual([]);
    expect(parseSources(null)).toEqual([]);
    expect(parseSources({ kind: "google" })).toEqual([]);
  });

  it("normalise par plateforme", () => {
    expect(normalizeSourceAccountId("google", " 973-316-6788 ")).toBe("9733166788");
    expect(normalizeSourceAccountId("meta", "123")).toBe("act_123");
    expect(normalizeSourceAccountId("meta", "act_123")).toBe("act_123");
    expect(normalizeSourceAccountId("tiktok", "7012")).toBe("7012");
  });
});

describe("texte pour le copilote", () => {
  it("nomme chaque source, ses comptes, sa précision et son connecteur", () => {
    const text = sourcesContextText([
      { kind: "google", accounts: [{ id: "9733166788", name: "Liferay" }], detail: "" },
      { kind: "sheets", accounts: [], detail: "https://docs.google.com/spreadsheets/d/abc — onglet Pays" },
      { kind: "warehouse", accounts: [{ id: "lpev", name: "LPEV" }], detail: "" },
    ]);
    expect(text).toContain("Google Ads — comptes : Liferay (9733166788) ; connector \"n8n google ads\"");
    expect(text).toContain("Google Sheets — précision : https://docs.google.com/spreadsheets/d/abc — onglet Pays ; connector \"n8n google spreedsheet\"");
    expect(text).toContain("Entrepôt e-commerce — comptes : LPEV (lpev) ; outils data_*");
    expect(sourcesContextText([])).toContain("aucune");
  });

  it("entre dans l'état du dashboard et dans les instructions", () => {
    const ctx = buildStaffCopilotTurnContext({ ...base, sources: [{ kind: "meta", accounts: [{ id: "act_1", name: "Naturalia" }], detail: "" }] });
    expect(ctx).toContain("Sources choisies par le consultant");
    expect(ctx).toContain("Naturalia (act_1)");
    expect(buildStaffCopilotTurnContext(base)).toContain("aucune");
    const prompt = buildStaffCopilotSystemPrompt(null);
    expect(prompt).toContain("SOURCES CHOISIES PAR LE CONSULTANT");
    expect(prompt).toContain('"action":"set_sources"');
    for (const k of SOURCE_KINDS) expect(prompt).toContain(k.label);
  });

  it("résume une source en pastille", () => {
    expect(sourceSummary({ kind: "google", accounts: [], detail: "" })).toBe("Google Ads");
    expect(sourceSummary({ kind: "google", accounts: [{ id: "1", name: "Liferay" }], detail: "" })).toBe("Google Ads · Liferay");
    expect(sourceSummary({ kind: "meta", accounts: [{ id: "1", name: "A" }, { id: "2", name: "B" }], detail: "" })).toBe("Meta Ads · 2 comptes");
  });
});

describe("action set_sources", () => {
  it("est lue, appliquée et envoyée dans le diff", () => {
    const p = coerceProposal({ action: "set_sources", sources: [{ kind: "tiktok", accounts: [{ id: "70", name: "DT" }] }, { kind: "nope" }] });
    expect(p).toEqual({ action: "set_sources", sources: [{ kind: "tiktok", accounts: [{ id: "70", name: "DT" }], detail: "" }] });
    const after = applyProposal(base, p!);
    expect(after.sources).toEqual([{ kind: "tiktok", accounts: [{ id: "70", name: "DT" }], detail: "" }]);
    expect(stateDiff(base, after)).toEqual({ sources: after.sources });
    expect(stateDiff(after, after)).toEqual({});
    expect(proposalLabel(p!)).toBe("Sources : TikTok Ads · DT");
    expect(coerceProposal({ action: "set_sources", sources: "x" })).toBeNull();
  });
});
