/**
 * Client alerts — validation of what the AI proposes.
 *
 * The ```alert block of the AI is a text like any other: nothing of it is kept
 * without going through here. The result is a complete AlertDefinition (the
 * defaults of the owner filled in, the accounts taken from the client's own
 * list) or the reasons of the refusal, in French, as the consultant reads them
 * on the card and as the AI gets them back with the next message.
 *
 * Pure: no network, no database. With the series of the client, it also
 * refuses what the engine could never compute (a ROAS on accounts that track
 * no value).
 *
 * Two kinds of words come out of it, each with one reader:
 *   - `errors` and `warnings` are read by the consultant: plain French, no
 *     field name, no value of the block;
 *   - `hints` are read by the AI only, with its next message: the fields and
 *     the values to write, so that it corrects exactly what is reproached.
 *
 * The warnings are about the definition itself (the default CPA guard, a
 * drop above 100 % that can never trigger, a platform left out of a revenue).
 * What the DATA says of the replay — a sale counted by both platforms, an
 * account that could not be read, amounts converted to euros — belongs to
 * backtest().notes and to nothing else: one owner per sentence.
 */

import {
  ALERT_CONDITIONS, ALERT_DEFAULTS, ALERT_METRICS, ALERT_WINDOWS,
  COOLDOWN_MAX_HOURS, COOLDOWN_MIN_HOURS, EXPLANATION_MAX, LABEL_MAX,
  type AccountSeries, type AlertAccountRef, type AlertAggregation, type AlertChecks, type AlertCompare, type AlertCondition,
  type AlertDefinition, type AlertMetric, type AlertPlatform, type AlertWindow, type ClientSeries,
} from "@/lib/client-alerts/types";

export type AlertValidation =
  | { ok: true; value: AlertDefinition; warnings: string[] }
  /** `hints`: for the AI alone (field names, allowed values) — never shown. */
  | { ok: false; errors: string[]; hints: string[] };

/** A CPA on two conversions means nothing: below this, the check is skipped unless the consultant says otherwise. */
export const CPA_MIN_CONVERSIONS = 5;
export const PCT_MIN = 1;
export const PCT_MAX = 1000;

const AGGREGATIONS: readonly AlertAggregation[] = ["combined", "each"];
const COMPARES: readonly AlertCompare[] = ["previous_window", "same_weekdays"];
const CHECKS: readonly AlertChecks[] = ["1x", "2x", "4x"];

const PLATFORM_FR: Record<AlertPlatform, string> = { meta: "Meta", google: "Google Ads" };
const METRIC_FR: Record<AlertMetric, string> = {
  spend: "la dépense", conversions: "les conversions", cpa: "le coût par conversion (CPA)",
  roas: "le ROAS", revenue: "le revenu", ctr: "le taux de clic (CTR)",
};

