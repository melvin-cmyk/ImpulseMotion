/**
 * Client alerts — the text of the private message (lib/client-alerts/message.ts).
 * Pure functions: the expected texts are written in full, as the consultant reads them.
 */

import { describe, expect, it } from "vitest";
import { buildAlertLine, buildDmText, escapeSlack, slackToPlain } from "@/lib/client-alerts/message";
import type { AlertDefinition, Evaluation, EvaluationPart } from "@/lib/client-alerts/types";

/** Said with the period for what depends on conversions: why it stops before yesterday. */
const H = " (un jour de recul, le temps que les conversions remontent)";
/** Thousands separator of fr-FR (narrow no-break space). */
const S = " ";

const def = (over: Partial<AlertDefinition> = {}): AlertDefinition => ({
  version: 1, label: "CPA au-dessus de 60 € sur 3 jours",
  accounts: [{ platform: "meta", accountId: "111", name: "LPEV Meta", currency: "EUR" }, { platform: "google", accountId: "222", name: "LPEV Google", currency: "EUR" }],
  metric: "cpa", aggregation: "combined", condition: "above", threshold: 60, windowDays: 3, compare: "previous_window",
  guards: {}, checks: "2x", weekdaysOnly: false, cooldownHours: 72, remind: false, explanation: "", ...over,
});
const part = (scope: EvaluationPart["scope"], value: number | null, over: Partial<EvaluationPart> = {}): EvaluationPart =>
  ({ scope, value, baseline: null, changePct: null, spend: 0, conversions: 0, triggered: false, ...over });
/** The deciding part is the first one given, unless `over` says otherwise. */
const evaluation = (parts: EvaluationPart[], over: Partial<Evaluation> = {}): Evaluation =>
  ({ status: "triggered", asOf: "2026-09-29", value: parts[0]?.value ?? null, baseline: parts[0]?.baseline ?? null, changePct: parts[0]?.changePct ?? null, parts, ...over });
const line = (d: AlertDefinition, e: Evaluation, clientName = "LPEV", kind: "trigger" | "reminder" = "trigger") => buildAlertLine({ clientName, def: d, evaluation: e, kind }).split("\n");

const CPA = evaluation([
  part("combined", 72.4, { spend: 4320, conversions: 60, triggered: true }),
  part("meta", 81.2, { spend: 3004.4, conversions: 37 }),
  part("google", 54.1, { spend: 1315.6, conversions: 23 }),
]);

