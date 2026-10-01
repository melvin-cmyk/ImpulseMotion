/**
 * Routines — what the pages know of a routine and of its runs.
 *
 * Pure and client-safe. The API answers are read field by field and never
 * trusted (a definition may arrive as an object or as the JSON text stored in
 * the database), then turned into what the interface shows: labels of
 * statuses, reason why « Activer » is greyed, steps said in French.
 */

import {
  MAX_ACCOUNTS_PER_RUN, STEP_WRITES, WRITE_COUNT_KEYS, emptyCounts,
  type Cell, type PlannedWrite, type RoutineStep, type RowSet, type Schedule, type StepResult, type StepType, type WriteCounts,
} from "@/lib/routines/types";
import { counterTexts, type CounterText } from "@/lib/routines/counts";
import { parseSchedule } from "@/components/routines/schedule-label";
import { definitionClients, isFreeRoutine, stepClients } from "@/lib/routines/client-selection";

type Tone = "default" | "violet" | "emerald" | "amber" | "red" | "blue";
type Raw = Record<string, unknown>;

const isRecord = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
/** Dates arrive in epoch milliseconds (routineView, runView of the store); ISO text is read too. */
const date = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
};

function fromJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

// ── Routine ──────────────────────────────────────────────────────────────

export interface RoutineView {
  id: string;
  name: string;
  description: string | null;
  clientName: string;
  status: string;
  dashboardId: string | null;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  timezone: string | null;
  schedule: Schedule | null;
  steps: RoutineStep[];
  writesPlatform: boolean;
  maxItemsPerRun: number;
  definitionHash: string | null;
  /** The last successful dry run covers the definition as it is now. */
  dryRunValid: boolean;
  dryRunAt: string | null;
  /** A run holds the routine right now. */
  running: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  consecutiveFailures: number;
  createdByEmail: string | null;
  /** Live runs in a row, up to the latest, that were not a full success; `degradedAtLeast` when the count stopped at what was read. */
  degradedRuns: number;
  degradedAtLeast: boolean;
  degradedError: string | null;
  /** Rows a person has to look at (outcome unknown, or given up). */
  itemsToCheck: number;
  /** Names of the clients the steps name in `clients`, by id (sent with one routine, not with the list). */
  clientNames: Record<string, string>;
}

/** Runs in a row without a full success from which the routine is said degraded (DEGRADED_AFTER_RUNS). */
export const DEGRADED_FROM = 3;

/**
 * Banner of a routine that goes on running without succeeding: « routine
 * dégradée depuis N exécutions », with the last error. Null below three runs,
 * and for a routine that no longer runs (it has its own banner).
 */
export function degradedBanner(r: Pick<RoutineView, "status" | "degradedRuns" | "degradedAtLeast" | "degradedError">): { title: string; error: string | null } | null {
  if (r.status !== "active" && r.status !== "paused") return null;
  if (r.degradedRuns < DEGRADED_FROM) return null;
  return {
    title: `Routine dégradée depuis ${r.degradedAtLeast ? "au moins " : ""}${r.degradedRuns} exécutions : aucune n'a entièrement réussi.`,
    error: r.degradedError,
  };
}

export interface ItemToCheckView {
  id: string; rowKey: string; adsetId: string | null; label: string | null; status: "uncertain" | "abandoned";
  externalId: string | null; error: string | null; attempts: number; updatedAt: string | null;
}

export function toItemsToCheck(raw: unknown): ItemToCheckView[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).filter((i) => typeof i.id === "string").map((i) => ({
    id: String(i.id),
    rowKey: str(i.rowKey) ?? str(i.itemKey) ?? "?",
    adsetId: str(i.adsetId),
    label: str(i.label),
    status: i.status === "abandoned" ? "abandoned" as const : "uncertain" as const,
    externalId: str(i.externalId),
    error: str(i.error),
    attempts: int(i.attempts),
    updatedAt: date(i.updatedAt),
  }));
}

const KNOWN_TYPES = new Set<string>(Object.keys(STEP_WRITES));

