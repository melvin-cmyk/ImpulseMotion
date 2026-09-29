import { beforeEach, describe, expect, it, vi } from "vitest";

// The steps of the other lots are replaced by handlers that accept anything:
// what refuses a forged definition below is lib/routines/validate.ts itself.
vi.mock("@/lib/routines/steps/sheet-read", async () => ({ sheetReadHandler: (await import("./routines-engine-fakes")).fakeHandler("sheet.read") }));
vi.mock("@/lib/routines/steps/sheet-write", async () => ({ sheetWriteHandler: (await import("./routines-engine-fakes")).fakeHandler("sheet.write") }));
vi.mock("@/lib/routines/steps/google-insights", async () => ({ googleInsightsHandler: (await import("./routines-engine-fakes")).fakeHandler("google.insights") }));
vi.mock("@/lib/routines/steps/slack-message", async () => ({ slackMessageHandler: (await import("./routines-engine-fakes")).fakeHandler("slack.message") }));
vi.mock("@/lib/routines/steps/email-send", async () => ({ emailSendHandler: (await import("./routines-engine-fakes")).fakeHandler("email.send") }));
vi.mock("@/lib/routines/steps/meta-insights", async () => ({ metaInsightsHandler: (await import("./routines-engine-fakes")).fakeHandler("meta.insights") }));
vi.mock("@/lib/routines/steps/meta-create-ads", async () => ({ metaCreateAdsHandler: (await import("./routines-engine-fakes")).fakeHandler("meta.create_ads") }));
vi.mock("@/lib/routines/steps/ai-summary", async () => ({ aiSummaryHandler: (await import("./routines-engine-fakes")).fakeHandler("ai.summary") }));

import { resolveInputId, stepDependencies, validateDefinition, validateProposal, validateSchedule } from "@/lib/routines/validate";
import type { RoutineStep } from "@/lib/routines/types";
import { SHEET, createAdsStep, readStep, resetSteps, slackStep } from "./routines-engine-fakes";

const def = (...steps: unknown[]) => ({ version: 1, steps });
const errorsOf = (input: unknown): string[] => {
  const v = validateDefinition(input);
  return v.ok ? [] : v.errors;
};
const summary = { id: "resume", type: "ai.summary", instruction: "Résume", onFailure: "continue_without" };
const insights = { id: "stats", type: "meta.insights", level: "campaign", window: "7d", metrics: ["spend"] };

beforeEach(() => resetSteps());

describe("routines — a valid definition", () => {
  it("is accepted and rebuilt", () => {
    const v = validateDefinition(def(
      readStep,
      { id: "garder", type: "rows.filter", where: [{ column: "statut", op: "eq", value: "à créer" }] },
      createAdsStep,
      { ...slackStep, text: "{{run.date}} : créations lancées" },
    ));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.version).toBe(1);
      expect(v.value.steps.map((s) => s.id)).toEqual(["lire", "garder", "creer", "prevenir"]);
    }
  });

  it("lets a message quote the summary and show the rows read before it", () => {
    const v = validateDefinition(def(insights, summary, { ...slackStep, text: "{{steps.resume.text}}", includeTable: true }));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(resolveInputId(v.value.steps, 2)).toBe("stats");
      expect(stepDependencies(v.value.steps, 2).sort()).toEqual(["resume", "stats"]);
      expect(stepDependencies(v.value.steps, 0)).toEqual([]);
    }
  });

  it("accepts a message alone: no rows needed when none is shown", () => {
    expect(errorsOf(def(slackStep))).toEqual([]);
  });

  it("drops `input` on a source, which reads nothing", () => {
    const v = validateDefinition(def(insights, { ...readStep, input: "stats" }));
    expect(v.ok && "input" in v.value.steps[1]).toBe(false);
  });
});