describe("buildAlertLine — thresholds", () => {
  it("writes a combined CPA above its threshold in three lines", () => {
    expect(buildAlertLine({ clientName: "LPEV", def: def(), evaluation: CPA, kind: "trigger" })).toBe([
      "*LPEV* — CPA au-dessus de 60 € sur 3 jours",
      "CPA : *72,40 €* (seuil 60 €) · Meta 81,20 € · Google 54,10 €",
      `Dépense 4${S}320 € · 60 conversions · du 27 au 29 sept.${H}`,
    ].join("\n"));
  });

  it("prefixes a reminder, and nothing else changes", () => {
    const [title, ...rest] = line(def(), CPA, "LPEV", "reminder");
    expect(title).toBe("Rappel — *LPEV* — CPA au-dessus de 60 € sur 3 jours");
    expect(rest).toEqual(line(def(), CPA).slice(1));
  });

  it("writes a ROAS below its threshold as a ratio", () => {
    const d = def({ label: "ROAS sous 2,5 sur 7 jours", metric: "roas", condition: "below", threshold: 2.5, windowDays: 7 });
    const e = evaluation([part("combined", 1.838, { spend: 12500, conversions: 210, triggered: true }), part("meta", 3.2, { spend: 5000, conversions: 80 }), part("google", 0.93, { spend: 7500, conversions: 130 })]);
    expect(line(d, e)).toEqual([
      "*LPEV* — ROAS sous 2,5 sur 7 jours",
      "ROAS : *×1,84* (seuil ×2,5) · Meta ×3,2 · Google ×0,93",
      `Dépense 12${S}500 € · 210 conversions · du 23 au 29 sept.${H}`,
    ]);
  });

  it("does not repeat the spend or the conversions the alert is about", () => {
    const spend = def({ label: "Dépense au-dessus de 5 000 € sur 7 jours", metric: "spend", threshold: 5000, windowDays: 7 });
    const e = evaluation([part("combined", 6210.5, { spend: 6210.5, conversions: 84, triggered: true }), part("meta", 4000, { spend: 4000, conversions: 50 }), part("google", 2210.5, { spend: 2210.5, conversions: 34 })]);
    expect(line(spend, e).slice(1)).toEqual([
      `Dépense : *6${S}211 €* (seuil 5${S}000 €) · Meta 4${S}000 € · Google 2${S}211 €`,
      "84 conversions · du 23 au 29 sept.",
    ]);
    const conversions = def({ label: "Moins de 20 conversions sur 7 jours", metric: "conversions", condition: "below", threshold: 20, windowDays: 7 });
    const few = evaluation([part("combined", 12.5, { spend: 980, conversions: 12.5, triggered: true }), part("meta", 12.5, { spend: 980, conversions: 12.5 })]);
    expect(line(conversions, few).slice(1)).toEqual(["Conversions : *12,5* (seuil 20)", `Dépense 980 € · du 23 au 29 sept.${H}`]);
    const split = evaluation([part("combined", 12.5, { spend: 980, conversions: 12.5, triggered: true }), part("meta", 11.5, { spend: 700, conversions: 11.5 }), part("google", 1, { spend: 280, conversions: 1 })]);
    expect(line(conversions, split)[1]).toBe("Conversions : *12,5* (seuil 20) · Meta 11,5 conversions · Google 1 conversion");
  });

  it("skips a platform whose value cannot be computed", () => {
    const e = evaluation([part("combined", 72, { spend: 4320, conversions: 60, triggered: true }), part("meta", 72, { spend: 4320, conversions: 60 }), part("google", null, { spend: 0, conversions: 0 })]);
    expect(line(def(), e)[1]).toBe("CPA : *72 €* (seuil 60 €) · Meta 72 €");
    const none = evaluation([part("combined", 72.4, { spend: 4320, conversions: 60, triggered: true }), part("meta", null), part("google", null)]);
    expect(line(def(), none)[1]).toBe("CPA : *72,40 €* (seuil 60 €)");
  });

  it("gives no per-platform detail to a client with a single platform", () => {
    const e = evaluation([part("combined", 72.4, { spend: 4320, conversions: 60, triggered: true }), part("meta", 72.4, { spend: 4320, conversions: 60 })]);
    expect(line(def(), e)[1]).toBe("CPA : *72,40 €* (seuil 60 €)");
  });

  it("says which platform triggered when each is judged on its own", () => {
    const d = def({ label: "CPA au-dessus de 60 € sur une plateforme", aggregation: "each" });
    const e = evaluation([part("meta", 54.1, { spend: 1315.6, conversions: 23 }), part("google", 81.2, { spend: 3004.4, conversions: 37, triggered: true })], { value: 81.2 });
    expect(line(d, e)).toEqual([
      "*LPEV* — CPA au-dessus de 60 € sur une plateforme",
      "CPA sur Google : *81,20 €* (seuil 60 €) · Meta 54,10 €",
      `Google : dépense 3${S}004 € · 37 conversions · du 27 au 29 sept.${H}`,
    ]);
    // Both over the threshold: the first decides, the other is said too.
    const both = evaluation([part("meta", 90, { spend: 900, conversions: 10, triggered: true }), part("google", 81.2, { spend: 3004.4, conversions: 37, triggered: true })]);
    expect(line(d, both)[1]).toBe("CPA sur Meta : *90 €* (seuil 60 €) · Google aussi : 81,20 €");
  });
});

