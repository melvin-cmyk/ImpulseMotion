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
    return { ok: false, error: `« clients » vaut "all" (tous les clients du périmètre) ou la liste des identifiants de clients (${MAX_LISTED_CLIENTS} au plus)` };
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

// ── Where a routine of several clients may send ─────────────────────────

/**
 * Domains of the agency's own addresses. A routine that reads several
 * clients puts the figures of one client next to those of others: its
 * e-mails go to the agency only.
 */
export const AGENCY_EMAIL_DOMAINS = ["impulse-analytics.com"] as const;

export function isAgencyEmail(address: string): boolean {
  const domain = address.trim().toLowerCase().split("@").pop() ?? "";
  return AGENCY_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** « #c_lpev », « c_lpev »: the naming of the agency's channels opened per client (sometimes shared with the client). */
export function looksLikeClientChannel(channel: string): boolean {
  return /^#?c[_-]/i.test(channel.trim());
}

/** Same channel, whatever its spelling: « #C_LPEV » = « c_lpev »; a Slack id as it is. */
export const channelKey = (channel: string): string => channel.trim().replace(/^#/, "").toLowerCase();

/**
 * Messages of a routine that reads several clients that would leave the
 * agency: an e-mail outside AGENCY_EMAIL_DOMAINS, a channel named as a
 * client's. Pure; the channels stored on a client are checked on the server
 * (lib/routines/clients.ts, clientChannelErrors).
 */
export function multiClientMessageErrors(steps: ReadonlyArray<RoutineStep>): string[] {
  if (!definitionClients(steps).multi) return [];
  const errors: string[] = [];
  for (const [i, step] of steps.entries()) {
    const name = `Étape ${i + 1} « ${step.id} » (${step.type})`;
    if (step.type === "email.send") {
      const outside = (Array.isArray(step.to) ? step.to : []).filter((a) => typeof a === "string" && !isAgencyEmail(a));
      if (outside.length) errors.push(`${name} : cette routine lit plusieurs clients, ses e-mails ne partent qu'à des adresses de l'agence (${AGENCY_EMAIL_DOMAINS.map((d) => `@${d}`).join(", ")}) ; refusé : ${outside.join(", ")}.`);
    } else if (step.type === "slack.message" && typeof step.channel === "string" && looksLikeClientChannel(step.channel)) {
      errors.push(`${name} : cette routine lit plusieurs clients, elle ne poste que dans un canal interne de l'agence, jamais dans le canal d'un client (${step.channel}).`);
    }
  }
  return errors;
}