/** Same account whatever the writing: « act_123 » = « 123 », « 123-456-7890 » = « 1234567890 ». */
export function accountKey(platform: string, accountId: string): string {
  const id = accountId.trim();
  return `${platform}:${platform === "meta" ? id.replace(/^act_/i, "") : id.replace(/-/g, "").replace(/^0+/, "")}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** What was received, as a person would say it: never « null », « true » or a piece of JSON. */
const shown = (v: unknown): string => {
  if (typeof v === "string") return v.trim() ? `« ${v.trim().slice(0, 40)} »` : "rien";
  if (typeof v === "number" && Number.isFinite(v)) return v.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
  if (typeof v === "boolean") return v ? "oui" : "non";
  return v === null || v === undefined ? "rien" : "une valeur illisible";
};
const list = (values: readonly (string | number)[]) => values.map((v) => (typeof v === "string" ? `"${v}"` : String(v))).join(" | ");

/**
 * The ```alert block of the AI → a complete definition, or the reasons it is refused (French).
 * `accounts` = the accounts of the client: an account outside of them is refused, names and currencies come from them.
 * `series` lets it refuse what cannot be computed (a combined ROAS when a platform tracks no value).
 */
export function validateAlertProposal(input: unknown, ctx: { accounts: AlertAccountRef[]; series?: ClientSeries | null }): AlertValidation {
  if (!isObject(input)) return { ok: false, errors: ["La proposition est illisible : une alerte complète est attendue."], hints: ["le bloc doit contenir UN objet JSON"] };
  const errors: string[] = [];
  const hints: string[] = [];
  const warnings: string[] = [];
  /** One refusal: the sentence of the consultant, and what the AI must write instead. */
  const refuse = (sentence: string, hint: string) => { errors.push(sentence); hints.push(hint); };

  // ── Label and explanation ──
  const label = typeof input.label === "string" ? input.label.replace(/\s+/g, " ").trim() : "";
  if (!label) refuse("Il manque le titre de l'alerte.", `"label" : obligatoire`);
  else if (label.length > LABEL_MAX) refuse(`Le titre de l'alerte est trop long : ${label.length} caractères, ${LABEL_MAX} au plus.`, `"label" : ${LABEL_MAX} caractères au plus`);
  const explanation = typeof input.explanation === "string" ? input.explanation.trim().slice(0, EXPLANATION_MAX).trim() : "";

  // ── Accounts: the client's own, by platform and id; nothing else of what the AI wrote is kept ──
  const accounts = pickAccounts(input.accounts, ctx.accounts, refuse);

  // ── The rule ──
  const metric = ALERT_METRICS.includes(input.metric as AlertMetric) ? (input.metric as AlertMetric) : null;
  if (!metric) refuse(`Mesure inconnue : ${shown(input.metric)}. Mesures possibles : dépense, conversions, coût par conversion (CPA), ROAS, revenu, taux de clic (CTR).`, `"metric" : ${list(ALERT_METRICS)}`);

  const condition = ALERT_CONDITIONS.includes(input.condition as AlertCondition) ? (input.condition as AlertCondition) : null;
  if (!condition) refuse(`Condition inconnue : ${shown(input.condition)}. Conditions possibles : dépasse un seuil, passe sous un seuil, baisse en %, hausse en %, plus rien du tout.`, `"condition" : ${list(ALERT_CONDITIONS)}`);

  const windowDays = ALERT_WINDOWS.includes(input.windowDays as AlertWindow) ? (input.windowDays as AlertWindow) : null;
  if (!windowDays) refuse(`Période inconnue : ${shown(input.windowDays)}. Périodes possibles : ${ALERT_WINDOWS.join(", ")} jours.`, `"windowDays" : ${list(ALERT_WINDOWS)}`);

  let threshold: number | null = null;
  if (condition === "stopped") {
    // A threshold written next to « stopped » is ignored: there is nothing to compare.
    if (metric && metric !== "spend" && metric !== "conversions") {
      refuse(`« Plus rien du tout » ne se vérifie que sur la dépense ou les conversions, pas sur ${METRIC_FR[metric]}.`, `"condition":"stopped" demande "metric" : "spend" | "conversions"`);
    }
  } else if (condition) {
    if (!isNumber(input.threshold) || input.threshold <= 0) {
      refuse(`Il manque le seuil : un nombre supérieur à 0 est attendu (reçu : ${shown(input.threshold)}).`, `"threshold" : un nombre > 0`);
    } else if ((condition === "drop_pct" || condition === "rise_pct") && (input.threshold < PCT_MIN || input.threshold > PCT_MAX)) {
      refuse(`Le pourcentage de baisse ou de hausse doit être compris entre ${PCT_MIN} et ${PCT_MAX} (reçu : ${shown(input.threshold)}).`, `"threshold" : entre ${PCT_MIN} et ${PCT_MAX} avec "${condition}"`);
    } else if (metric === "ctr" && (condition === "above" || condition === "below") && input.threshold > 100) {
      refuse(`Un taux de clic est un pourcentage : le seuil doit être compris entre 0 et 100 (reçu : ${shown(input.threshold)}).`, `"threshold" : un pourcentage entre 0 et 100 avec "metric":"ctr" (1.2 = 1,2 %)`);
    } else {
      threshold = input.threshold;
      if (condition === "drop_pct" && threshold > 100) {
        warnings.push(`Une baisse de plus de 100 % est impossible : avec ${shown(threshold)} %, cette alerte ne se déclencherait jamais.`);
      }
    }
  }

  // ── Optional fields: the owner's defaults when the AI leaves them out ──
  const aggregation = oneOf(input.aggregation, AGGREGATIONS, ALERT_DEFAULTS.aggregation,
    (v) => refuse(`Regroupement inconnu : ${shown(v)}. Possibles : Meta et Google Ads additionnés, ou chaque plateforme jugée seule.`, `"aggregation" : ${list(AGGREGATIONS)}`));
  const compare = oneOf(input.compare, COMPARES, ALERT_DEFAULTS.compare,
    (v) => refuse(`Comparaison inconnue : ${shown(v)}. Possibles : les jours d'avant, ou les mêmes jours une semaine plus tôt.`, `"compare" : ${list(COMPARES)}`));
  const checks = oneOf(input.checks, CHECKS, ALERT_DEFAULTS.checks,
    (v) => refuse(`Nombre de vérifications inconnu : ${shown(v)}. Possibles : 1, 2 ou 4 par jour.`, `"checks" : ${list(CHECKS)}`));

  let cooldownHours: number = ALERT_DEFAULTS.cooldownHours;
  if (input.cooldownHours !== undefined && input.cooldownHours !== null) {
    if (!isNumber(input.cooldownHours) || !Number.isInteger(input.cooldownHours) || input.cooldownHours < COOLDOWN_MIN_HOURS || input.cooldownHours > COOLDOWN_MAX_HOURS) {
      refuse(`Le silence après un message doit être un nombre entier d'heures entre ${COOLDOWN_MIN_HOURS} et ${COOLDOWN_MAX_HOURS}, soit ${COOLDOWN_MAX_HOURS / 24} jours au plus (reçu : ${shown(input.cooldownHours)}).`, `"cooldownHours" : un entier entre ${COOLDOWN_MIN_HOURS} et ${COOLDOWN_MAX_HOURS}`);
    } else {
      cooldownHours = input.cooldownHours;
    }
  }
  const weekdaysOnly = yesNo(input.weekdaysOnly, ALERT_DEFAULTS.weekdaysOnly,
    () => refuse("« Du lundi au vendredi seulement » se règle par oui ou non.", `"weekdaysOnly" : true | false`));
  const remind = yesNo(input.remind, ALERT_DEFAULTS.remind,
    () => refuse("Le rappel tant que la situation dure se règle par oui ou non.", `"remind" : true | false`));

  const guards: AlertDefinition["guards"] = {};
  if (input.guards !== undefined && input.guards !== null) {
    if (!isObject(input.guards)) {
      refuse("Les volumes minimum sont illisibles : une dépense minimum et/ou un nombre de conversions minimum sont attendus.", `"guards" : {"minSpend"?: nombre, "minConversions"?: nombre}`);
    } else {
      const { minSpend, minConversions } = input.guards;
      if (minSpend !== undefined && minSpend !== null) {
        if (!isNumber(minSpend) || minSpend < 0) refuse(`La dépense minimum doit être un nombre positif ou nul (reçu : ${shown(minSpend)}).`, `"guards.minSpend" : un nombre ≥ 0`);
        else guards.minSpend = minSpend;
      }
      if (minConversions !== undefined && minConversions !== null) {
        if (!isNumber(minConversions) || minConversions < 0) refuse(`Le nombre de conversions minimum doit être un nombre positif ou nul (reçu : ${shown(minConversions)}).`, `"guards.minConversions" : un nombre ≥ 0`);
        else guards.minConversions = minConversions;
      }
    }
  }
  if (metric === "cpa" && guards.minConversions === undefined) {
    guards.minConversions = CPA_MIN_CONVERSIONS;
    // « Above » has its second way in (cpaSpendFloor): said with the guard, or the guard reads as a blind spot.
    const floor = condition === "above" && threshold !== null
      ? ` — ou dès ${shown(threshold * CPA_MIN_CONVERSIONS)} € dépensés, car le seuil serait alors dépassé même avec ${CPA_MIN_CONVERSIONS} conversions`
      : "";
    warnings.push(`Pour éviter les fausses alertes, le CPA n'est jugé qu'à partir de ${CPA_MIN_CONVERSIONS} conversions sur la période${floor}. Ce minimum se change sur simple demande.`);
  }

  if (errors.length || !metric || !condition || !windowDays) return { ok: false, errors, hints };

  const value: AlertDefinition = {
    version: 1, label, accounts, metric, aggregation, condition, threshold, windowDays, compare, guards,
    checks, weekdaysOnly, cooldownHours, remind, explanation,
  };

  const found = dataFindings(value, ctx.series ?? null);
  if (found.errors.length) return { ok: false, errors: found.errors, hints: found.hints };
  return { ok: true, value, warnings: [...warnings, ...found.warnings] };
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T, refuse: (raw: unknown) => void): T {
  if (raw === undefined || raw === null) return fallback;
  if (allowed.includes(raw as T)) return raw as T;
  refuse(raw);
  return fallback;
}

function yesNo(raw: unknown, fallback: boolean, refuse: () => void): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  refuse();
  return fallback;
}

