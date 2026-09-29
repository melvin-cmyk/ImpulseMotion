import { describe, expect, it } from "vitest";

import { parseTemplate, renderTemplate, renderTemplateDetailed, runDate, scopeFromContext, templateError, templateRefs } from "@/lib/routines/template";

const scope = (row: Record<string, string | number | boolean | null> | null = null) => ({
  row, runDate: "2026-09-29", steps: { resume: { text: "Bonne semaine." }, lire: { rows: { columns: [], rows: [], truncated: false } } },
});

describe("routines — template grammar", () => {
  it("accepts the three placeholders and plain text", () => {
    for (const ok of [
      "", "Bonjour", "{{run.date}}", "{{ run.date }}", "{{row.nom}}", "{{row.Nom de la créa}}", "{{row.CTR (%)}}",
      "{{steps.resume.text}}", "Bilan du {{run.date}} : {{steps.resume.text}} ({{row.nom}})", "accolade } seule et }} fermante",
    ]) expect(templateError(ok), ok).toBeNull();
  });

  it("refuses everything else", () => {
    for (const bad of [
      "{{run.time}}", "{{run}}", "{{date}}", "{{row}}", "{{row.}}", "{{steps.resume}}", "{{steps.resume.rows}}", "{{steps..text}}",
      "{{steps.a b.text}}", "{{env.CRON_SECRET}}", "{{process.env.X}}", "{{constructor.constructor('return 1')()}}",
      "{{row.nom | upper}}", "{{#if x}}", "{{#each rows}}", "{{> partial}}", "{{{row.nom}}}", "{{row.a{{row.b}}}}", "{{ 1 + 1 }}",
      "{{row.nom", "texte {{", "{{}}",
    ]) expect(templateError(bad), bad).toBeTypeOf("string");
    for (const bad of [null, undefined, 3, {}, ["{{run.date}}"]]) expect(templateError(bad)).toBeTypeOf("string");
    expect(templateError("x".repeat(5001))).toMatch(/trop long/);
  });

  it("names what is accepted in its refusal", () => {
    expect(templateError("{{env.SECRET}}")).toMatch(/\{\{row\.<colonne>\}\}.*\{\{run\.date\}\}.*\{\{steps\.<id>\.text\}\}/);
  });

  it("lists what a template reads", () => {
    expect(templateRefs("{{row.a}} {{row.b}} {{row.a}} {{steps.s1.text}} {{run.date}}")).toEqual({ columns: ["a", "b"], stepIds: ["s1"], runDate: true });
    expect(templateRefs("rien")).toEqual({ columns: [], stepIds: [], runDate: false });
    expect(() => templateRefs("{{oops}}")).toThrow();
  });
});

describe("routines — template rendering", () => {
  it("substitutes cells, date and step text", () => {
    expect(renderTemplate("{{row.nom}} : {{row.budget}} € le {{run.date}}. {{steps.resume.text}}", scope({ nom: "Promo", budget: 12.5 })))
      .toBe("Promo : 12.5 € le 2026-09-29. Bonne semaine.");
    expect(renderTemplate("{{row.actif}}/{{row.vide}}", scope({ actif: true, vide: null }))).toBe("true/");
  });

  it("never reads a value as a template again", () => {
    const row = { nom: "{{steps.resume.text}}", texte: "{{row.secret}} {{run.date}}", secret: "confidentiel" };
    expect(renderTemplate("{{row.nom}}", scope(row))).toBe("{{steps.resume.text}}");
    expect(renderTemplate("{{row.texte}}", scope(row))).toBe("{{row.secret}} {{run.date}}");
    // Same for the text of a step: what the AI wrote is quoted, not interpreted.
    const s = { row, runDate: "2026-09-29", steps: { resume: { text: "{{row.secret}}" } } };
    expect(renderTemplate("{{steps.resume.text}} / {{row.nom}}", s)).toBe("{{row.secret}} / {{steps.resume.text}}");
  });

  it("renders a missing value as empty and reports it", () => {
    expect(renderTemplateDetailed("a{{row.absente}}b{{steps.inconnue.text}}c{{steps.lire.text}}", scope({ nom: "x" })))
      .toEqual({ text: "abc", missing: ["row.absente", "steps.inconnue.text", "steps.lire.text"] });
    expect(renderTemplateDetailed("{{row.nom}}", scope(null)).missing).toEqual(["row.nom"]);
  });

  it("does not reach into the prototype of a row or of the outputs", () => {
    expect(renderTemplateDetailed("{{row.constructor}}{{row.toString}}{{row.__proto__}}", scope({ nom: "x" })).text).toBe("");
    expect(renderTemplateDetailed("{{steps.constructor.text}}", scope()).missing).toEqual(["steps.constructor.text"]);
  });

  it("refuses to render a template outside the grammar", () => {
    expect(() => renderTemplate("{{env.X}}", scope())).toThrow(/Gabarit refusé/);
  });

  it("cuts a template once", () => {
    const parsed = parseTemplate("a{{row.x}}b");
    expect(parsed).toEqual({ ok: true, tokens: [{ kind: "text", value: "a" }, { kind: "row", column: "x" }, { kind: "text", value: "b" }] });
  });

  it("dates the run in the timezone of the routine", () => {
    const late = new Date("2026-09-29T22:30:00Z");
    expect(runDate(late, "Europe/Paris")).toBe("2026-09-30");
    expect(runDate(late, "UTC")).toBe("2026-09-29");
    expect(runDate(late, "America/New_York")).toBe("2026-09-29");
    const ctx = { now: late, routine: { id: "r", name: "n", metaAccountId: null, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 }, outputs: { s: { text: "t" } } };
    expect(scopeFromContext(ctx, { a: 1 })).toEqual({ row: { a: 1 }, runDate: "2026-09-30", steps: { s: { text: "t" } } });
  });
});
