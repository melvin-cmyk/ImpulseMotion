/**
 * Copilote des dashboards du staff : lecture des blocs ```action, application
 * des propositions, état court et page envoyée à l'IA.
 */
import { describe, it, expect } from "vitest";
import {
  applyProposal, extractProposals, htmlHash, proposalLabel, stateDiff, stripProposalBlocks, type StaffDashboardState,
} from "@/lib/staff-dashboards/proposals";
import { buildStaffCopilotSystemPrompt, buildStaffCopilotTurnContext, withPageIfUnseen, STAFF_COPILOT_CONTEXT_MAX_CHARS } from "@/lib/staff-dashboards/copilot";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@/lib/ai-tool-guidance";

const base: StaffDashboardState = {
  title: "Pacing",
  description: "",
  datasets: { g_spend: { title: "Dépense", source: { kind: "query", connector: "n8n google ads", tool: "Custom_GAQL_Query", args: { customer_id: "123", gaql_query: "SELECT 1" } } } },
  params: { region: null },
  html: "<style>.cl{}</style>\n<div class=\"cl\"><h1>Pacing</h1><p id=\"take\">Pacing —</p></div>\n<script>dash.onData(() => {});</script>",
};

describe("extractProposals", () => {
  it("lit les blocs action, json et nus ; set_html prend le bloc html qui suit", () => {
    const text = [
      "Je propose deux choses.",
      "```action", '{"action":"set_title","title":"Nouveau"}', "```",
      "```json", '{"action":"remove_dataset","id":"g_spend"}', "```",
      "Et la page :",
      "```action", '{"action":"set_html"}', "```",
      "```html", "<div>page</div>", "", "```",
      "```js", "console.log(1)", "```",
    ].join("\n");
    const out = extractProposals(text);
    expect(out.map((p) => p.proposal.action)).toEqual(["set_title", "remove_dataset", "set_html"]);
    expect(out[2].proposal).toEqual({ action: "set_html", html: "<div>page</div>" });
    expect(out.map((p) => p.index)).toEqual([0, 1, 2]);
    const clean = stripProposalBlocks(text);
    expect(clean).toContain("Je propose deux choses.");
    expect(clean).toContain("console.log(1)");
    expect(clean).not.toContain("<div>page</div>");
    expect(clean).not.toContain("set_title");
  });

  it("ignore un set_html sans page et un bloc à la forme inconnue", () => {
    expect(extractProposals("```action\n{\"action\":\"set_html\"}\n```\n```action\n{\"action\":\"set_title\",\"title\":\"x\"}\n```").map((p) => p.proposal.action)).toEqual(["set_title"]);
    expect(extractProposals("```action\n{\"action\":\"explode\"}\n```")).toEqual([]);
    expect(extractProposals("```action\n{\"action\":\"edit_html\",\"find\":\"a\"}\n```")).toEqual([]);
  });

  it("accepte set_html avec le champ html inline et les retouches edit_html", () => {
    const out = extractProposals("```action\n{\"action\":\"set_html\",\"html\":\"<b>x</b>\"}\n```\n```action\n{\"action\":\"edit_html\",\"find\":\"a\",\"replace\":\"b\",\"all\":true}\n```");
    expect(out[0].proposal).toEqual({ action: "set_html", html: "<b>x</b>" });
    expect(out[1].proposal).toEqual({ action: "edit_html", find: "a", replace: "b", all: true });
  });
});