describe("routines — a forged definition is refused", () => {
  it("unknown step type", () => {
    for (const type of ["meta.update_budget", "shell.exec", "constructor", "__proto__", "", null, 3, undefined]) {
      expect(errorsOf(def({ id: "x", type })).join(" "), String(type)).toMatch(/type d'étape inconnu/);
    }
  });

  it("13 steps", () => {
    const steps = [readStep, ...Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, type: "rows.limit", count: 5 }))];
    expect(errorsOf(def(...steps)).join(" ")).toMatch(/Trop d'étapes : 13, pour 12 au plus/);
    expect(errorsOf(def(...steps.slice(0, 12)))).toEqual([]);
  });

  it("two Meta creations", () => {
    expect(errorsOf(def(readStep, createAdsStep, { ...createAdsStep, id: "creer2" })).join(" ")).toMatch(/Une seule étape meta\.create_ads/);
  });

  it("a status slipped into a Meta step, at any depth and in any case", () => {
    const forged = [
      { ...createAdsStep, status: "ACTIVE" },
      { ...createAdsStep, Status: "ACTIVE" },
      { ...createAdsStep, effective_status: "ACTIVE" },
      { ...createAdsStep, mapping: { ...createAdsStep.mapping, status: "ACTIVE" } },
      { ...createAdsStep, mapping: { ...createAdsStep.mapping, adName: { status: "ACTIVE" } } },
      { ...createAdsStep, writeBack: { sheet: SHEET, statusColumn: "Statut", configured_status: "ACTIVE" } },
    ];
    for (const step of forged) {
      const errors = errorsOf(def(readStep, step));
      expect(errors.length, JSON.stringify(step)).toBeGreaterThan(0);
      expect(errors.join(" ")).toMatch(/refusé/);
    }
    // statusColumn is the name of a Sheet column, not a status.
    expect(errorsOf(def(readStep, { ...createAdsStep, writeBack: { sheet: SHEET, statusColumn: "Statut" } }))).toEqual([]);
  });

  it("any field that the step type does not define", () => {
    expect(errorsOf(def(readStep, { ...createAdsStep, budget: 500 })).join(" ")).toMatch(/champ « budget » refusé/);
    expect(errorsOf(def(readStep, { ...createAdsStep, mapping: { ...createAdsStep.mapping, bidAmount: 3 } })).join(" ")).toMatch(/mapping\.bidAmount/);
    expect(errorsOf(def({ ...slackStep, webhook: "https://evil.example" })).join(" ")).toMatch(/champ « webhook » refusé/);
    expect(errorsOf(def({ ...readStep, script: "rm -rf" })).join(" ")).toMatch(/champ « script » refusé/);
    expect(errorsOf(JSON.parse('{"version":1,"steps":[{"id":"a","type":"slack.message","channel":"#c","text":"x","__proto__":{"admin":true}}]}')).join(" ")).toMatch(/__proto__/);
  });

  it("wrong version, wrong shape, unknown top-level field, oversized", () => {
    expect(errorsOf({ version: 2, steps: [slackStep] }).join(" ")).toMatch(/Version/);
    expect(errorsOf({ steps: [slackStep] }).join(" ")).toMatch(/Version/);
    expect(errorsOf({ version: 1, steps: "lire puis écrire" }).join(" ")).toMatch(/liste des étapes/);
    expect(errorsOf({ version: 1, steps: [] }).join(" ")).toMatch(/aucune étape/);
    expect(errorsOf({ version: 1, steps: [slackStep], hooks: [] }).join(" ")).toMatch(/« hooks »/);
    for (const bad of [null, undefined, "x", 3, [], [slackStep]]) expect(errorsOf(bad).length).toBe(1);
    expect(errorsOf(def({ ...slackStep, text: "x".repeat(100_001) })).join(" ")).toMatch(/volumineuse/);
    expect(errorsOf(def(null, "x", [slackStep])).length).toBe(3);
  });

  it("duplicate or malformed step ids", () => {
    expect(errorsOf(def(readStep, { ...slackStep, id: "lire" })).join(" ")).toMatch(/déjà utilisé/);
    for (const id of ["", "a b", "1abc", "é", "a.b", "x".repeat(41), 3, null]) {
      expect(errorsOf(def({ ...slackStep, id })).join(" "), String(id)).toMatch(/identifiant invalide/);
    }
  });
});

