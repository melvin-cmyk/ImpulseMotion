import { describe, expect, it } from "vitest";

import { CPA_MIN_CONVERSIONS, accountKey, validateAlertProposal } from "@/lib/client-alerts/validate";
import type { AccountSeries, AlertAccountRef, AlertDefinition, ClientSeries, SeriesPoint } from "@/lib/client-alerts/types";

const META: AlertAccountRef = { platform: "meta", accountId: "1234567890", name: "LPEV Meta", currency: "EUR" };
const META_2: AlertAccountRef = { platform: "meta", accountId: "555000111", name: "LPEV Traffic", currency: "EUR" };
const GOOGLE: AlertAccountRef = { platform: "google", accountId: "9876543210", name: "LPEV Search", currency: "EUR" };
const CLIENT = [META, META_2, GOOGLE];

const base = { label: "CPA au-dessus de 60 €", metric: "cpa", condition: "above", threshold: 60, windowDays: 3 };
const ctx = (over: { accounts?: AlertAccountRef[]; series?: ClientSeries | null } = {}) => ({ accounts: CLIENT, ...over });

function ok(input: unknown, context = ctx()): { value: AlertDefinition; warnings: string[] } {
  const result = validateAlertProposal(input, context);
  if (!result.ok) throw new Error(`refusée : ${result.errors.join(" | ")}`);
  return result;
}
function refused(input: unknown, context = ctx()): string[] {
  const result = validateAlertProposal(input, context);
  if (result.ok) throw new Error("acceptée alors qu'elle devait être refusée");
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}
/** What goes to the AI alone with its next message: the fields and the values to write. */
function hints(input: unknown, context = ctx()): string[] {
  const result = validateAlertProposal(input, context);
  if (result.ok) throw new Error("acceptée alors qu'elle devait être refusée");
  return result.hints;
}
/** Words of the block: a consultant never reads them. */
const JARGON = /\b(label|metric|condition|threshold|windowDays|aggregation|compare|accounts|accountId|guards|minSpend|minConversions|checks|weekdaysOnly|cooldownHours|remind|each|combined|cpa|roas|ctr|spend|revenue|stopped|drop_pct|rise_pct|previous_window|same_weekdays|null|true|false|undefined|NaN)\b|[{}\[\]"]/;

const day = (revenue: number | null): SeriesPoint => ({ date: "2026-09-01", spend: 100, conversions: 4, revenue, clicks: 50, impressions: 4000 });
const read = (account: AlertAccountRef, revenue: number | null, currency = "EUR"): AccountSeries =>
  ({ account, currency, eurRate: currency === "EUR" ? 1 : 0.9, days: [day(revenue), day(revenue)], today: null });
/** Read, but nothing spent: a dormant account. */
const dormant = (account: AlertAccountRef): AccountSeries =>
  ({ account, currency: "EUR", eurRate: 1, days: [{ ...day(null), spend: 0, conversions: 0 }, { ...day(null), spend: 0, conversions: 0 }], today: null });
const unread = (account: AlertAccountRef): AccountSeries => ({ account, currency: "EUR", eurRate: 1, days: [], today: null, error: "rate limit" });
const series = (...accounts: AccountSeries[]): ClientSeries => ({ readAt: "2026-09-30T06:00:00.000Z", until: "2026-09-29", accounts });

describe("alertes client — validation : valeurs par défaut", () => {
  it("complète ce que l'IA n'écrit pas avec les choix du dirigeant", () => {
    const { value } = ok(base);
    expect(value).toEqual({
      version: 1,
      label: "CPA au-dessus de 60 €",
      accounts: CLIENT,
      metric: "cpa", aggregation: "combined", condition: "above", threshold: 60, windowDays: 3,
      compare: "previous_window",
      guards: { minConversions: 5 },
      checks: "2x", weekdaysOnly: false, cooldownHours: 72, remind: false,
      explanation: "",
    });
  });

  it("garde ce que le consultant a demandé de changer", () => {
    const { value } = ok({ ...base, aggregation: "each", compare: "same_weekdays", checks: "4x", weekdaysOnly: true, cooldownHours: 24, remind: true, guards: { minSpend: 200, minConversions: 10 } });
    expect(value).toMatchObject({ aggregation: "each", compare: "same_weekdays", checks: "4x", weekdaysOnly: true, cooldownHours: 24, remind: true, guards: { minSpend: 200, minConversions: 10 } });
  });

  it("force la version à 1 et ignore les champs inconnus", () => {
    const { value } = ok({ ...base, version: 7, recipient: "#general", status: "active", createdById: "quelqu'un" });
    expect(value.version).toBe(1);
    expect(Object.keys(value).sort()).toEqual([
      "accounts", "aggregation", "checks", "compare", "condition", "cooldownHours", "explanation", "guards", "label",
      "metric", "remind", "threshold", "version", "weekdaysOnly", "windowDays",
    ]);
  });

  it("nettoie le titre et coupe l'explication à 600 caractères", () => {
    const { value } = ok({ ...base, label: "  CPA   trop\nhaut ", explanation: `  ${"x".repeat(700)}  ` });
    expect(value.label).toBe("CPA trop haut");
    expect(value.explanation).toHaveLength(600);
  });
});

describe("alertes client — validation : comptes", () => {
  it("couvre tous les comptes du client quand aucun n'est cité", () => {
    expect(ok(base).value.accounts).toEqual(CLIENT);
    expect(ok({ ...base, accounts: [] }).value.accounts).toEqual(CLIENT);
    expect(ok({ ...base, accounts: null }).value.accounts).toEqual(CLIENT);
  });

  it("prend le nom et la devise dans la liste du client, jamais dans ce qu'écrit l'IA", () => {
    const { value } = ok({ ...base, accounts: [{ platform: "google", accountId: "9876543210", name: "Compte pirate", currency: "USD" }] });
    expect(value.accounts).toEqual([GOOGLE]);
  });

  it("reconnaît un compte Meta avec ou sans act_, et un identifiant entouré d'espaces ou de tirets", () => {
    expect(ok({ ...base, accounts: [{ platform: "meta", accountId: "act_1234567890" }] }).value.accounts).toEqual([META]);
    expect(ok({ ...base, accounts: [{ platform: "meta", accountId: "  1234567890 " }] }).value.accounts).toEqual([META]);
    expect(ok({ ...base, accounts: [{ platform: "google", accountId: " 987-654-3210 " }] }).value.accounts).toEqual([GOOGLE]);
    // The client's own list may carry the act_ form: the comparison works both ways.
    const stored = [{ ...META, accountId: "act_1234567890" }];
    expect(ok({ ...base, accounts: [{ platform: "meta", accountId: "1234567890" }] }, ctx({ accounts: stored })).value.accounts).toEqual(stored);
    expect(accountKey("meta", "act_12")).toBe(accountKey("meta", " 12 "));
  });

  it("retire les doublons et garde l'ordre de la liste du client", () => {
    const { value } = ok({ ...base, accounts: [
      { platform: "google", accountId: "9876543210" }, { platform: "meta", accountId: "act_1234567890" }, { platform: "meta", accountId: "1234567890" },
    ] });
    expect(value.accounts).toEqual([META, GOOGLE]);
  });

  it("refuse un compte qui n'est pas au client, en le nommant", () => {
    const errors = refused({ ...base, accounts: [{ platform: "meta", accountId: "1234567890" }, { platform: "meta", accountId: "act_999000111" }] });
    expect(errors).toEqual(["Le compte Meta act_999000111 ne fait pas partie des comptes de ce client."]);
  });

  it("ne confond pas un identifiant Meta et le même identifiant chez Google", () => {
    const errors = refused({ ...base, accounts: [{ platform: "google", accountId: "1234567890" }] });
    expect(errors[0]).toContain("Le compte Google Ads 1234567890 ne fait pas partie");
  });

  it("refuse une plateforme inconnue, un compte sans identifiant, une liste illisible", () => {
    expect(refused({ ...base, accounts: [{ platform: "snapchat", accountId: "1" }] })[0]).toContain("Plateforme inconnue");
    expect(refused({ ...base, accounts: [{ platform: "meta" }] })[0]).toContain("n'a pas d'identifiant");
    expect(refused({ ...base, accounts: ["1234567890"] })[0]).toContain("n'a pas d'identifiant");
    expect(refused({ ...base, accounts: "tous" })[0]).toContain("liste des comptes");
  });

  it("accepte un compte TikTok Ads du client, et refuse celui d'un autre client", () => {
    const TIKTOK: AlertAccountRef = { platform: "tiktok", accountId: "7412345678901234567", name: "LPEV TikTok", currency: "EUR" };
    const { value } = ok({ ...base, accounts: [{ platform: "tiktok", accountId: " 7412345678901234567 " }] }, ctx({ accounts: [...CLIENT, TIKTOK] }));
    expect(value.accounts).toEqual([TIKTOK]);
    expect(ok(base, ctx({ accounts: [...CLIENT, TIKTOK] })).value.accounts).toEqual([...CLIENT, TIKTOK]);
    expect(refused({ ...base, accounts: [{ platform: "tiktok", accountId: "7400000000000000000" }] }, ctx({ accounts: [...CLIENT, TIKTOK] })))
      .toEqual(["Le compte TikTok Ads 7400000000000000000 ne fait pas partie des comptes de ce client."]);
  });

  it("refuse un revenu jugé par plateforme quand TikTok ne remonte aucune valeur", () => {
    const TIKTOK: AlertAccountRef = { platform: "tiktok", accountId: "7412345678901234567", name: "LPEV TikTok", currency: "EUR" };
    const errors = refused(
      { ...base, metric: "revenue", condition: "below", threshold: 100, aggregation: "each", accounts: [{ platform: "meta", accountId: "1234567890" }, { platform: "tiktok", accountId: "7412345678901234567" }] },
      ctx({ accounts: [...CLIENT, TIKTOK], series: series(read(META, 400), read(TIKTOK, null)) }),
    );
    expect(errors[0]).toContain("TikTok Ads ne remonte aucune valeur de conversion");
  });

  it("refuse une alerte pour un client sans compte", () => {
    expect(refused(base, ctx({ accounts: [] }))).toEqual(["Ce client n'a aucun compte publicitaire à surveiller."]);
  });
});

describe("alertes client — validation : la règle", () => {
  it("refuse ce qui n'est pas une alerte", () => {
    for (const bad of [null, undefined, "cpa > 60", 12, [base]]) expect(refused(bad)[0]).toContain("illisible");
  });

  it("exige un titre, de 120 caractères au plus", () => {
    expect(refused({ ...base, label: undefined })[0]).toContain("titre");
    expect(refused({ ...base, label: "   " })[0]).toContain("titre");
    expect(refused({ ...base, label: 12 })[0]).toContain("titre");
    expect(refused({ ...base, label: "x".repeat(121) })[0]).toContain("trop long");
    expect(ok({ ...base, label: "x".repeat(120) }).value.label).toHaveLength(120);
  });

  it("refuse une mesure, une condition ou une période hors liste", () => {
    expect(refused({ ...base, metric: "cpm" })[0]).toContain("Mesure inconnue");
    expect(refused({ ...base, metric: undefined })[0]).toContain("Mesure inconnue");
    expect(refused({ ...base, condition: "equals" })[0]).toContain("Condition inconnue");
    expect(refused({ ...base, windowDays: 2 })[0]).toContain("Période inconnue");
    expect(refused({ ...base, windowDays: "3" })[0]).toContain("Période inconnue");
    for (const windowDays of [1, 3, 7, 14, 30]) expect(ok({ ...base, windowDays }).value.windowDays).toBe(windowDays);
  });

  it("refuse un regroupement, une comparaison ou un rythme hors liste", () => {
    expect(refused({ ...base, aggregation: "sum" })[0]).toContain("Regroupement inconnu");
    expect(refused({ ...base, compare: "last_year" })[0]).toContain("Comparaison inconnue");
    expect(refused({ ...base, checks: "8x" })[0]).toContain("Nombre de vérifications inconnu");
    expect(refused({ ...base, checks: 2 })[0]).toContain("Nombre de vérifications inconnu");
  });

  it("exige un seuil fini et supérieur à 0 hors « stopped »", () => {
    for (const threshold of [undefined, null, 0, -5, "60", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refused({ ...base, threshold })[0], String(threshold)).toContain("Il manque le seuil");
    }
    expect(ok({ ...base, threshold: 0.5 }).value.threshold).toBe(0.5);
  });

  it("borne les pourcentages de baisse et de hausse entre 1 et 1000", () => {
    const drop = { label: "Dépense en chute", metric: "spend", condition: "drop_pct", windowDays: 7 };
    expect(refused({ ...drop, threshold: 0.5 })[0]).toContain("entre 1 et 1000");
    expect(refused({ ...drop, condition: "rise_pct", threshold: 1001 })[0]).toContain("entre 1 et 1000");
    expect(ok({ ...drop, threshold: 1 }).value.threshold).toBe(1);
    expect(ok({ ...drop, condition: "rise_pct", threshold: 1000 }).value.threshold).toBe(1000);
  });

  it("prévient qu'une baisse de plus de 100 % ne se produit jamais", () => {
    const { warnings } = ok({ label: "x", metric: "spend", condition: "drop_pct", windowDays: 7, threshold: 150 });
    expect(warnings.join(" ")).toContain("ne se déclencherait jamais");
    expect(ok({ label: "x", metric: "spend", condition: "drop_pct", windowDays: 7, threshold: 100 }).warnings).toEqual([]);
  });

  it("lit un seuil de taux de clic comme un pourcentage", () => {
    const ctr = { label: "CTR trop bas", metric: "ctr", condition: "below", windowDays: 7 };
    expect(ok({ ...ctr, threshold: 1.2 }).value.threshold).toBe(1.2);
    expect(ok({ ...ctr, threshold: 100 }).value.threshold).toBe(100);
    expect(refused({ ...ctr, threshold: 120 })[0]).toContain("entre 0 et 100");
    // A rise of the CTR by 150 % is a percentage of change, not a CTR.
    expect(ok({ ...ctr, condition: "rise_pct", threshold: 150 }).value.threshold).toBe(150);
  });

  it("n'accepte « stopped » que sur la dépense ou les conversions, sans seuil", () => {
    const stopped = { label: "Plus de dépense", condition: "stopped", windowDays: 1 };
    expect(ok({ ...stopped, metric: "spend" }).value.threshold).toBeNull();
    expect(ok({ ...stopped, metric: "conversions" }).value.threshold).toBeNull();
    // A threshold written next to « stopped » is ignored, not refused.
    expect(ok({ ...stopped, metric: "spend", threshold: 40 }).value.threshold).toBeNull();
    for (const metric of ["cpa", "roas", "revenue", "ctr"]) {
      expect(refused({ ...stopped, metric })[0], metric).toContain("ne se vérifie que sur la dépense ou les conversions");
    }
  });

  it("borne le silence entre 12 heures et 14 jours, en heures entières", () => {
    for (const cooldownHours of [11, 337, 24.5, "72", -1]) {
      expect(refused({ ...base, cooldownHours })[0], String(cooldownHours)).toContain("entre 12 et 336");
    }
    expect(ok({ ...base, cooldownHours: 12 }).value.cooldownHours).toBe(12);
    expect(ok({ ...base, cooldownHours: 336 }).value.cooldownHours).toBe(336);
  });

  it("n'accepte que oui ou non pour les jours ouvrés et le rappel", () => {
    expect(refused({ ...base, weekdaysOnly: "oui" })[0]).toBe("« Jours ouvrés seulement » se règle par oui ou non.");
    expect(refused({ ...base, remind: 1 })[0]).toContain("Le rappel tant que la situation dure");
  });

  it("refuse des volumes minimum négatifs ou illisibles", () => {
    expect(refused({ ...base, guards: { minSpend: -1 } })[0]).toContain("dépense minimum");
    expect(refused({ ...base, guards: { minConversions: "5" } })[0]).toContain("conversions minimum");
    expect(refused({ ...base, guards: [5] })[0]).toContain("volumes minimum");
    expect(ok({ ...base, guards: { minSpend: 0, minConversions: 0 } }).value.guards).toEqual({ minSpend: 0, minConversions: 0 });
  });

  it("dit toutes les raisons d'un refus en une fois", () => {
    const errors = refused({ metric: "cpm", condition: "above", windowDays: 2, accounts: [{ platform: "meta", accountId: "42" }] });
    expect(errors).toHaveLength(5);
    // Read by a consultant: French sentences, no raw English message.
    for (const e of errors) expect(e).toMatch(/^[A-ZÀ-Ý«]/);
    // No field name of the contract on screen.
    expect(errors.join(" ")).not.toMatch(/\b(label|metric|windowDays|threshold|accounts|accountId)\b/);
  });
});

describe("alertes client — validation : comparaison avec les mêmes jours de la semaine", () => {
  const drop = { label: "Dépense en baisse", metric: "spend", condition: "drop_pct", threshold: 40, compare: "same_weekdays" };

  it("l'accepte jusqu'à 7 jours, la refuse au-delà en disant quoi demander", () => {
    for (const windowDays of [1, 3, 7]) expect(ok({ ...drop, windowDays }).value.compare, String(windowDays)).toBe("same_weekdays");
    for (const windowDays of [14, 30]) {
      const result = validateAlertProposal({ ...drop, windowDays }, ctx());
      expect(result.ok, String(windowDays)).toBe(false);
      if (result.ok) continue;
      expect(result.errors).toEqual([`La comparaison avec les mêmes jours de la semaine précédente ne vaut que pour une période de 7 jours au plus : sur ${windowDays} jours, comparez avec les ${windowDays} jours d'avant.`]);
      expect(result.errors[0]).not.toMatch(JARGON);
      expect(result.hints).toEqual(['"compare" : "previous_window" dès que "windowDays" dépasse 7']);
    }
    expect(ok({ ...drop, windowDays: 30, compare: "previous_window" }).value.compare).toBe("previous_window");
    expect(ok({ ...drop, condition: "rise_pct", windowDays: 7 }).value.compare).toBe("same_weekdays");
    expect(validateAlertProposal({ ...drop, condition: "rise_pct", windowDays: 14 }, ctx()).ok).toBe(false);
  });

  it("ne refuse pas une alerte à seuil pour une comparaison qu'elle ne lit pas", () => {
    // « compare » is read by the variations only: written next to a threshold, it changes nothing.
    expect(ok({ ...base, windowDays: 30, compare: "same_weekdays" }, ctx({ accounts: [META] })).value.windowDays).toBe(30);
  });
});

describe("alertes client — validation : garde-fou du CPA", () => {
  it("impose 5 conversions minimum à un CPA qui n'en fixe pas, et le dit", () => {
    const { value, warnings } = ok(base);
    expect(CPA_MIN_CONVERSIONS).toBe(5);
    expect(value.guards).toEqual({ minConversions: 5 });
    // The guard only — and, for « above », the spend from which it triggers all the same (60 € × 5).
    expect(warnings).toEqual([
      "Pour éviter les fausses alertes, le CPA n'est jugé qu'à partir de 5 conversions sur la période — ou dès 300 € dépensés, car le seuil serait alors dépassé même avec 5 conversions. Ce minimum se change sur simple demande.",
    ]);
    expect(ok({ ...base, condition: "below" }).warnings).toEqual([
      "Pour éviter les fausses alertes, le CPA n'est jugé qu'à partir de 5 conversions sur la période. Ce minimum se change sur simple demande.",
    ]);
  });

  it("respecte le minimum demandé, même nul, sans avertir", () => {
    const only = ctx({ accounts: [META] });
    expect(ok({ ...base, guards: { minConversions: 12 } }, only)).toMatchObject({ value: { guards: { minConversions: 12 } }, warnings: [] });
    expect(ok({ ...base, guards: { minConversions: 0 } }, only)).toMatchObject({ value: { guards: { minConversions: 0 } }, warnings: [] });
    // A spend guard does not replace the conversions guard.
    expect(ok({ ...base, guards: { minSpend: 100 } }, only).value.guards).toEqual({ minSpend: 100, minConversions: 5 });
  });

  it("ne l'impose à aucune autre mesure", () => {
    for (const metric of ["spend", "conversions", "roas", "revenue", "ctr"]) {
      expect(ok({ ...base, metric, threshold: 3 }, ctx({ accounts: [META] })).value.guards, metric).toEqual({});
    }
  });
});

describe("alertes client — validation : ce que disent les chiffres", () => {
  const roas = { label: "ROAS trop bas", metric: "roas", condition: "below", threshold: 2, windowDays: 7 };

  it("refuse un ROAS ou un revenu quand aucun compte ne remonte de valeur", () => {
    const none = series(read(META, null), read(META_2, null), read(GOOGLE, null));
    for (const metric of ["roas", "revenue"]) {
      const errors = refused({ ...roas, metric }, ctx({ series: none }));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Aucun compte de cette alerte ne remonte de valeur de conversion");
      expect(errors[0]).toContain("Surveillez plutôt le coût par conversion ou le nombre de conversions.");
      expect(errors[0]).not.toMatch(JARGON);
      expect(hints({ ...roas, metric }, ctx({ series: none }))).toEqual([`"metric" : "cpa" ou "conversions" à la place de "${metric}"`]);
    }
    // Same alert on the CPA: nothing to refuse.
    expect(validateAlertProposal(base, ctx({ series: none })).ok).toBe(true);
  });

  it("ne juge que les comptes de l'alerte", () => {
    const googleOnly = series(read(META, null), read(META_2, null), read(GOOGLE, 500));
    expect(refused({ ...roas, accounts: [{ platform: "meta", accountId: "1234567890" }] }, ctx({ series: googleOnly }))[0]).toContain("Aucun compte");
    expect(ok({ ...roas, accounts: [{ platform: "google", accountId: "9876543210" }] }, ctx({ series: googleOnly })).warnings).toEqual([]);
  });

  it("refuse un ROAS dès qu'un compte qui dépense ne remonte aucune valeur — comme le moteur, compte par compte", () => {
    // Meta « LPEV Meta » tracks a value; the second Meta account and Google spend without one.
    const metaOnly = series(read(META, 500), read(META_2, null), read(GOOGLE, null));
    const errors = refused(roas, ctx({ series: metaOnly }));
    expect(errors).toEqual([
      "Le ROAS ne peut pas être calculé avec les comptes Meta « LPEV Traffic », Google Ads « LPEV Search » : ils dépensent sans remonter de valeur de conversion. Limitez l'alerte aux comptes qui en remontent une, ou surveillez le coût par conversion.",
    ]);
    // The consultant reads plain French; the fields and the account to keep go to the AI alone.
    expect(errors[0].replace(/« [^»]* »/g, "« … »")).not.toMatch(JARGON);
    expect(hints(roas, ctx({ series: metaOnly }))).toEqual([`"accounts" : [{"platform":"meta","accountId":"1234567890"}] (les seuls comptes qui remontent une valeur), ou bien "metric" : "cpa"`]);
    // One account is enough, inside a platform that otherwise tracks a value: the engine would never compute this ROAS.
    const oneBlind = series(read(META, 500), read(META_2, null), read(GOOGLE, 300));
    expect(refused(roas, ctx({ series: oneBlind }))[0]).toBe(
      "Le ROAS ne peut pas être calculé avec le compte Meta « LPEV Traffic » : il dépense sans remonter de valeur de conversion. Limitez l'alerte aux comptes qui en remontent une, ou surveillez le coût par conversion.",
    );
  });

  it("ne sauve pas ce ROAS en jugeant chaque plateforme seule : une plateforme jamais jugée laisse l'alerte non jugée", () => {
    const metaOnly = series(read(META, 500), dormant(META_2), read(GOOGLE, null));
    expect(refused({ ...roas, aggregation: "each" }, ctx({ series: metaOnly }))[0]).toContain("Le ROAS ne peut pas être calculé avec le compte Google Ads « LPEV Search »");
    // Limited to the accounts that track a value, it goes through.
    expect(ok({ ...roas, accounts: [{ platform: "meta", accountId: "1234567890" }] }, ctx({ series: metaOnly })).warnings).toEqual([]);
  });

  it("ne tient pas compte d'un compte sans valeur qui ne dépense rien", () => {
    // A dormant account shows no value by nature: it takes nothing away from the ROAS of the others.
    const both = series(read(META, 500), dormant(META_2), read(GOOGLE, 300));
    expect(ok(roas, ctx({ series: both })).warnings).toEqual([]);
    expect(ok({ ...roas, aggregation: "each" }, ctx({ series: both })).warnings).toEqual([]);
  });

  it("accepte un revenu partiel en nommant le compte laissé de côté, et le refuse par plateforme quand l'une n'a aucune valeur", () => {
    const metaOnly = series(read(META, 500), read(META_2, 200), read(GOOGLE, null));
    const revenue = { ...roas, metric: "revenue", condition: "below", threshold: 1000 };
    expect(ok(revenue, ctx({ series: metaOnly })).warnings).toEqual(["Le compte Google Ads « LPEV Search » ne remonte aucune valeur de conversion : le revenu ne tient compte que des autres comptes."]);
    const each = refused({ ...revenue, aggregation: "each" }, ctx({ series: metaOnly }));
    expect(each).toEqual(["Google Ads ne remonte aucune valeur de conversion : son revenu ne peut pas être jugé séparément. Limitez l'alerte aux comptes qui en remontent une, ou surveillez le nombre de conversions."]);
    expect(hints({ ...revenue, aggregation: "each" }, ctx({ series: metaOnly }))[0]).toContain('"accounts" : [{"platform":"meta","accountId":"1234567890"},{"platform":"meta","accountId":"555000111"}]');
  });

  it("ne conclut pas à la place d'un compte qui n'a pas pu être lu", () => {
    // A platform whose only account is unreadable is not said to track nothing.
    const blind = series(read(META, 500), read(META_2, 100), unread(GOOGLE));
    expect(validateAlertProposal(roas, ctx({ series: blind })).ok).toBe(true);
  });
});

describe("alertes client — validation : une phrase, un seul propriétaire", () => {
  // The three remarks about the DATA belong to backtest().notes: the validation no longer says them.
  const data = /même vente|compt[ée]e? (à la fois|deux fois)|n'a pas pu être lu|illisible|devise|converti/i;

  it("ne dit plus rien de la vente comptée par les deux plateformes", () => {
    for (const metric of ["conversions", "cpa", "revenue", "roas"]) {
      const { warnings } = ok({ ...base, metric, guards: { minConversions: 5 } });
      expect(warnings.join(" "), metric).not.toMatch(data);
    }
  });

  it("ne dit plus rien d'un compte illisible ou absent des chiffres lus", () => {
    const partial = series(read(META, 500), unread(META_2), read(GOOGLE, 300));
    expect(ok({ ...base, guards: { minConversions: 5 } }, ctx({ series: partial })).warnings).toEqual([]);
    expect(ok({ ...base, guards: { minConversions: 5 } }, ctx({ series: series(read(META, 1), read(GOOGLE, 1)) })).warnings).toEqual([]);
  });

  it("ne dit plus rien des devises converties en euros", () => {
    const mixed = series(read(META, 1), read(META_2, 1, "USD"), read(GOOGLE, 1));
    expect(ok({ ...base, metric: "spend", threshold: 500 }, ctx({ series: mixed })).warnings).toEqual([]);
    expect(ok({ ...base, metric: "spend" }, ctx({ accounts: [{ ...META, currency: "USD" }] })).warnings).toEqual([]);
  });

  it("garde ce qui tient à la définition elle-même", () => {
    // The default CPA guard, a drop that can never trigger, a platform left out of a revenue.
    expect(ok(base).warnings).toHaveLength(1);
    expect(ok({ ...base, metric: "spend", condition: "drop_pct", threshold: 150 }).warnings).toEqual([expect.stringContaining("ne se déclencherait jamais")]);
    const metaOnly = series(read(META, 500), read(META_2, 200), read(GOOGLE, null));
    expect(ok({ label: "Revenu bas", metric: "revenue", condition: "below", threshold: 1000, windowDays: 7 }, ctx({ series: metaOnly })).warnings)
      .toEqual(["Le compte Google Ads « LPEV Search » ne remonte aucune valeur de conversion : le revenu ne tient compte que des autres comptes."]);
  });
});

describe("alertes client — validation : des mots pour le consultant, des champs pour l'IA", () => {
  const broken: Array<[string, Record<string, unknown>, RegExp]> = [
    ["mesure", { ...base, metric: "cpm" }, /"metric" : "spend" \| "conversions" \| "cpa"/],
    ["condition", { ...base, condition: "over" }, /"condition" : "above" \| "below"/],
    ["période", { ...base, windowDays: 2 }, /"windowDays" : 1 \| 3 \| 7 \| 14 \| 30/],
    ["seuil absent", { ...base, threshold: null }, /"threshold" : un nombre > 0/],
    ["seuil de taux de clic", { ...base, metric: "ctr", threshold: 250 }, /"threshold" : un pourcentage entre 0 et 100/],
    ["baisse", { ...base, metric: "spend", condition: "drop_pct", threshold: 0.5 }, /"threshold" : entre 1 et 1000 avec "drop_pct"/],
    ["arrêt", { ...base, condition: "stopped" }, /"condition":"stopped" demande "metric" : "spend" \| "conversions"/],
    ["regroupement", { ...base, aggregation: "both" }, /"aggregation" : "combined" \| "each"/],
    ["comparaison", { ...base, compare: "last_year" }, /"compare" : "previous_window" \| "same_weekdays"/],
    ["rythme", { ...base, checks: "8x" }, /"checks" : "1x" \| "2x" \| "4x"/],
    ["silence", { ...base, cooldownHours: 2 }, /"cooldownHours" : un entier entre 12 et 336/],
    ["jours ouvrés", { ...base, weekdaysOnly: "oui" }, /"weekdaysOnly" : true \| false/],
    ["rappel", { ...base, remind: 1 }, /"remind" : true \| false/],
    ["volumes", { ...base, guards: { minConversions: -1, minSpend: "beaucoup" } }, /"guards\.minConversions" : un nombre ≥ 0/],
    ["compte", { ...base, accounts: [{ platform: "meta", accountId: "999" }] }, /"accounts" : à omettre pour couvrir tous les comptes/],
    ["titre", { ...base, label: "" }, /"label" : obligatoire/],
  ];

  for (const [name, input, hint] of broken) {
    it(`${name} : la phrase du consultant ne contient aucun nom de champ, la note de l'IA les donne`, () => {
      const result = validateAlertProposal(input, ctx());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // What was received is quoted as the AI wrote it (« cpm »), and nothing else of the block.
      for (const sentence of result.errors) expect(sentence.replace(/« [^»]* »/g, "« … »"), sentence).not.toMatch(JARGON);
      expect(result.hints.join(" ; ")).toMatch(hint);
      // One hint per reason, in the same order.
      expect(result.hints).toHaveLength(result.errors.length);
    });
  }

  it("dit ce qui a été reçu comme une personne le dirait", () => {
    expect(refused({ ...base, threshold: null })[0]).toBe("Il manque le seuil : un nombre supérieur à 0 est attendu (reçu : rien).");
    expect(refused({ ...base, threshold: true })[0]).toContain("(reçu : oui)");
    expect(refused({ ...base, threshold: { a: 1 } })[0]).toContain("(reçu : une valeur illisible)");
    expect(refused({ ...base, threshold: -12.5 })[0]).toContain("(reçu : -12,5)");
    expect(refused({ ...base, metric: null })[0]).toContain("Mesure inconnue : rien.");
  });
});