/** Steps of a definition, keeping only those of a known type: the rest cannot be shown. */
export function readSteps(definition: unknown): RoutineStep[] {
  const parsed = fromJson(definition);
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return [];
  return parsed.steps.filter((s): s is RoutineStep => isRecord(s) && typeof s.id === "string" && typeof s.type === "string" && KNOWN_TYPES.has(s.type));
}

export function stepsWritePlatform(steps: ReadonlyArray<{ type: StepType }>): boolean {
  return steps.some((s) => STEP_WRITES[s.type] === "platform");
}

export function toRoutineView(raw: unknown): RoutineView | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const steps = readSteps(raw.definition ?? raw.definitionJson);
  return {
    id: raw.id,
    name: str(raw.name) ?? "Routine sans nom",
    description: str(raw.description),
    clientName: str(raw.clientName) ?? "—",
    status: str(raw.status) ?? "draft",
    dashboardId: str(raw.dashboardId),
    metaAccountId: str(raw.metaAccountId),
    googleCustomerId: str(raw.googleCustomerId),
    timezone: str(raw.timezone),
    schedule: parseSchedule(raw.schedule ?? raw.scheduleJson),
    steps,
    // Either says so: a routine that creates ads must never lose its banner.
    writesPlatform: raw.writesPlatform === true || stepsWritePlatform(steps),
    maxItemsPerRun: int(raw.maxItemsPerRun),
    definitionHash: str(raw.definitionHash),
    // Said by the server (dryRunValid), or worked out from the two hashes when they are sent.
    dryRunValid: !!str(raw.definitionHash) && (raw.dryRunValid === true || (!!str(raw.dryRunHash) && raw.dryRunHash === raw.definitionHash)),
    dryRunAt: date(raw.dryRunAt),
    running: raw.running === true,
    nextRunAt: date(raw.nextRunAt),
    lastRunAt: date(raw.lastRunAt),
    lastRunStatus: str(raw.lastRunStatus),
    consecutiveFailures: int(raw.consecutiveFailures),
    createdByEmail: str(raw.createdByEmail),
    degradedRuns: int(raw.degradedRuns),
    degradedAtLeast: raw.degradedAtLeast === true,
    degradedError: str(raw.degradedError),
    itemsToCheck: int(raw.itemsToCheck),
    clientNames: isRecord(raw.clientNames)
      ? Object.fromEntries(Object.entries(raw.clientNames).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {},
  };
}

/**
 * Who the routine works for, as the list and the page say it: its client,
 * « Routine libre » when it has none, and the clients its steps read beyond
 * its own (« Tous les clients », « 3 clients »).
 */
export function routineClientLabel(r: Pick<RoutineView, "clientName" | "dashboardId" | "metaAccountId" | "googleCustomerId" | "steps">): string {
  const free = isFreeRoutine(r);
  const own = r.clientName && r.clientName !== "—" ? r.clientName : null;
  const reads = definitionClients(r.steps);
  const many = reads.all ? "Tous les clients" : reads.ids.length ? `${reads.ids.length} client${reads.ids.length > 1 ? "s" : ""}` : null;
  if (free && many) return `${own ? `${own} · ` : ""}Routine libre · ${many}`;
  if (free) return own ? `${own} (routine libre)` : "Routine libre";
  return many ? `${own ?? "—"} + ${many.charAt(0).toLowerCase()}${many.slice(1)}` : own ?? "—";
}

export const ROUTINE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Brouillon", tone: "default" },
  ready: { label: "Prête, non activée", tone: "blue" },
  active: { label: "Active", tone: "emerald" },
  paused: { label: "En pause", tone: "amber" },
  error: { label: "Arrêtée après échecs", tone: "red" },
  archived: { label: "Archivée", tone: "default" },
};

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: "En cours", tone: "blue" },
  success: { label: "Réussie", tone: "emerald" },
  partial: { label: "Partielle", tone: "amber" },
  failed: { label: "Échec", tone: "red" },
  infra_failed: { label: "Panne technique", tone: "amber" },
  missed: { label: "Manquée", tone: "default" },
};

export const RUN_TRIGGER: Record<string, string> = {
  schedule: "Planifiée",
  manual: "Lancée à la main",
  dry_run: "Essai à blanc",
};

export const hasDefinition = (r: Pick<RoutineView, "steps" | "definitionHash">) => r.steps.length > 0 && !!r.definitionHash;