describe("applyProposal", () => {
  it("retouche la page quand le texte est unique, refuse l'ambigu et l'absent", () => {
    const next = applyProposal(base, { action: "edit_html", find: "<h1>Pacing</h1>", replace: "<h1>Pacing budget</h1>" });
    expect(next.html).toContain("<h1>Pacing budget</h1>");
    expect(() => applyProposal(base, { action: "edit_html", find: "Pacing", replace: "X" })).toThrow(/2 fois/);
    expect(applyProposal(base, { action: "edit_html", find: "Pacing", replace: "X", all: true }).html).not.toContain("Pacing");
    expect(() => applyProposal(base, { action: "edit_html", find: "absent", replace: "X" })).toThrow(/n'apparaît pas/);
    expect(() => applyProposal(base, { action: "edit_html", find: "", replace: "X" })).toThrow(/vide/);
  });

  it("gère titre, jeux de données et paramètres avec les règles du modèle", () => {
    expect(applyProposal(base, { action: "set_title", title: "  Nouveau ", description: "desc" })).toMatchObject({ title: "Nouveau", description: "desc" });
    expect(() => applyProposal(base, { action: "set_title", title: "  " })).toThrow(/vide/);
    const ds = { title: "Meta", source: { connector: "mcp facebook", tool: "Campaign_Performance1", args: { input: "{}" } } };
    expect(Object.keys(applyProposal(base, { action: "set_dataset", id: "m_spend", dataset: ds }).datasets)).toEqual(["g_spend", "m_spend"]);
    expect(() => applyProposal(base, { action: "set_dataset", id: "bad id", dataset: ds })).toThrow(/Identifiant/);
    expect(() => applyProposal(base, { action: "set_dataset", id: "x", dataset: { ...ds, source: { ...ds.source, connector: "salesforce" } } })).toThrow(/Connecteur inconnu/);
    expect(applyProposal(base, { action: "remove_dataset", id: "g_spend" }).datasets).toEqual({});
    expect(() => applyProposal(base, { action: "remove_dataset", id: "nope" })).toThrow(/n'existe pas/);
    expect(applyProposal(base, { action: "set_params", params: { month: "2026-10" } }).params).toEqual({ month: "2026-10" });
    expect(() => applyProposal(base, { action: "set_params", params: { "1bad": 1 } })).toThrow(/paramètre invalide/);
  });

  it("stateDiff ne renvoie que ce qui change", () => {
    const after = applyProposal(base, { action: "set_html", html: "<p>x</p>" });
    expect(Object.keys(stateDiff(base, after))).toEqual(["html"]);
    expect(stateDiff(base, base)).toEqual({});
    expect(proposalLabel({ action: "set_html", html: "<p>x</p>" })).toMatch(/page entière/);
  });
});

describe("état court et page", () => {
  it("l'empreinte est stable et sensible au contenu", () => {
    expect(htmlHash(base.html)).toBe(htmlHash(base.html));
    expect(htmlHash(base.html)).not.toBe(htmlHash(base.html + " "));
    expect(htmlHash("")).toMatch(/^0-[0-9a-f]{8}$/);
  });

  it("le contexte de tour tient dans la limite même avec des jeux volumineux", () => {
    const datasets: StaffDashboardState["datasets"] = {};
    for (let i = 0; i < 40; i++) datasets[`d${i}`] = { title: `Jeu ${i}`, description: "x".repeat(900), source: { connector: "n8n google ads", tool: "Custom_GAQL_Query", args: { gaql_query: "SELECT ".padEnd(1500, "a") } } };
    const ctx = buildStaffCopilotTurnContext({ ...base, datasets });
    expect(ctx.length).toBeLessThanOrEqual(STAFF_COPILOT_CONTEXT_MAX_CHARS);
    expect(ctx).toContain("ÉTAT ABRÉGÉ");
    expect(ctx).toContain(htmlHash(base.html));
    const small = buildStaffCopilotTurnContext(base);
    expect(small).not.toContain("ÉTAT ABRÉGÉ");
    expect(small).toContain("g_spend");
    expect(buildStaffCopilotTurnContext({ ...base, html: "" })).toContain("VIDE");
  });

  it("la page part seulement quand l'IA ne connaît pas cette version", () => {
    const hash = htmlHash(base.html);
    const sent = withPageIfUnseen("Ajoute un KPI", base.html, null);
    expect(sent.pageSent).toBe(true);
    expect(sent.hash).toBe(hash);
    expect(sent.content).toContain("```html\n" + base.html + "\n```");
    expect(sent.content.endsWith("Ajoute un KPI")).toBe(true);
    const kept = withPageIfUnseen("Encore", base.html, hash);
    expect(kept).toEqual({ content: "Encore", hash, pageSent: false });
    expect(withPageIfUnseen("Crée", "", null).content).toContain("vide");
  });

  it("le prompt système a ses deux parties et le catalogue des outils", () => {
    const p = buildStaffCopilotSystemPrompt("melvin@impulse-analytics.com");
    const [staticPart, dynamicPart] = p.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(staticPart).toContain("Custom_GAQL_Query");
    expect(staticPart).toContain("edit_html");
    expect(staticPart).toContain("dash.onData");
    expect(staticPart).not.toContain("melvin@");
    expect(dynamicPart).toContain("melvin@impulse-analytics.com");
  });
});