describe("buildAlertLine — variations", () => {
  it("writes a drop against the days before, with each platform's own variation", () => {
    const d = def({ label: "Dépense en baisse de 30 % sur 7 jours", metric: "spend", condition: "drop_pct", threshold: 30, windowDays: 7 });
    const e = evaluation([
      part("combined", 1240, { baseline: 2138, changePct: -42.0019, spend: 1240, conversions: 12, triggered: true }),
      part("meta", 800, { baseline: 1600, changePct: -50, spend: 800, conversions: 8 }),
      part("google", 440, { baseline: 538, changePct: -18.2, spend: 440, conversions: 4 }),
    ]);
    expect(line(d, e)).toEqual([
      "*LPEV* — Dépense en baisse de 30 % sur 7 jours",
      `Dépense : *1${S}240 €* · −42 % par rapport aux 7 jours précédents (2${S}138 €) · Meta 800 € (−50 %) · Google 440 € (−18 %)`,
      "12 conversions · du 23 au 29 sept.",
    ]);
  });

  it("writes a rise against the same days of the week before", () => {
    const d = def({ label: "CPA en hausse de 25 % sur 3 jours", condition: "rise_pct", threshold: 25, compare: "same_weekdays" });
    const e = evaluation([part("combined", 72.4, { baseline: 51.3, changePct: 41.13, spend: 4320, conversions: 60, triggered: true }), part("meta", 81.2, { baseline: 50 }), part("google", 54.1, { baseline: 54.1 })]);
    expect(line(d, e)[1]).toBe("CPA : *72,40 €* · +41 % par rapport aux mêmes jours de la semaine précédente (51,30 €) · Meta 81,20 € (+62 %) · Google 54,10 € (stable)");
  });

  it("speaks of one day when the window is one day", () => {
    const e = evaluation([part("combined", 1.854, { baseline: 1.2, changePct: 54.5, spend: 300, conversions: 1, triggered: true })]);
    const day = def({ label: "CTR en hausse", metric: "ctr", condition: "rise_pct", threshold: 20, windowDays: 1 });
    expect(line(day, e).slice(1)).toEqual(["CTR : *1,85 %* · +55 % par rapport au jour précédent (1,20 %)", "Dépense 300 € · 1 conversion · le 29 sept."]);
    expect(line({ ...day, compare: "same_weekdays" }, e)[1]).toContain("par rapport au même jour de la semaine précédente");
    // A window longer than a week is compared further back than « the week before ».
    expect(line({ ...day, windowDays: 14, compare: "same_weekdays" }, e)[1]).toContain("par rapport aux mêmes jours de la semaine, 2 semaines plus tôt");
    expect(line({ ...day, windowDays: 30, compare: "same_weekdays" }, e)[1]).toContain("par rapport aux mêmes jours de la semaine, 5 semaines plus tôt");
  });

  it("reads the variation from the evaluation when there is no baseline to compute it from", () => {
    const d = def({ label: "Revenu en baisse", metric: "revenue", condition: "drop_pct", threshold: 20, windowDays: 14 });
    const e = evaluation([part("combined", 8400, { changePct: -33.4, spend: 3000, conversions: 70, triggered: true })]);
    expect(line(d, e)[1]).toBe(`Revenu : *8${S}400 €* · −33 % par rapport aux 14 jours précédents`);
  });
});