export type RoutineAction = "dry_run" | "activate" | "pause" | "resume" | "run" | "archive";

/**
 * Null when the action is open, otherwise the reason shown next to the greyed
 * button. The server decides in the end; this only avoids a doomed click.
 */
export function actionBlocked(action: RoutineAction, r: RoutineView): string | null {
  if (r.status === "archived") return "Cette routine est archivée.";
  switch (action) {
    case "archive":
      return null;
    case "dry_run":
      return hasDefinition(r) ? null : "Aucune définition : appliquez d'abord une proposition de l'IA.";
    case "activate":
      if (r.status === "active") return "La routine est déjà active.";
      if (r.status === "paused") return "La routine est en pause : utilisez « Reprendre ».";
      if (!hasDefinition(r)) return "Aucune définition : appliquez d'abord une proposition de l'IA.";
      if (!r.dryRunValid) {
        return r.dryRunAt
          ? "La définition a changé depuis le dernier essai à blanc : relancez-le avant d'activer."
          : "Lancez d'abord un essai à blanc : l'activation exige un essai réussi sur cette définition.";
      }
      return null;
    case "pause":
      return r.status === "active" ? null : "Seule une routine active se met en pause.";
    case "resume":
      if (r.status !== "paused") return "Seule une routine en pause se reprend.";
      return r.dryRunValid ? null : "La définition a changé depuis le dernier essai à blanc : relancez-le, puis activez la routine.";
    case "run":
      if (r.status !== "active") return "Activez la routine avant de l'exécuter : seule une routine active s'exécute pour de bon.";
      return r.running ? "Une exécution est déjà en cours." : null;
  }
}

// ── Runs ─────────────────────────────────────────────────────────────────

export interface RunView {
  id: string;
  trigger: string;
  status: string;
  startedAt: string | null;
  durationMs: number;
  definitionHash: string | null;
  totals: { planned: number; created: number; skipped: number; failed: number };
  /** By nature of write, added over the steps: what would be written (dry run) or what was (live run). */
  counts: WriteCounts;
  steps: StepResult[];
  error: string | null;
  timedOut: boolean;
}

const TARGETS = ["meta", "sheet", "slack", "email"] as const;
const isTarget = (v: unknown): v is PlannedWrite["target"] => (TARGETS as readonly unknown[]).includes(v);

function readCounts(raw: unknown): WriteCounts | null {
  if (!isRecord(raw)) return null;
  const counts = emptyCounts();
  for (const key of WRITE_COUNT_KEYS) counts[key] = int(raw[key]);
  return counts;
}

/**
 * Counters of a step. A run stored before the counters existed has none: they
 * are read from what the step planned or wrote, as the engine does.
 */
function countsOf(s: Raw, planned: PlannedWrite[], written: StepResult["written"], type: StepType): WriteCounts {
  const given = readCounts(s.counts);
  if (given) return given;
  const counts = emptyCounts();
  const fallback: PlannedWrite["target"] | null = STEP_WRITES[type] === "platform" ? "meta" : STEP_WRITES[type] === "sheet" ? "sheet" : STEP_WRITES[type] === "message" ? "slack" : null;
  for (const item of written.length ? written : planned) {
    const target = item.target ?? fallback;
    if (target === "meta") counts["attached" in item && item.attached ? "adsAttached" : "adsCreated"]++;
    else if (target === "sheet") counts.sheetRows++;
    else if (target) counts.messages++;
  }
  return counts;
}

