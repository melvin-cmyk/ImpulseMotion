/**
 * Routines — validation of everything that comes from outside.
 *
 * A definition is written by an AI and sent back by a browser: neither is
 * trusted. Nothing is stored or run before it went through here, and the
 * engine validates again what it reads from the database.
 *
 * What is checked, beyond the shape of each step (left to its handler):
 *   - version, 12 steps at most, unique step ids, known step types;
 *   - no field other than those of the step type (a `status` slipped into a
 *     Meta step is refused, not ignored);
 *   - chaining: `input` names an earlier step that produces rows, and a step
 *     that consumes rows has a source above it;
 *   - one meta.create_ads step at most;
 *   - templates within the grammar of lib/routines/template.ts, reading only
 *     earlier steps;
 *   - columns, when they can be known without reading anything (after a
 *     rows.select). Otherwise the step reports the missing column at run time.
 *
 * Errors are sentences in French, shown as they are to the consultant and
 * handed back to the AI so that it corrects its proposal.
 */

import { findStepHandler } from "@/lib/routines/steps";
import { isValidTimezone } from "@/lib/routines/schedule";
import { STEP_ID_RE, parseTemplate, rowOnlyTemplateError, type TemplateToken } from "@/lib/routines/template";
import {
  DEFAULT_MAX_ITEMS_PER_RUN, MAX_ITEMS_PER_RUN_CAP, MAX_STEPS, SCHEDULE_STEP_MINUTES,
  type RoutineDefinition, type RoutineProposal, type RoutineStep, type Schedule, type StepType,
} from "@/lib/routines/types";

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const MAX_DEFINITION_CHARS = 100_000;
export const MAX_NAME_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 2000;
const MAX_EXPLANATION_CHARS = 4000;
const MAX_ASSUMPTIONS = 20;
const MAX_ERRORS = 30;

// ── What each step type is made of ───────────────────────────────────────

const BASE_FIELDS = ["id", "type", "label", "input"] as const;

/** Fields of each step type (lib/routines/types.ts). Anything else is refused. */
const STEP_FIELDS: Record<StepType, readonly string[]> = {
  "sheet.read": ["sheet", "requiredColumns", "maxRows"],
  "meta.insights": ["level", "window", "metrics", "nameContains"],
  "google.insights": ["level", "window", "metrics"],
  "rows.filter": ["where"],
  "rows.sort": ["by", "dir"],
  "rows.limit": ["count"],
  "rows.select": ["columns"],
  "ai.summary": ["instruction", "maxChars", "onFailure"],
  "sheet.write": ["sheet", "mode", "keyColumn", "columns"],
  "slack.message": ["channel", "text", "includeTable"],
  "email.send": ["to", "subject", "body", "includeTable"],
  "meta.create_ads": ["campaignId", "adsetId", "pageId", "instagramActorId", "keyColumn", "mapping", "writeBack"],
};

/** Nested objects whose fields are closed too. */
const NESTED_FIELDS: Partial<Record<StepType, Record<string, readonly string[]>>> = {
  "meta.create_ads": {
    mapping: ["adName", "primaryText", "headline", "description", "linkUrl", "callToAction", "mediaType", "mediaUrl"],
    writeBack: ["sheet", "statusColumn", "adIdColumn", "errorColumn"],
  },
};

/** Never accepted at any depth of a step that writes on a platform: ads are created paused, full stop. */
const FORBIDDEN_PLATFORM_KEYS = new Set(["status", "effective_status", "configured_status", "effectivestatus", "configuredstatus"]);

/**
 * meta.create_ads is one of them: its rows are those it received, each with
 * what became of it (meta_statut, meta_ad_id, meta_erreur). What follows it
 * reads these rows, so a message says what was created and is not sent when
 * the creation did not go through.
 */