describe("buildAlertLine — stops", () => {
  it("writes a spend at a stop, in two lines", () => {
    const d = def({ label: "Dépense à l'arrêt", metric: "spend", condition: "stopped", threshold: null });
    const e = evaluation([part("combined", 0, { baseline: 2870, triggered: true }), part("meta", 0), part("google", 0)]);
    expect(line(d, e)).toEqual(["*LPEV* — Dépense à l'arrêt", `*Dépense à l'arrêt* depuis le 27 sept. (3 jours) · 2${S}870 € sur les 7 jours précédents`]);
    expect(line({ ...d, windowDays: 1 }, e)[1]).toBe(`*Dépense à l'arrêt* depuis le 29 sept. · 2${S}870 € sur les 7 jours précédents`);
  });

  it("writes conversions at a stop while the spend goes on", () => {
    const d = def({ label: "Plus de conversions sur 3 jours", metric: "conversions", condition: "stopped", threshold: null });
    const e = evaluation([part("combined", 0, { baseline: 42, spend: 1450, triggered: true }), part("meta", 0, { spend: 1000 }), part("google", 0, { spend: 450 })], { asOf: "2026-10-02" });
    expect(line(d, e)).toEqual([
      "*LPEV* — Plus de conversions sur 3 jours",
      "*Plus aucune conversion* depuis le 30 sept. (3 jours) alors que la dépense continue · 42 conversions sur les 7 jours précédents",
      `Dépense 1${S}450 € · du 30 sept. au 2 oct.${H}`,
    ]);
  });

  it("names the platform that stopped when each is judged on its own", () => {
    const d = def({ label: "Dépense à l'arrêt sur une plateforme", metric: "spend", condition: "stopped", threshold: null, aggregation: "each" });
    const e = evaluation([part("meta", 1230, { spend: 1230, conversions: 11 }), part("google", 0, { baseline: 900, triggered: true })], { value: 0, baseline: 900 });
    expect(line(d, e)).toEqual(["*LPEV* — Dépense à l'arrêt sur une plateforme", `*Dépense Google à l'arrêt* depuis le 27 sept. (3 jours) · 900 € sur les 7 jours précédents · Meta 1${S}230 €`]);
    const conv = evaluation([part("meta", 0, { baseline: 18, spend: 640, triggered: true }), part("google", 9, { spend: 300, conversions: 9 })]);
    expect(line({ ...d, metric: "conversions" }, conv).slice(1)).toEqual([
      "*Plus aucune conversion sur Meta* depuis le 27 sept. (3 jours) alors que la dépense continue · 18 conversions sur les 7 jours précédents · Google 9 conversions",
      `Meta : dépense 640 € · du 27 au 29 sept.${H}`,
    ]);
  });
});