function readStepResults(raw: unknown): StepResult[] {
  const parsed = fromJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord).map((s) => {
    const type = (KNOWN_TYPES.has(String(s.type)) ? s.type : "rows.select") as StepType;
    const planned = Array.isArray(s.planned) ? s.planned.filter(isRecord).map(readPlanned) : [];
    const written: StepResult["written"] = Array.isArray(s.written)
      ? s.written.filter(isRecord).map((w) => ({
          summary: str(w.summary) ?? "",
          ...(str(w.itemKey) ? { itemKey: str(w.itemKey)! } : {}),
          ...(str(w.externalId) ? { externalId: str(w.externalId)! } : {}),
          ...(isTarget(w.target) ? { target: w.target } : {}),
          ...(w.attached === true ? { attached: true } : {}),
        }))
      : [];
    return {
      stepId: str(s.stepId) ?? "?",
      type,
      status: s.status === "failed" || s.status === "skipped" ? s.status : "ok",
      durationMs: int(s.durationMs),
      rowsIn: int(s.rowsIn),
      rowsOut: int(s.rowsOut),
      output: isRecord(s.output) ? { ...(typeof s.output.text === "string" ? { text: s.output.text } : {}), ...readRows(s.output.rows) } : {},
      planned,
      written,
      warnings: Array.isArray(s.warnings) ? s.warnings.filter((w): w is string => typeof w === "string") : [],
      counts: countsOf(s, planned, written, type),
      ...(s.timedOut === true ? { timedOut: true } : {}),
      ...(isRecord(s.error) && typeof s.error.message === "string"
        ? { error: { class: s.error.class === "infra" ? "infra" as const : "functional" as const, message: s.error.message, ...(s.error.scope === "items" ? { scope: "items" as const } : {}) } }
        : {}),
    };
  });
}

const isCell = (v: unknown): v is Cell => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** Sample of rows kept with a step (the engine stores a few, not the data). */
function readRows(raw: unknown): { rows?: RowSet } {
  if (!isRecord(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return {};
  const columns = raw.columns.filter((c): c is string => typeof c === "string");
  const rows = raw.rows.filter(isRecord).map((r) => Object.fromEntries(columns.map((c) => [c, isCell(r[c]) ? (r[c] as Cell) : null])));
  return { rows: { columns, rows, truncated: raw.truncated === true } };
}

function readPlanned(p: Raw): PlannedWrite {
  const target = isTarget(p.target) ? p.target : "sheet";
  const preview: PlannedWrite["preview"] = {};
  if (isRecord(p.preview)) {
    for (const [k, v] of Object.entries(p.preview)) {
      if (isCell(v)) preview[k] = v;
    }
  }
  return { target, summary: str(p.summary) ?? "", ...(str(p.itemKey) ? { itemKey: str(p.itemKey)! } : {}), preview };
}

/** A run as the history lists it (row of RoutineRun) or as a route answers it (RunResult). */
export function toRunView(raw: unknown): RunView | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id) ?? str(raw.runId);
  if (!id) return null;
  const totals = isRecord(raw.totals) ? raw.totals : {};
  const steps = readStepResults(raw.steps ?? raw.stepsJson);
  // The counters of the steps are the reference; those sent with the run are the same, added up.
  const counts = emptyCounts();
  for (const s of steps) for (const key of WRITE_COUNT_KEYS) counts[key] += s.counts[key];
  return {
    id,
    trigger: str(raw.trigger) ?? (raw.mode === "dry_run" ? "dry_run" : "manual"),
    status: str(raw.status) ?? "running",
    startedAt: date(raw.startedAt),
    durationMs: int(raw.durationMs),
    definitionHash: str(raw.definitionHash),
    totals: {
      planned: int(totals.planned ?? raw.itemsPlanned),
      created: int(totals.created ?? raw.itemsCreated),
      skipped: int(totals.skipped ?? raw.itemsSkipped),
      failed: int(totals.failed ?? raw.itemsFailed),
    },
    counts: steps.length ? counts : readCounts(raw.counts) ?? counts,
    steps,
    error: str(raw.error),
    timedOut: raw.timedOut === true || steps.some((s) => s.timedOut === true),
  };
}

export type RunCounter = CounterText;

/**
 * The counters of a run, one per nature of write, as the history shows them:
 * the same ones for a dry run (what would be written) and for a live run
 * (what was). A nature at zero is not shown, except the ads of a routine that
 * creates some.
 */
export function runCounters(run: Pick<RunView, "counts" | "trigger" | "steps">): RunCounter[] {
  return counterTexts(run.counts, run.trigger === "dry_run" ? "dry_run" : "live", run.steps.some((s) => STEP_WRITES[s.type] === "platform"));
}

export const EMPTY_DRY_RUN_WARNING = "L'essai n'a rien trouvé à créer : vous activez sans avoir vu d'exemple.";