describe("routines — chaining", () => {
  it("refuses an input that does not exist, comes later, or produces no rows", () => {
    const limit = { id: "limite", type: "rows.limit", count: 5 };
    expect(errorsOf(def(readStep, { ...limit, input: "absente" })).join(" ")).toMatch(/n'existe pas/);
    expect(errorsOf(def({ ...limit, input: "lire" }, readStep)).join(" ")).toMatch(/placée avant/);
    expect(errorsOf(def({ ...limit, input: "limite" })).join(" ")).toMatch(/placée avant/);
    expect(errorsOf(def(insights, summary, { ...limit, input: "resume" })).join(" ")).toMatch(/ne produit pas de lignes/);
    expect(errorsOf(def(readStep, slackStep, { ...limit, input: "prevenir" })).join(" ")).toMatch(/ne produit pas de lignes/);
    expect(errorsOf(def(readStep, { ...limit, input: { $ref: "lire" } })).join(" ")).toMatch(/« input »/);
  });

  it("refuses a step that consumes rows without a source above it", () => {
    for (const step of [
      { id: "a", type: "rows.limit", count: 5 }, { id: "a", type: "rows.sort", by: "x", dir: "asc" }, summary, createAdsStep,
      { id: "a", type: "sheet.write", sheet: SHEET, mode: "append", columns: [{ column: "Date", value: "{{run.date}}" }] },
      { ...slackStep, includeTable: true }, { ...slackStep, text: "{{row.nom}}" },
      { id: "a", type: "email.send", to: ["a@b.fr"], subject: "Bilan", body: "{{row.nom}}" },
    ]) expect(errorsOf(def(step)).join(" "), step.type).toMatch(/aucune étape en amont ne produit de lignes/);
  });

  it("refuses a quoted text from a step that is absent, later, or without text", () => {
    const quote = (id: string) => ({ ...slackStep, text: `{{steps.${id}.text}}` });
    expect(errorsOf(def(insights, quote("resume"))).join(" ")).toMatch(/n'existe pas/);
    expect(errorsOf(def(insights, quote("resume"), summary)).join(" ")).toMatch(/placée avant/);
    expect(errorsOf(def(insights, quote("stats"))).join(" ")).toMatch(/ne produit pas de texte/);
    expect(errorsOf(def(insights, quote("prevenir"))).join(" ")).toMatch(/placée avant/);
  });

  it("reports an unknown column when the columns are known, and leaves it to the run otherwise", () => {
    const select = { id: "choisir", type: "rows.select", columns: [{ from: "id" }, { from: "nom", as: "Créa" }] };
    const errors = errorsOf(def(readStep, select, { id: "trier", type: "rows.sort", by: "nom", dir: "asc" }));
    expect(errors.join(" ")).toMatch(/colonne « nom » inconnue.*« id », « Créa »/);
    expect(errorsOf(def(readStep, select, { id: "trier", type: "rows.sort", by: "Créa", dir: "asc" }))).toEqual([]);
    // Through a filter and a limit the columns are still those of the select.
    expect(errorsOf(def(readStep, select, { id: "l", type: "rows.limit", count: 3 }, { ...slackStep, text: "{{row.statut}}" })).join(" ")).toMatch(/colonne « statut » inconnue/);
    expect(errorsOf(def(readStep, select, { ...createAdsStep, keyColumn: "id", mapping: { ...createAdsStep.mapping, adName: "{{row.Créa}}", primaryText: "x", linkUrl: "https://a.fr", mediaUrl: "https://a.fr/i.png" } }))).toEqual([]);
    // A Sheet may hold more columns than those required: not decidable here.
    expect(errorsOf(def(readStep, { id: "trier", type: "rows.sort", by: "budget", dir: "asc" }))).toEqual([]);
    expect(errorsOf(def(insights, { id: "trier", type: "rows.sort", by: "spend", dir: "desc" }))).toEqual([]);
  });
});

describe("routines — templates in a definition", () => {
  it("refuses a template outside the grammar, wherever it is", () => {
    const bad = "{{process.env.CRON_SECRET}}";
    const cases: unknown[] = [
      { ...slackStep, text: bad },
      { id: "m", type: "email.send", to: ["a@b.fr"], subject: bad, body: "x" },
      { id: "m", type: "email.send", to: ["a@b.fr"], subject: "x", body: "{{#each rows}}" },
      { id: "w", type: "sheet.write", sheet: SHEET, mode: "append", columns: [{ column: "A", value: "{{row.id}}" }, { column: "B", value: "{{now()}}" }] },
      { ...createAdsStep, mapping: { ...createAdsStep.mapping, headline: "{{row.nom | upper}}" } },
      { ...createAdsStep, mapping: { ...createAdsStep.mapping, mediaUrl: "{{fetch('http://x')}}" } },
      { ...createAdsStep, mapping: { ...createAdsStep.mapping, linkUrl: 42 } },
    ];
    for (const step of cases) {
      const errors = errorsOf(def(readStep, step));
      expect(errors.length, JSON.stringify(step)).toBeGreaterThan(0);
      expect(errors.join(" ")).toMatch(/refusé|gabarit/);
    }
  });
});

describe("routines — schedule", () => {
  const ok = (s: unknown) => validateSchedule(s);
  it("accepts the four kinds and normalises them", () => {
    expect(ok({ kind: "daily", time: "08:15" })).toEqual({ ok: true, value: { kind: "daily", time: "08:15" } });
    expect(ok({ kind: "weekly", time: "09:00", weekdays: [5, 1, 5] })).toEqual({ ok: true, value: { kind: "weekly", time: "09:00", weekdays: [1, 5] } });
    expect(ok({ kind: "monthly", time: "23:45", dayOfMonth: 28 })).toEqual({ ok: true, value: { kind: "monthly", time: "23:45", dayOfMonth: 28 } });
    expect(ok({ kind: "manual", time: "09:00" })).toEqual({ ok: true, value: { kind: "manual" } });
  });

  it("refuses free cron expressions and anything off the 15-minute grid", () => {
    for (const bad of [
      null, "0 9 * * *", { kind: "cron", expression: "* * * * *" }, { kind: "daily", time: "09:00", cron: "* * * * *" },
      { kind: "daily" }, { kind: "daily", time: "9:00" }, { kind: "daily", time: "24:00" }, { kind: "daily", time: "09:10" }, { kind: "daily", time: 900 },
      { kind: "weekly", time: "09:00" }, { kind: "weekly", time: "09:00", weekdays: [] }, { kind: "weekly", time: "09:00", weekdays: [0] },
      { kind: "weekly", time: "09:00", weekdays: [8] }, { kind: "weekly", time: "09:00", weekdays: ["1"] }, { kind: "weekly", time: "09:00", weekdays: [1.5] },
      { kind: "monthly", time: "09:00" }, { kind: "monthly", time: "09:00", dayOfMonth: 29 }, { kind: "monthly", time: "09:00", dayOfMonth: 0 },
      { kind: "daily", time: "09:00", weekdays: [1] }, { kind: "daily", time: "09:00", dayOfMonth: 3 },
    ]) expect(ok(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe("routines — proposal", () => {
  const proposal = {
    name: "  Créas   de la semaine ", description: "Crée les publicités du Sheet.", schedule: { kind: "daily", time: "09:00" },
    definition: def(readStep, createAdsStep), explanation: "Lit puis crée.", assumptions: ["Colonne id unique"],
  };

  it("is accepted with its defaults", () => {
    const v = validateProposal(proposal);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toMatchObject({ name: "Créas de la semaine", maxItemsPerRun: 20, assumptions: ["Colonne id unique"] });
    const bare = validateProposal({ name: "N", schedule: { kind: "manual" }, definition: def(slackStep), maxItemsPerRun: 50 });
    expect(bare.ok && bare.value).toMatchObject({ description: "", explanation: "", assumptions: [], maxItemsPerRun: 50 });
  });

  it("bounds the items per run", () => {
    for (const maxItemsPerRun of [0, -5, 51, 1000, 2.5, "20", NaN]) {
      const v = validateProposal({ ...proposal, maxItemsPerRun });
      expect(v.ok, String(maxItemsPerRun)).toBe(false);
      if (!v.ok) expect(v.errors.join(" ")).toMatch(/entier de 1 à 50/);
    }
  });

  it("refuses a bad name, description, schedule, definition or unknown field, and says all of it at once", () => {
    expect(validateProposal({ ...proposal, name: "" }).ok).toBe(false);
    expect(validateProposal({ ...proposal, name: "x".repeat(121) }).ok).toBe(false);
    expect(validateProposal({ ...proposal, description: "x".repeat(2001) }).ok).toBe(false);
    expect(validateProposal({ ...proposal, assumptions: "aucune" }).ok).toBe(false);
    expect(validateProposal({ ...proposal, status: "active" }).ok).toBe(false);
    expect(validateProposal({ ...proposal, metaAccountId: "act_999" }).ok).toBe(false);
    expect(validateProposal(null).ok).toBe(false);
    const v = validateProposal({ name: "", schedule: { kind: "hourly" }, definition: def({ id: "x", type: "shell" }), maxItemsPerRun: 500 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.length).toBe(4);
  });

  it("carries steps typed as the union", () => {
    const v = validateProposal(proposal);
    const types: RoutineStep["type"][] = v.ok ? v.value.definition.steps.map((s) => s.type) : [];
    expect(types).toEqual(["sheet.read", "meta.create_ads"]);
  });
});