describe("buildAlertLine — figures, dates and names", () => {
  const cpa = (value: number, threshold: number, spend = 500, conversions = 5) =>
    line(def({ threshold }), evaluation([part("combined", value, { spend, conversions, triggered: true })]));

  it("writes euros with cents only where they matter", () => {
    expect(cpa(72.4, 60)[1]).toBe("CPA : *72,40 €* (seuil 60 €)");
    expect(cpa(60.004, 59.5)[1]).toBe("CPA : *60 €* (seuil 59,50 €)");
    expect(cpa(1234.56, 999.99)[1]).toBe(`CPA : *1${S}235 €* (seuil 999,99 €)`);
    expect(cpa(0.456, 0.3)[1]).toBe("CPA : *0,46 €* (seuil 0,30 €)");
    expect(cpa(72.4, 60, 1234567.8, 1)[2]).toBe(`Dépense 1${S}234${S}568 € · 1 conversion · du 27 au 29 sept.${H}`);
  });

  it("writes counts, ratios and rates the French way", () => {
    expect(cpa(72.4, 60, 500, 0)[2]).toContain("· 0 conversion ·");
    expect(cpa(72.4, 60, 500, 1.5)[2]).toContain("· 1,5 conversion ·");
    expect(cpa(72.4, 60, 500, 2)[2]).toContain("· 2 conversions ·");
    expect(cpa(72.4, 60, 500, 1234.46)[2]).toContain(`· 1${S}234,5 conversions ·`);
    const roas = def({ metric: "roas", condition: "below", threshold: 3 });
    expect(line(roas, evaluation([part("combined", 2.456, { triggered: true })]))[1]).toBe("ROAS : *×2,46* (seuil ×3)");
    const ctr = def({ metric: "ctr", condition: "below", threshold: 1 });
    expect(line(ctr, evaluation([part("combined", 0.8, { triggered: true })]))[1]).toBe("CTR : *0,80 %* (seuil 1,00 %)");
  });

  it("reads naturally when a CPA alert triggers on the spend alone: there is no CPA to write", () => {
    // Nothing converted: the spend says it all, once.
    expect(line(def(), evaluation([part("combined", null, { spend: 900, conversions: 0, triggered: true })]))).toEqual([
      "*LPEV* — CPA au-dessus de 60 € sur 3 jours",
      "*Aucune conversion pour 900 € dépensés* (seuil : CPA de 60 €)",
      `Du 27 au 29 sept.${H}`,
    ]);
    // Both platforms spent: each one's share follows.
    const both = evaluation([
      part("combined", null, { spend: 900, conversions: 0, triggered: true }),
      part("meta", null, { spend: 600.5, conversions: 0 }),
      part("google", null, { spend: 299.5, conversions: 0 }),
    ]);
    expect(line(def(), both)[1]).toBe("*Aucune conversion pour 900 € dépensés* (seuil : CPA de 60 €) · Meta 600,50 € · Google 299,50 €");
    expect(line(def(), both).join("\n")).not.toMatch(/non calculable|null|NaN|—\s*€/);
  });

  it("names the platform that spent without converting, under a combined CPA and when each is judged on its own", () => {
    // Too few conversions for the guard, but a CPA exists: it is written, and the platform without any is named.
    const few = evaluation([
      part("combined", 450, { spend: 900, conversions: 2, triggered: true }),
      part("meta", 300, { spend: 600, conversions: 2 }),
      part("google", null, { spend: 300, conversions: 0 }),
    ]);
    expect(line(def(), few).slice(1)).toEqual([
      "CPA : *450 €* (seuil 60 €) · Meta 300 € · Google : aucune conversion pour 300 €",
      `Dépense 900 € · 2 conversions · du 27 au 29 sept.${H}`,
    ]);
    const each = evaluation([part("meta", null, { spend: 600, conversions: 0, triggered: true }), part("google", 30, { spend: 90, conversions: 3 })]);
    expect(line(def({ aggregation: "each" }), each).slice(1)).toEqual([
      "*Aucune conversion sur Meta pour 600 € dépensés* (seuil : CPA de 60 €) · Google 30 €",
      `Du 27 au 29 sept.${H}`,
    ]);
  });

  it("still says « non calculable » for another measure without a value", () => {
    const roas = def({ label: "ROAS sous 2", metric: "roas", condition: "below", threshold: 2 });
    expect(line(roas, evaluation([part("combined", null, { spend: 800, conversions: 4, triggered: true })]))[1]).toBe("ROAS : *non calculable* (seuil ×2)");
  });

  it("writes the period in short French dates", () => {
    const at = (asOf: string, windowDays: AlertDefinition["windowDays"]) => line(def({ windowDays, metric: "spend" }), evaluation([part("combined", 72.4, { triggered: true })], { asOf })).at(-1)!.split(" · ").at(-1);
    expect(at("2026-09-29", 1)).toBe("le 29 sept.");
    expect(at("2026-09-29", 3)).toBe("du 27 au 29 sept.");
    expect(at("2026-09-03", 3)).toBe("du 1er au 3 sept.");
    expect(at("2026-10-02", 7)).toBe("du 26 sept. au 2 oct.");
    expect(at("2026-08-01", 1)).toBe("le 1er août");
    expect(at("2027-01-05", 14)).toBe("du 23 déc. au 5 janv.");
    expect(at("2026-03-01", 30)).toBe("du 31 janv. au 1er mars");
    expect(at("pas une date", 7)).toBe("sur 7 jours");
  });

  it("writes the window that was really judged: one day of hindsight for the conversions, working days only", () => {
    // Checked on Tuesday 29: a CPA over 3 days is judged on the 26th to the 28th, and the message says why it stops there.
    const cpa = evaluation([part("combined", 72.4, { spend: 4320, conversions: 60, triggered: true })], { from: "2026-09-26", asOf: "2026-09-28" });
    expect(line(def(), cpa)[2]).toBe(`Dépense 4${S}320 € · 60 conversions · du 26 au 28 sept. (un jour de recul, le temps que les conversions remontent)`);
    // The spend is judged up to yesterday: nothing to explain.
    const spend = def({ label: "Dépense haute", metric: "spend", threshold: 1000 });
    expect(line(spend, evaluation([part("combined", 1500, { spend: 1500, conversions: 9, triggered: true })], { from: "2026-09-27", asOf: "2026-09-29" }))[2]).toBe("9 conversions · du 27 au 29 sept.");
    // Working days only: three working days checked on Monday 28 run from Wednesday to Friday — not Friday to Sunday.
    const worked = { ...spend, weekdaysOnly: true };
    const monday = evaluation([part("combined", 1500, { spend: 1500, conversions: 9, baseline: 3000, changePct: -50, triggered: true })], { from: "2026-09-23", asOf: "2026-09-25" });
    expect(line(worked, monday)[2]).toBe("9 conversions · du 23 au 25 sept.");
    expect(line({ ...worked, condition: "drop_pct", threshold: 40 }, monday)[1]).toBe(`Dépense : *1${S}500 €* · −50 % par rapport aux 3 jours ouvrés précédents (3${S}000 €)`);
    expect(line({ ...worked, condition: "drop_pct", threshold: 40, windowDays: 1 }, monday)[1]).toContain("par rapport au jour ouvré précédent");
    // A stop over three working days that span a week-end: since Thursday, « 3 jours ouvrés ».
    const stop = evaluation([part("combined", 0, { baseline: 2870, triggered: true })], { from: "2026-09-24", asOf: "2026-09-28" });
    expect(line({ ...worked, condition: "stopped", threshold: null }, stop)[1]).toBe(`*Dépense à l'arrêt* depuis le 24 sept. (3 jours ouvrés) · 2${S}870 € sur les 7 jours ouvrés précédents`);
    // An evaluation stored before `from` existed is still read: n days in a row.
    expect(line(spend, evaluation([part("combined", 1500, { conversions: 9, triggered: true })], { asOf: "2026-09-29" }))[2]).toBe("9 conversions · du 27 au 29 sept.");
  });

  it("escapes what Slack would read as a link or a mention, in the client and in the label", () => {
    expect(escapeSlack("Saveurs & Vie <!channel>")).toBe("Saveurs &amp; Vie &lt;!channel&gt;");
    const [title] = line(def({ label: "CPA > 60 € & ROAS < 2\n<https://x.test|clic>" }), CPA, "Saveurs & Vie *<@U123>*");
    expect(title).toBe("*Saveurs &amp; Vie &lt;@U123&gt;* — CPA &gt; 60 € &amp; ROAS &lt; 2 &lt;https://x.test|clic&gt;");
    expect(title).not.toMatch(/[<>]/);
  });

  it("falls back on the metric when the label is empty, and never writes an emoji", () => {
    const text = buildAlertLine({ clientName: " ", def: def({ label: "  " }), evaluation: CPA, kind: "trigger" });
    expect(text.split("\n")[0]).toBe("*Client* — CPA");
    expect(text).not.toMatch(/:[a-z_]+:|\p{Extended_Pictographic}/u);
  });

  it("still writes something readable from an evaluation without parts", () => {
    expect(line(def(), evaluation([], { value: 72.4 }))).toEqual(["*LPEV* — CPA au-dessus de 60 € sur 3 jours", "CPA : *72,40 €* (seuil 60 €)", `Du 27 au 29 sept.${H}`]);
  });
});