/**
 * Warning shown with a successful dry run that planned no ad, for a routine
 * that creates some. Activation stays open (a routine of « new rows » has an
 * empty Sheet on some days); the person must know what was not seen.
 */
export function emptyDryRunWarning(run: Pick<RunView, "counts" | "trigger" | "status" | "steps"> | null, routine: Pick<RoutineView, "writesPlatform">): string | null {
  if (!run || run.trigger !== "dry_run" || run.status !== "success") return null;
  const ads = routine.writesPlatform || run.steps.some((s) => STEP_WRITES[s.type] === "platform");
  return ads && run.counts.adsCreated + run.counts.adsAttached === 0 ? EMPTY_DRY_RUN_WARNING : null;
}

/** Everything a run would write, step by step, in the order of the routine. */
export function plannedWrites(run: Pick<RunView, "steps">): Array<PlannedWrite & { stepId: string }> {
  return run.steps.flatMap((s) => s.planned.map((p) => ({ ...p, stepId: s.stepId })));
}

export const TARGET_LABEL: Record<PlannedWrite["target"], string> = {
  meta: "Publicité Meta (en pause)",
  sheet: "Google Sheet",
  slack: "Message Slack",
  email: "E-mail",
};

// ── Dates ────────────────────────────────────────────────────────────────

/** « lun. 5 oct. à 09:00 », in the agency's timezone whatever the browser's. */
export function dateTimeLabel(iso: string | null, timezone: string | null = "Europe/Paris"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const zone = timezone || "Europe/Paris";
  try {
    const day = d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: zone });
    const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: zone });
    return `${day} à ${time}`;
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