const ROW_PRODUCERS: ReadonlySet<StepType> = new Set<StepType>([
  "sheet.read", "meta.insights", "google.insights", "rows.filter", "rows.sort", "rows.limit", "rows.select", "meta.create_ads",
]);
const SOURCES: ReadonlySet<StepType> = new Set<StepType>(["sheet.read", "meta.insights", "google.insights"]);
/** Steps that cannot do anything without rows. Messages need rows only if they show them. */
const ROW_CONSUMERS: ReadonlySet<StepType> = new Set<StepType>([
  "rows.filter", "rows.sort", "rows.limit", "rows.select", "ai.summary", "sheet.write", "meta.create_ads",
]);
const TEXT_PRODUCERS: ReadonlySet<StepType> = new Set<StepType>(["ai.summary"]);

export const producesRows = (type: StepType) => ROW_PRODUCERS.has(type);
export const producesText = (type: StepType) => TEXT_PRODUCERS.has(type);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Templates of a step ──────────────────────────────────────────────────

/** Every field of a step that is a template, with the name shown in an error. */
export function stepTemplates(step: RoutineStep): Array<{ field: string; template: unknown }> {
  switch (step.type) {
    case "sheet.write":
      return (Array.isArray(step.columns) ? step.columns : []).map((c) => ({ field: `colonne « ${c?.column} »`, template: c?.value }));
    case "slack.message":
      return [{ field: "text", template: step.text }];
    case "email.send":
      return [{ field: "subject", template: step.subject }, { field: "body", template: step.body }];
    case "meta.create_ads": {
      const m = (step.mapping ?? {}) as Partial<typeof step.mapping>;
      const out = [
        { field: "mapping.adName", template: m.adName as unknown },
        { field: "mapping.primaryText", template: m.primaryText as unknown },
        { field: "mapping.linkUrl", template: m.linkUrl as unknown },
        { field: "mapping.mediaUrl", template: m.mediaUrl as unknown },
      ];
      if (m.headline !== undefined) out.push({ field: "mapping.headline", template: m.headline });
      if (m.description !== undefined) out.push({ field: "mapping.description", template: m.description });
      return out;
    }
    default:
      return [];
  }
}

function tokensOf(step: RoutineStep): { tokens: Array<{ field: string; token: TemplateToken }>; errors: string[] } {
  const tokens: Array<{ field: string; token: TemplateToken }> = [];
  const errors: string[] = [];
  for (const { field, template } of stepTemplates(step)) {
    const parsed = parseTemplate(template);
    if (!parsed.ok) { errors.push(`${field} : ${parsed.error}`); continue; }
    for (const token of parsed.tokens) if (token.kind !== "text") tokens.push({ field, token });
  }
  return { tokens, errors };
}

// ── Chaining ─────────────────────────────────────────────────────────────

/**
 * Step whose rows a step reads: `input` when given, the nearest earlier step
 * that produces rows otherwise (an ai.summary in between does not hide the
 * rows from the message that follows it). Null for a source, or when nothing
 * above produces rows.
 */
export function resolveInputId(steps: ReadonlyArray<Pick<RoutineStep, "id" | "type" | "input">>, index: number): string | null {
  const step = steps[index];
  if (!step || SOURCES.has(step.type)) return null;
  if (step.input) {
    const at = steps.findIndex((s) => s.id === step.input);
    return at >= 0 && at < index && producesRows(steps[at].type) ? step.input : null;
  }
  for (let i = index - 1; i >= 0; i--) if (producesRows(steps[i].type)) return steps[i].id;
  return null;
}

/** Steps a step depends on: the one it reads rows from and those whose text it quotes. */
export function stepDependencies(steps: ReadonlyArray<RoutineStep>, index: number): string[] {
  const deps = new Set<string>();
  const input = resolveInputId(steps, index);
  if (input) deps.add(input);
  for (const { token } of tokensOf(steps[index]).tokens) if (token.kind === "step.text") deps.add(token.stepId);
  return [...deps];
}

interface KnownColumns { columns: string[]; exact: boolean }