describe("buildDmText", () => {
  const one = buildAlertLine({ clientName: "LPEV", def: def(), evaluation: CPA, kind: "trigger" });
  const two = buildAlertLine({ clientName: "Dufour", def: def(), evaluation: CPA, kind: "reminder" });
  const URL = "https://app.test/admin/alerts/assistant";
  const LINK = `<${URL}|Voir et régler mes alertes>`;

  it("sends a single alert as it is, its link right under it", () => {
    expect(buildDmText([one], 0, null)).toBe(one);
    expect(buildDmText([one], 0, URL)).toBe(`${one}\n${LINK}`);
    expect(buildDmText([one], 0, URL).split("\n")).toHaveLength(4);
  });

  it("separates several alerts with a blank line, then the link", () => {
    expect(buildDmText([one, two], 0, null)).toBe(`${one}\n\n${two}`);
    expect(buildDmText([one, two], 0, URL)).toBe(`${one}\n\n${two}\n\n${LINK}`);
    expect(buildDmText([one, "  ", two, ""], 0, null)).toBe(`${one}\n\n${two}`);
  });

  it("says how many alerts were left out when capped", () => {
    expect(buildDmText([one, two], 1, URL)).toBe(`${one}\n\n${two}\n\n+ 1 autre alerte déclenchée, à voir dans l'application\n${LINK}`);
    expect(buildDmText([one], 3, null)).toBe(`${one}\n\n+ 3 autres alertes déclenchées, à voir dans l'application`);
    expect(buildDmText([one], -2, null)).toBe(one);
    expect(buildDmText([], 4, URL)).toBe(`4 alertes déclenchées, à voir dans l'application\n${LINK}`);
  });

  it("leaves out an address that would break the link", () => {
    for (const bad of ["", "  ", "javascript:alert(1)", "https://app.test/a b", "https://app.test/a|b", "https://app.test/a>b", "/admin/alerts"]) {
      expect(buildDmText([one], 0, bad), bad).toBe(one);
    }
  });

  it("stays short: five alerts and their closing lines fit well under the cap of a private message", () => {
    const text = buildDmText(Array.from({ length: 5 }, () => two), 7, URL);
    expect(text.length).toBeLessThan(1500);
    expect(text.split("\n\n")).toHaveLength(6);
  });
});