/** « 850 ms », « 12 s », « 2 min 05 ». */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`;
}

// ── Steps in French ──────────────────────────────────────────────────────

const LEVEL: Record<string, string> = { account: "du compte", campaign: "par campagne", adset: "par ensemble de publicités", ad: "par publicité", day: "par jour" };
const WINDOW: Record<string, string> = { yesterday: "hier", "7d": "7 derniers jours", "14d": "14 derniers jours", "30d": "30 derniers jours", month_to_date: "mois en cours" };
const METRIC: Record<string, string> = {
  spend: "dépense", impressions: "impressions", clicks: "clics", ctr: "CTR", cpm: "CPM",
  conversions: "conversions", cpa: "coût par conversion", roas: "ROAS",
  purchases: "achats", purchase_value: "valeur des achats", video_views: "vues de vidéo",
};
const OP: Record<string, string> = {
  eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contient", empty: "est vide", not_empty: "n'est pas vide",
};

export const STEP_FAMILY: Record<StepType, { label: string; tone: Tone }> = {
  "sheet.read": { label: "Lecture", tone: "blue" },
  "meta.insights": { label: "Lecture", tone: "blue" },
  "google.insights": { label: "Lecture", tone: "blue" },
  "tiktok.insights": { label: "Lecture", tone: "blue" },
  "rows.filter": { label: "Tri", tone: "default" },
  "rows.sort": { label: "Tri", tone: "default" },
  "rows.limit": { label: "Tri", tone: "default" },
  "rows.select": { label: "Tri", tone: "default" },
  "ai.summary": { label: "Texte IA", tone: "violet" },
  "sheet.write": { label: "Écriture", tone: "amber" },
  "slack.message": { label: "Envoi", tone: "amber" },
  "email.send": { label: "Envoi", tone: "amber" },
  "meta.create_ads": { label: "Publicités", tone: "red" },
};

const q = (v: unknown) => `« ${String(v ?? "")} »`;
const names = (list: unknown, map: Record<string, string>) =>
  (Array.isArray(list) ? list : []).map((m) => map[String(m)] ?? String(m)).join(", ");

/** « de tous les clients de l'agence (…) », « de Jow, Lpev », « de 3 clients » — or null for the routine's own accounts. */
function clientsPhrase(step: RoutineStep, names: Record<string, string>): string | null {
  const selection = stepClients(step);
  if (!selection) return null;
  if (selection === "all") return `de tous les clients de l'agence (${MAX_ACCOUNTS_PER_RUN} comptes au plus par exécution, les plus dépensiers d'abord, sinon par ordre alphabétique ; clients en sommeil exclus)`;
  const known = selection.map((id) => names[id]).filter((n): n is string => !!n);
  if (known.length === selection.length && known.length <= 4) return `de ${known.join(", ")}`;
  return `de ${selection.length} client${selection.length > 1 ? "s" : ""}${known.length ? ` (dont ${known.slice(0, 3).join(", ")})` : ""}`;
}

/** One sentence per step, for a consultant who does not read JSON. `clientNames` names the clients of `clients`, when known. */
export function describeStep(step: RoutineStep, clientNames: Record<string, string> = {}): string {
  const clients = clientsPhrase(step, clientNames);
  const many = clients ? ` ${clients}` : "";
  // Several clients at the account level: one total per account, hence per client or so.
  const level = (l: string) => (clients && l === "account" ? "(un total par compte)" : LEVEL[l] ?? l);
  switch (step.type) {
    case "sheet.read":
      return `Lit l'onglet ${q(step.sheet?.tab)} du Google Sheet${step.requiredColumns?.length ? ` (colonnes attendues : ${step.requiredColumns.join(", ")})` : ""}${step.maxRows ? `, ${step.maxRows} lignes au plus` : ""}.`;
    case "meta.insights":
      return `Lit les performances Meta${many} ${level(step.level)}, ${WINDOW[step.window] ?? step.window} : ${names(step.metrics, METRIC)}${step.nameContains ? ` — noms contenant ${q(step.nameContains)}` : ""}.`;
    case "google.insights":
      return `Lit les performances Google Ads${many} ${level(step.level)}, ${WINDOW[step.window] ?? step.window} : ${names(step.metrics, METRIC)}.`;
    case "tiktok.insights":
      return `Lit les performances TikTok Ads ${clients ?? "des comptes du client"} ${step.level === "account" ? "(un total par compte)" : LEVEL[step.level] ?? step.level}, ${WINDOW[step.window] ?? step.window} : ${names(step.metrics, METRIC)}.`;
    case "rows.filter":
      return `Garde les lignes où ${(step.where ?? []).map((w) => `${q(w.column)} ${OP[w.op] ?? w.op}${w.op === "empty" || w.op === "not_empty" ? "" : ` ${q(w.value)}`}`).join(" et ")}.`;
    case "rows.sort":
      return `Trie par ${q(step.by)}, ${step.dir === "asc" ? "du plus petit au plus grand" : "du plus grand au plus petit"}.`;
    case "rows.limit":
      return `Garde les ${step.count} premières lignes.`;
    case "rows.select":
      return `Garde les colonnes ${(step.columns ?? []).map((c) => (c.as && c.as !== c.from ? `${c.from} (renommée ${c.as})` : c.from)).join(", ")}.`;
    case "ai.summary":
      return `Fait rédiger un texte par l'IA${step.maxChars ? ` (${step.maxChars} caractères au plus)` : ""} : ${q(step.instruction)}${step.onFailure === "fail" ? " La routine s'arrête si l'IA ne répond pas." : " Si l'IA ne répond pas, la routine continue sans ce texte."}`;
    case "sheet.write":
      return `${step.mode === "upsert" ? `Met à jour (ou ajoute) les lignes de l'onglet ${q(step.sheet?.tab)} d'après la colonne ${q(step.keyColumn)}` : `Ajoute des lignes à l'onglet ${q(step.sheet?.tab)}`} : ${(step.columns ?? []).map((c) => c.column).join(", ")}.`;
    case "slack.message":
      return `Poste un message dans le canal Slack ${step.channel}${step.includeTable ? ", avec le tableau des lignes" : ""}.`;
    case "email.send":
      return `Envoie un e-mail à ${(step.to ?? []).join(", ")}${step.includeTable ? ", avec le tableau des lignes" : ""}.`;
    case "meta.create_ads":
      return `Crée une publicité Meta EN PAUSE par ligne (${step.mapping?.mediaType === "video" ? "vidéo" : "image"}), dans l'ensemble ${step.adsetId} de la campagne ${step.campaignId}. Identifiant unique : colonne ${q(step.keyColumn)}${step.writeBack ? ` ; résultat reporté dans la colonne ${q(step.writeBack.statusColumn)} du Sheet` : ""}.`;
  }
}