/** Columns of the rows a step produces, as far as the definition alone tells. */
function columnsAfter(steps: ReadonlyArray<RoutineStep>, index: number, seen = 0): KnownColumns | null {
  const step = steps[index];
  if (!step || seen > MAX_STEPS) return null;
  if (step.type === "rows.select") return { columns: step.columns.map((c) => c.as ?? c.from), exact: true };
  if (step.type === "sheet.read") return { columns: [...step.requiredColumns], exact: false };
  if (step.type === "rows.filter" || step.type === "rows.sort" || step.type === "rows.limit") {
    const input = resolveInputId(steps, index);
    const at = input ? steps.findIndex((s) => s.id === input) : -1;
    return at >= 0 ? columnsAfter(steps, at, seen + 1) : null;
  }
  return null;
}

/** Columns of its input that a step reads by name. */
function columnsRead(step: RoutineStep): string[] {
  const out: string[] = [];
  if (step.type === "rows.filter") out.push(...step.where.map((w) => w.column));
  else if (step.type === "rows.sort") out.push(step.by);
  else if (step.type === "rows.select") out.push(...step.columns.map((c) => c.from));
  else if (step.type === "meta.create_ads" && typeof step.keyColumn === "string") out.push(step.keyColumn);
  for (const { token } of tokensOf(step).tokens) if (token.kind === "row") out.push(token.column);
  return [...new Set(out)];
}

// ── Definition ───────────────────────────────────────────────────────────

function forbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 8 || typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (const v of value) { const hit = forbiddenKey(v, depth + 1); if (hit) return hit; }
    return null;
  }
  for (const [key, v] of Object.entries(value)) {
    if (FORBIDDEN_PLATFORM_KEYS.has(key.toLowerCase())) return key;
    const hit = forbiddenKey(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function closedFields(raw: Record<string, unknown>, type: StepType): string | null {
  const allowed = [...BASE_FIELDS, ...STEP_FIELDS[type]];
  const extra = Object.keys(raw).find((k) => !allowed.includes(k));
  if (extra !== undefined) return `champ « ${extra} » refusé pour une étape ${type}`;
  for (const [field, fields] of Object.entries(NESTED_FIELDS[type] ?? {})) {
    const nested = raw[field];
    if (!isPlainObject(nested)) continue;
    const bad = Object.keys(nested).find((k) => !fields.includes(k));
    if (bad !== undefined) return `champ « ${field}.${bad} » refusé pour une étape ${type}`;
  }
  return null;
}

export function validateDefinition(input: unknown): Validation<RoutineDefinition> {
  const errors: string[] = [];
  const fail = (): Validation<RoutineDefinition> => ({ ok: false, errors: errors.slice(0, MAX_ERRORS) });

  if (!isPlainObject(input)) return { ok: false, errors: ["La définition doit être un objet { version, steps }."] };
  let size = 0;
  try { size = JSON.stringify(input).length; } catch { return { ok: false, errors: ["La définition n'est pas un JSON valide."] }; }
  if (size > MAX_DEFINITION_CHARS) return { ok: false, errors: ["La définition est trop volumineuse."] };

  const extra = Object.keys(input).find((k) => k !== "version" && k !== "steps");
  if (extra !== undefined) errors.push(`Champ « ${extra} » inconnu dans la définition.`);
  if (input.version !== 1) errors.push("Version de définition inconnue (attendue : 1).");
  if (!Array.isArray(input.steps)) { errors.push("« steps » doit être la liste des étapes."); return fail(); }
  if (!input.steps.length) errors.push("La routine ne contient aucune étape.");
  if (input.steps.length > MAX_STEPS) { errors.push(`Trop d'étapes : ${input.steps.length}, pour ${MAX_STEPS} au plus.`); return fail(); }

  // 1. Each step on its own.
  const steps: RoutineStep[] = [];
  const ids = new Set<string>();
  for (const [i, raw] of input.steps.entries()) {
    const at = `Étape ${i + 1}`;
    if (!isPlainObject(raw)) { errors.push(`${at} : objet attendu.`); continue; }
    const handler = findStepHandler(raw.type);
    if (!handler) { errors.push(`${at} : type d'étape inconnu « ${String(raw.type).slice(0, 40)} ».`); continue; }
    const type = handler.type;
    const name = typeof raw.id === "string" && STEP_ID_RE.test(raw.id) ? `${at} « ${raw.id} » (${type})` : `${at} (${type})`;
    if (typeof raw.id !== "string" || !STEP_ID_RE.test(raw.id)) { errors.push(`${name} : identifiant invalide (lettres, chiffres, tiret et souligné, 40 caractères au plus).`); continue; }
    if (ids.has(raw.id)) { errors.push(`${name} : identifiant déjà utilisé par une autre étape.`); continue; }
    ids.add(raw.id);
    if (raw.input !== undefined && (typeof raw.input !== "string" || !STEP_ID_RE.test(raw.input))) { errors.push(`${name} : « input » doit désigner une étape par son identifiant.`); continue; }
    const closed = closedFields(raw, type);
    if (closed) { errors.push(`${name} : ${closed}.`); continue; }
    if (handler.writes === "platform") {
      const forbidden = forbiddenKey(raw);
      if (forbidden) { errors.push(`${name} : champ « ${forbidden} » refusé, les publicités sont toujours créées en pause.`); continue; }
    }
    let checked: ReturnType<typeof handler.validate>;
    try { checked = handler.validate(raw); } catch { checked = { ok: false, error: "étape illisible" }; }
    if (!checked.ok) { errors.push(`${name} : ${checked.error}.`.replace(/\.\.$/, ".")); continue; }
    // The handler rebuilds the step; identity and chaining stay what was sent.
    const step = { ...checked.step, id: raw.id, type } as RoutineStep;
    if (typeof raw.input === "string" && !SOURCES.has(type)) step.input = raw.input; else delete step.input;
    if (handler.writes === "platform" && forbiddenKey(step)) { errors.push(`${name} : champ de statut refusé.`); continue; }
    const templates = tokensOf(step);
    if (templates.errors.length) { for (const e of templates.errors) errors.push(`${name}, ${e}.`.replace(/\.\.$/, ".")); continue; }
    // The name by which an ad is found again must be the same at every run: it reads its row and nothing else.
    const moving = step.type === "meta.create_ads" && typeof step.mapping?.adName === "string" ? rowOnlyTemplateError(step.mapping.adName) : null;
    if (moving) { errors.push(`${name}, mapping.adName : ${moving}.`); continue; }
    steps.push(step);
  }
  if (errors.length) return fail();

  // 2. The steps together.
  const creations = steps.filter((s) => s.type === "meta.create_ads");
  if (creations.length > 1) errors.push(`Une seule étape meta.create_ads par routine (${creations.length} trouvées).`);

  for (const [i, step] of steps.entries()) {
    const name = `Étape ${i + 1} « ${step.id} » (${step.type})`;
    if (step.input) {
      const at = steps.findIndex((s) => s.id === step.input);
      if (at === -1) { errors.push(`${name} : « input » désigne l'étape « ${step.input} », qui n'existe pas.`); continue; }
      if (at >= i) { errors.push(`${name} : « input » doit désigner une étape placée avant elle (« ${step.input} » vient après).`); continue; }
      if (!producesRows(steps[at].type)) { errors.push(`${name} : l'étape « ${step.input} » (${steps[at].type}) ne produit pas de lignes.`); continue; }
    }
    const { tokens } = tokensOf(step);
    const inputId = resolveInputId(steps, i);
    const readsRows = ROW_CONSUMERS.has(step.type)
      || tokens.some((t) => t.token.kind === "row")
      || ((step.type === "slack.message" || step.type === "email.send") && step.includeTable === true);
    if (readsRows && !inputId) { errors.push(`${name} : aucune étape en amont ne produit de lignes (il faut une source : sheet.read, meta.insights ou google.insights).`); continue; }

    for (const { field, token } of tokens) {
      if (token.kind !== "step.text") continue;
      const at = steps.findIndex((s) => s.id === token.stepId);
      if (at === -1) errors.push(`${name}, ${field} : {{steps.${token.stepId}.text}} désigne une étape qui n'existe pas.`);
      else if (at >= i) errors.push(`${name}, ${field} : {{steps.${token.stepId}.text}} doit désigner une étape placée avant elle.`);
      else if (!producesText(steps[at].type)) errors.push(`${name}, ${field} : l'étape « ${token.stepId} » (${steps[at].type}) ne produit pas de texte.`);
    }

    if (inputId) {
      const known = columnsAfter(steps, steps.findIndex((s) => s.id === inputId));
      if (known?.exact) {
        for (const column of columnsRead(step)) {
          if (!known.columns.includes(column)) {
            errors.push(`${name} : colonne « ${column} » inconnue. L'étape « ${inputId} » fournit : ${known.columns.map((c) => `« ${c} »`).join(", ")}.`);
          }
        }
      }
    }
  }
  if (errors.length) return fail();
  return { ok: true, value: { version: 1, steps } };
}

/** Reads a definition stored as JSON (Routine.definitionJson). */
export function parseStoredDefinition(json: string | null | undefined): Validation<RoutineDefinition> {
  let raw: unknown;
  try { raw = JSON.parse(json || "{}"); } catch { return { ok: false, errors: ["Définition enregistrée illisible."] }; }
  return validateDefinition(raw);
}

// ── Schedule ─────────────────────────────────────────────────────────────

const SCHEDULE_KINDS = ["daily", "weekly", "monthly", "manual"] as const;

export function validateSchedule(input: unknown): Validation<Schedule> {
  if (!isPlainObject(input)) return { ok: false, errors: ["Le planning doit être un objet { kind, time, … }."] };
  const errors: string[] = [];
  const extra = Object.keys(input).find((k) => !["kind", "time", "weekdays", "dayOfMonth"].includes(k));
  if (extra !== undefined) errors.push(`Planning : champ « ${extra} » inconnu (aucune expression cron n'est acceptée).`);
  const kind = SCHEDULE_KINDS.find((k) => k === input.kind);
  if (!kind) return { ok: false, errors: [...errors, "Planning : « kind » doit valoir daily, weekly, monthly ou manual."] };
  if (kind === "manual") return errors.length ? { ok: false, errors } : { ok: true, value: { kind } };

  const schedule: Schedule = { kind };
  const m = typeof input.time === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.time) : null;
  if (!m) errors.push("Planning : « time » doit être une heure au format HH:MM.");
  else if (Number(m[2]) % SCHEDULE_STEP_MINUTES !== 0) errors.push(`Planning : l'heure doit tomber sur un pas de ${SCHEDULE_STEP_MINUTES} minutes (08:00, 08:15, 08:30, 08:45).`);
  else schedule.time = m[0];

  if (kind === "weekly") {
    const days = input.weekdays;
    if (!Array.isArray(days) || !days.length || days.some((d) => typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 7)) {
      errors.push("Planning hebdomadaire : « weekdays » doit lister des jours de 1 (lundi) à 7 (dimanche).");
    } else {
      schedule.weekdays = [...new Set(days as number[])].sort((a, b) => a - b);
    }
  } else if (input.weekdays !== undefined) {
    errors.push("Planning : « weekdays » ne s'emploie qu'avec un planning hebdomadaire.");
  }

  if (kind === "monthly") {
    const day = input.dayOfMonth;
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 28) {
      errors.push("Planning mensuel : « dayOfMonth » doit être un jour de 1 à 28.");
    } else {
      schedule.dayOfMonth = day;
    }
  } else if (input.dayOfMonth !== undefined) {
    errors.push("Planning : « dayOfMonth » ne s'emploie qu'avec un planning mensuel.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: schedule };
}

/** Reads a schedule stored as JSON (Routine.scheduleJson). */
export function parseStoredSchedule(json: string | null | undefined): Validation<Schedule> {
  let raw: unknown;
  try { raw = JSON.parse(json || "{}"); } catch { return { ok: false, errors: ["Planning enregistré illisible."] }; }
  return validateSchedule(raw);
}

export function validateTimezone(input: unknown): Validation<string> {
  return isValidTimezone(input) ? { ok: true, value: input } : { ok: false, errors: ["Fuseau horaire inconnu."] };
}

// ── Proposal ─────────────────────────────────────────────────────────────

export function validateMaxItems(input: unknown): Validation<number> {
  if (input === undefined || input === null) return { ok: true, value: DEFAULT_MAX_ITEMS_PER_RUN };
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > MAX_ITEMS_PER_RUN_CAP) {
    return { ok: false, errors: [`« maxItemsPerRun » doit être un entier de 1 à ${MAX_ITEMS_PER_RUN_CAP}.`] };
  }
  return { ok: true, value: input };
}

export function validateName(input: unknown): Validation<string> {
  const name = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
  if (!name) return { ok: false, errors: ["Le nom de la routine est obligatoire."] };
  if (name.length > MAX_NAME_CHARS) return { ok: false, errors: [`Le nom de la routine dépasse ${MAX_NAME_CHARS} caractères.`] };
  return { ok: true, value: name };
}

/** A proposal with its ceiling always set: what the definition route stores. */
export type ValidProposal = RoutineProposal & { maxItemsPerRun: number };

export function validateProposal(input: unknown): Validation<ValidProposal> {
  if (!isPlainObject(input)) return { ok: false, errors: ["La proposition doit être un objet."] };
  const errors: string[] = [];
  const allowed = ["name", "description", "schedule", "definition", "maxItemsPerRun", "explanation", "assumptions"];
  const extra = Object.keys(input).find((k) => !allowed.includes(k));
  if (extra !== undefined) errors.push(`Champ « ${extra} » inconnu dans la proposition.`);

  const name = validateName(input.name);
  if (!name.ok) errors.push(...name.errors);

  let description = "";
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string") errors.push("La description doit être un texte.");
    else if (input.description.length > MAX_DESCRIPTION_CHARS) errors.push(`La description dépasse ${MAX_DESCRIPTION_CHARS} caractères.`);
    else description = input.description.trim();
  }

  let explanation = "";
  if (input.explanation !== undefined && input.explanation !== null) {
    if (typeof input.explanation !== "string") errors.push("« explanation » doit être un texte.");
    else explanation = input.explanation.slice(0, MAX_EXPLANATION_CHARS).trim();
  }

  let assumptions: string[] = [];
  if (input.assumptions !== undefined && input.assumptions !== null) {
    if (!Array.isArray(input.assumptions) || input.assumptions.some((a) => typeof a !== "string")) errors.push("« assumptions » doit être une liste de textes.");
    else assumptions = (input.assumptions as string[]).slice(0, MAX_ASSUMPTIONS).map((a) => a.slice(0, 500).trim()).filter(Boolean);
  }

  const schedule = validateSchedule(input.schedule);
  if (!schedule.ok) errors.push(...schedule.errors);
  const maxItems = validateMaxItems(input.maxItemsPerRun);
  if (!maxItems.ok) errors.push(...maxItems.errors);
  const definition = validateDefinition(input.definition);
  if (!definition.ok) errors.push(...definition.errors);

  if (errors.length || !name.ok || !schedule.ok || !maxItems.ok || !definition.ok) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return {
    ok: true,
    value: {
      name: name.value, description, schedule: schedule.value, definition: definition.value,
      maxItemsPerRun: maxItems.value, explanation, assumptions,
    },
  };
}