describe("slackToPlain — a stored message as the page shows it", () => {
  it("removes the bold markers, decodes the entities and keeps the lines", () => {
    const stored = buildAlertLine({ clientName: "Saveurs & Vie <Paris>", def: def(), evaluation: CPA, kind: "reminder" });
    expect(stored).toContain("*Saveurs &amp; Vie &lt;Paris&gt;*");
    expect(slackToPlain(stored)).toBe([
      "Rappel — Saveurs & Vie <Paris> — CPA au-dessus de 60 € sur 3 jours",
      "CPA : 72,40 € (seuil 60 €) · Meta 81,20 € · Google 54,10 €",
      `Dépense 4${S}320 € · 60 conversions · du 27 au 29 sept.${H}`,
    ].join("\n"));
  });

  it("drops the link line of a whole private message, and keeps the words of a link inside a line", () => {
    const one = buildAlertLine({ clientName: "LPEV", def: def(), evaluation: CPA, kind: "trigger" });
    const dm = buildDmText([one], 0, "https://app.test/admin/alerts/assistant");
    expect(dm).toContain("<https://app.test/admin/alerts/assistant|Voir et régler mes alertes>");
    expect(slackToPlain(dm)).toBe(slackToPlain(one));
    expect(slackToPlain("Voir <https://x.test/a|la page> du client")).toBe("Voir la page du client");
  });

  it("leaves alone what is not Slack's: a lone star, an ampersand, an empty text", () => {
    expect(slackToPlain("Note 4* & co")).toBe("Note 4* & co");
    expect(slackToPlain("ROAS : *×1,84* (seuil ×2,5)")).toBe("ROAS : ×1,84 (seuil ×2,5)");
    expect(slackToPlain("")).toBe("");
    // A name that held an entity as text is read back as it was typed.
    expect(slackToPlain(escapeSlack("R&amp;D"))).toBe("R&amp;D");
  });
});
