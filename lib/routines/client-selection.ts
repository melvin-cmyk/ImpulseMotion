/**
 * Routines — the `clients` of a read step: the rule of its shape, and what a
 * definition says of the clients it reads. Pure and client-safe.
 *
 * A read step (meta.insights, google.insights, tiktok.insights) reads by
 * default the routine's own accounts. With `clients` it reads instead the
 * accounts of several clients: "all" (every client in the scope of who
 * answers for the run) or a list of client ids (AlertClient.id, the clients
 * of the automatic alerts: every account of the agency, with or without a
 * dashboard, TikTok included). Who may read what is decided at every run, on
 * the server (lib/routines/clients.ts): nothing here grants anything.
 */

import { MAX_LISTED_CLIENTS, type ClientSelection, type RoutineStep, type StepType } from "@/lib/routines/types";

/** Read steps that accept `clients`. */
export const MULTI_CLIENT_STEP_TYPES: ReadonlySet<StepType> = new Set<StepType>(["meta.insights", "google.insights", "tiktok.insights"]);

const CLIENT_ID_RE = /^[a-z0-9]{8,40}$/i;

/** `clients` from untrusted input, rebuilt: "all", or 1 to MAX_LISTED_CLIENTS ids without duplicates. */
export function readClientSelection(value: unknown): { ok: true; value: ClientSelection } | { ok: false; error: string } {
  if (value === "all") return { ok: true, value: "all" };
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: `« clients » vaut "all" (tous vos clients) ou la liste des identifiants de clients (${MAX_LISTED_CLIENTS} au plus)` };
  }
  const ids: string[] = [];
  for (const raw of value) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!CLIENT_ID_RE.test(id)) return { ok: false, error: `« clients » : identifiant de client invalide « ${String(raw).slice(0, 40)} »` };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_LISTED_CLIENTS) return { ok: false, error: `« clients » : ${MAX_LISTED_CLIENTS} clients au plus par étape` };
  return { ok: true, value: ids };
}

/** The selection of a step, or null when it reads the routine's own accounts. */
export function stepClients(step: Pick<RoutineStep, "type"> & { clients?: unknown }): ClientSelection | null {
  if (!MULTI_CLIENT_STEP_TYPES.has(step.type)) return null;
  const read = step.clients === undefined ? null : readClientSelection(step.clients);
  return read && read.ok ? read.value : null;
}

/** What the steps of a definition read beyond the routine's accounts. */
export interface DefinitionClients {
  /** One step at least reads several clients. */
  multi: boolean;
  /** One step reads « all my clients ». */
  all: boolean;
  /** Client ids named by the steps, without duplicates. */
  ids: string[];
}

export function definitionClients(steps: ReadonlyArray<Pick<RoutineStep, "type"> & { clients?: unknown }>): DefinitionClients {
  const out: DefinitionClients = { multi: false, all: false, ids: [] };
  for (const step of steps) {
    const selection = stepClients(step);
    if (!selection) continue;
    out.multi = true;
    if (selection === "all") out.all = true;
    else for (const id of selection) if (!out.ids.includes(id)) out.ids.push(id);
  }
  return out;
}

/** Same question on a definition stored as JSON (Routine.definitionJson). Unreadable: nothing. */
export function storedDefinitionClients(definitionJson: string | null | undefined): DefinitionClients {
  try {
    const parsed = JSON.parse(definitionJson || "{}") as { steps?: unknown };
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.filter((s): s is { type: StepType; clients?: unknown } => !!s && typeof s === "object" && typeof (s as { type?: unknown }).type === "string")
      : [];
    return definitionClients(steps);
  } catch {
    return { multi: false, all: false, ids: [] };
  }
}

/** A routine with no client of its own: no dashboard, no Meta nor Google account. */
export function isFreeRoutine(r: { dashboardId?: string | null; metaAccountId?: string | null; googleCustomerId?: string | null }): boolean {
  return !r.dashboardId && !r.metaAccountId && !r.googleCustomerId;
}