type Refuse = (sentence: string, hint: string) => void;
const ACCOUNTS_HINT = `"accounts" : à omettre pour couvrir tous les comptes, sinon [{"platform":"meta" | "google","accountId":"<identifiant recopié du contexte>"}]`;

/** The accounts the alert covers, in the order of the client's list; none asked = all of them. */
function pickAccounts(raw: unknown, mine: AlertAccountRef[], refuse: Refuse): AlertAccountRef[] {
  if (!mine.length) {
    refuse("Ce client n'a aucun compte publicitaire à surveiller.", "aucune alerte n'est possible pour ce client : dis-le au consultant, sans bloc");
    return [];
  }
  if (raw === undefined || raw === null) return mine.map(copy);
  if (!Array.isArray(raw)) {
    refuse("La liste des comptes est illisible : une liste de comptes du client est attendue, ou rien pour les couvrir tous.", ACCOUNTS_HINT);
    return [];
  }
  if (!raw.length) return mine.map(copy);

  const byKey = new Map(mine.map((a) => [accountKey(a.platform, a.accountId), a]));
  const wanted = new Set<string>();
  for (const entry of raw) {
    const platform = isObject(entry) ? entry.platform : undefined;
    const accountId = isObject(entry) ? entry.accountId : undefined;
    if (typeof accountId !== "string" || !accountId.trim()) {
      refuse("Un compte de la liste n'a pas d'identifiant : chaque compte se désigne par sa plateforme et son identifiant.", ACCOUNTS_HINT);
      continue;
    }
    if (platform !== "meta" && platform !== "google") {
      refuse(`Plateforme inconnue pour le compte ${accountId.trim().slice(0, 40)} : ${shown(platform)}. Seuls Meta et Google Ads sont couverts.`, ACCOUNTS_HINT);
      continue;
    }
    const key = accountKey(platform, accountId);
    if (!byKey.has(key)) {
      refuse(`Le compte ${PLATFORM_FR[platform]} ${accountId.trim().slice(0, 40)} ne fait pas partie des comptes de ce client.`, `${ACCOUNTS_HINT} — les seuls comptes qui existent sont ceux du dernier contexte`);
      continue;
    }
    wanted.add(key);
  }
  return mine.filter((a) => wanted.has(accountKey(a.platform, a.accountId))).map(copy);
}