/** Templates of a step, for the Définition tab: what will be written, as written. */
export function stepTexts(step: RoutineStep): Array<{ label: string; text: string }> {
  switch (step.type) {
    case "slack.message": return [{ label: "Message", text: step.text }];
    case "email.send": return [{ label: "Objet", text: step.subject }, { label: "Corps", text: step.body }];
    case "sheet.write": return (step.columns ?? []).map((c) => ({ label: c.column, text: c.value }));
    case "meta.create_ads": {
      const m = step.mapping ?? ({} as typeof step.mapping);
      return [
        { label: "Nom de la publicité", text: m.adName },
        { label: "Texte principal", text: m.primaryText },
        ...(m.headline ? [{ label: "Titre", text: m.headline }] : []),
        ...(m.description ? [{ label: "Description", text: m.description }] : []),
        { label: "Lien", text: m.linkUrl },
        { label: "Média", text: m.mediaUrl },
        ...(m.callToAction ? [{ label: "Bouton", text: m.callToAction }] : []),
      ].filter((t) => typeof t.text === "string");
    }
    default: return [];
  }
}

// ── Conversation ─────────────────────────────────────────────────────────

/**
 * checking   the server has not answered yet on this proposal
 * unverified the server could not be asked
 * invalid    unreadable block or proposal refused by the validation
 * pending    validated, waiting for the consultant
 * failed     validated, then refused by the server's controls when applied
 */
export type ProposalState = "checking" | "unverified" | "invalid" | "pending" | "applying" | "applied" | "refused" | "failed";

/**
 * « Appliquer » exists for a proposal the server has validated and nothing
 * else: waiting for the click, or to be tried again after the server's
 * controls failed (a Sheet shared since). Never while invalid or unverified.
 */
export function canApplyProposal(state: ProposalState, validated: unknown): boolean {
  return (state === "pending" || state === "failed") && !!validated;
}

/** Proposal statuses follow their message when the thread is shortened from the top. */
export function shiftProposalKeys<T>(byKey: Record<string, T>, dropped: number): Record<string, T> {
  if (dropped <= 0) return byKey;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(byKey)) {
    const m = /^m(\d+)$/.exec(key);
    if (!m) continue;
    const index = Number(m[1]) - dropped;
    if (index >= 0) out[`m${index}`] = value;
  }
  return out;
}

/** The three examples of the empty state; `prompt` is put in the conversation, not sent. */
export const ROUTINE_EXAMPLES: Array<{ key: string; title: string; text: string; name: string; prompt: string }> = [
  {
    key: "creas",
    title: "Pousser des créas sur Meta",
    text: "Chaque matin, les nouvelles lignes d'un Google Sheet deviennent des publicités Meta, créées en pause dans un ensemble existant.",
    name: "Créas du Sheet vers Meta",
    prompt: "Je veux que chaque matin à 8 h, les nouvelles lignes de mon Google Sheet de créas deviennent des publicités Meta, en pause, dans un ensemble de publicités existant. Le résultat doit être reporté dans le Sheet.",
  },
  {
    key: "slack",
    title: "Point hebdo dans Slack",
    text: "Tous les lundis, les cinq campagnes qui ont le plus dépensé sur 7 jours, avec un commentaire rédigé, dans le canal du client.",
    name: "Point hebdo Slack",
    prompt: "Je veux recevoir tous les lundis à 9 h, dans le canal Slack du client, les 5 campagnes Meta qui ont le plus dépensé sur les 7 derniers jours, avec un court commentaire.",
  },
  {
    key: "suivi",
    title: "Suivi quotidien dans un Sheet",
    text: "Chaque jour, la dépense et les conversions de la veille s'ajoutent à un onglet de suivi partagé avec le client.",
    name: "Suivi quotidien dans le Sheet",
    prompt: "Je veux que chaque jour à 7 h 30, la dépense, les conversions et le ROAS Meta de la veille soient ajoutés comme nouvelle ligne dans un onglet de mon Google Sheet de suivi.",
  },
];

export function exampleByKey(key: string | null | undefined) {
  return ROUTINE_EXAMPLES.find((e) => e.key === key) ?? null;
}