const copy = (a: AlertAccountRef): AlertAccountRef => ({ platform: a.platform, accountId: a.accountId, name: a.name, currency: a.currency ?? null });

/**
 * What the accounts say of the DEFINITION: a measure that cannot be computed on them (errors), or
 * that leaves a platform out (warnings). Nothing here about the figures themselves — double
 * counting, unreadable accounts, currencies are the replay's to say (backtest().notes).
 */
function dataFindings(def: AlertDefinition, series: ClientSeries | null): { errors: string[]; hints: string[]; warnings: string[] } {
  const errors: string[] = [];
  const hints: string[] = [];
  const warnings: string[] = [];
  if (!series || (def.metric !== "roas" && def.metric !== "revenue")) return { errors, hints, warnings };
  const platforms = (["meta", "google"] as const).filter((p) => def.accounts.some((a) => a.platform === p));

  const read = new Map<string, AccountSeries>();
  for (const s of series.accounts) read.set(accountKey(s.account.platform, s.account.accountId), s);
  const seriesOf = (a: AlertAccountRef) => read.get(accountKey(a.platform, a.accountId)) ?? null;
  const readable = (a: AlertAccountRef) => { const s = seriesOf(a); return !!s && !s.error; };
  const tracks = (a: AlertAccountRef) => seriesOf(a)?.days.some((d) => d.revenue !== null) ?? false;

  const readAccounts = def.accounts.filter(readable);
  // A platform « tracks nothing » only when its accounts were read and none carries a value.
  const silent = platforms.filter((p) => {
    const ofPlatform = readAccounts.filter((a) => a.platform === p);
    return ofPlatform.length > 0 && !ofPlatform.some(tracks);
  });
  const what = def.metric === "roas" ? "le ROAS" : "le revenu";
  if (readAccounts.length && !readAccounts.some(tracks)) {
    errors.push(`Aucun compte de cette alerte ne remonte de valeur de conversion : ${what} ne peut pas être calculé. Surveillez plutôt le coût par conversion ou le nombre de conversions.`);
    hints.push(`"metric" : "cpa" ou "conversions" à la place de "${def.metric}"`);
  } else if (silent.length && def.metric === "roas" && def.aggregation === "combined") {
    errors.push(`Le ROAS de Meta et Google Ads additionnés ne peut pas être calculé : ${PLATFORM_FR[silent[0]]} ne remonte aucune valeur de conversion. Jugez chaque plateforme séparément, ou surveillez le coût par conversion.`);
    hints.push(`"aggregation" : "each" en gardant "metric":"roas", ou bien "metric" : "cpa"`);
  } else if (silent.length) {
    const other = platforms.find((p) => !silent.includes(p));
    warnings.push(`${PLATFORM_FR[silent[0]]} ne remonte aucune valeur de conversion : ${what} ne tient compte que de ${other ? PLATFORM_FR[other] : "l'autre plateforme"}.`);
  }
  return { errors, hints, warnings };
}
