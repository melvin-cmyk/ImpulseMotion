/**
 * Client alerts — one rule asked once for several clients (a « lot »).
 *
 * The consultant ticks several clients, then talks to the AI once. The rule is
 * the same for all; validating it puts ONE alert in service per client, each
 * judged on its own accounts — never added up across clients — with its own
 * silence, its own replay and its own line in the private message. The cron
 * knows nothing of lots: every alert of a lot is an ordinary ClientAlert.
 *
 * Storage: the alert that holds the conversation (the « lead », made for the
 * first client ticked) keeps the AlertClient ids of the lot in `groupJson`;
 * every alert of the lot, the lead included, carries `groupId` = the lead's id.
 *
 * Accounts: in a lot the AI never names an account (it would be one client's).
 * It leaves `accounts` out — every account of each client — or writes the
 * platforms only (`[{"platform":"meta"}]`), and each client gets its own
 * accounts of those platforms. A client that has none of them is left out of
 * the lot's alert, and the card says so.
 *
 * Pure: no network, no database.
 */

import { backtest, replayVerdict } from "@/lib/client-alerts/backtest";
import { validateAlertProposal } from "@/lib/client-alerts/validate";
import {
  NOISY_MESSAGES, readLot,
  type AlertAccountRef, type AlertDefinition, type AlertPlatform, type AlertProposalInput, type Backtest, type ClientSeries,
} from "@/lib/client-alerts/types";

export { LOT_MAX_CLIENTS, readLot } from "@/lib/client-alerts/types";

const PLATFORMS: readonly AlertPlatform[] = ["meta", "google", "tiktok"];
const PLATFORM_FR: Record<AlertPlatform, string> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok Ads" };

/** The alert holds the conversation of a lot of several clients. */
export const isLotLead = (alert: { groupJson?: string | null }) => readLot(alert.groupJson).length > 1;

/** Ids asked for a new alert: one or several, without duplicates; null when nothing usable was sent. */
export function readClientIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { alertClientIds?: unknown; alertClientId?: unknown };
  const raw = Array.isArray(b.alertClientIds) ? b.alertClientIds : typeof b.alertClientId === "string" ? [b.alertClientId] : [];
  const ids = [...new Set(raw.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))];
  return ids.length ? ids : null;
}

// ── Accounts of each client ──────────────────────────────────────────────

/**
 * The platforms the lot's alert covers, read in the `accounts` of the block:
 * null = every account of each client. An account id written anyway is
 * ignored — only its platform counts.
 */
export function lotPlatforms(raw: unknown): AlertPlatform[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const wanted = new Set<AlertPlatform>();
  for (const entry of raw) {
    const p = entry && typeof entry === "object" ? (entry as { platform?: unknown }).platform : undefined;
    if (PLATFORMS.includes(p as AlertPlatform)) wanted.add(p as AlertPlatform);
  }
  return wanted.size ? PLATFORMS.filter((p) => wanted.has(p)) : null;
}

/**
 * The proposal for one client of the lot: the rule as written, with that
 * client's own accounts. null when the client has no account on the platforms asked.
 */
export function proposalForClient(
  rule: Record<string, unknown>, platforms: AlertPlatform[] | null, accounts: AlertAccountRef[],
): AlertProposalInput | null {
  const mine = platforms ? accounts.filter((a) => platforms.includes(a.platform)) : accounts;
  if (!mine.length) return null;
  const rest: Record<string, unknown> = { ...rule };
  delete rest.accounts;
  return { ...(rest as AlertProposalInput), accounts: mine.map((a) => ({ platform: a.platform, accountId: a.accountId })) };
}

export const platformsText = (platforms: AlertPlatform[]) => platforms.map((p) => PLATFORM_FR[p]).join(" ou ");

// ── Checking a proposal on every client ──────────────────────────────────

/** One client of the lot as the server read it for this request. */
export interface LotMember {
  alertClientId: string;
  clientName: string;
  /** The client's current accounts the person may read; [] with `blocked`. */
  accounts: AlertAccountRef[];
  /** null when the figures could not be read. */
  series: ClientSeries | null;
  /** Why nothing can be proposed for this client (gone, out of reach). */
  blocked?: string | null;
}

/** What a proposal gives on one client of the lot. */
export interface LotClientCheck {
  alertClientId: string;
  clientName: string;
  ok: boolean;
  /** ok: the replay over the last 30 days. */
  messages?: number;
  judgedDays?: number;
  days?: number;
  noisy?: boolean;
  /** not ok: why, in French; `retry` = not the rule's fault (figures unreadable now). */
  error?: string;
  retry?: boolean;
  /** not ok: the fields to write, for the AI's next turn only — never shown. */
  hints?: string[];
}

export interface LotCheck {
  platforms: AlertPlatform[] | null;
  clients: LotClientCheck[];
}

/** A client of the lot the rule can be put in service on, with what proves it. */
export interface LotAccepted {
  member: LotMember;
  definition: AlertDefinition;
  warnings: string[];
  backtest: Backtest;
}

export interface LotOutcome {
  lot: LotCheck;
  accepted: LotAccepted[];
}

const FIGURES_UNREADABLE = "chiffres illisibles pour le moment, réessayez dans quelques minutes";

/**
 * The rule on every client of the lot: validated against the client's accounts
 * and figures, then replayed with the code the cron runs — the same steps as
 * for one client. `unread` turns the accounts a replay waits for into words.
 */
export function checkLot(
  rule: Record<string, unknown>, members: LotMember[], unread: (accounts: AlertAccountRef[]) => string,
  opts: { now?: Date } = {},
): LotOutcome {
  const platforms = lotPlatforms(rule.accounts);
  const clients: LotClientCheck[] = [];
  const accepted: LotAccepted[] = [];
  for (const member of members) {
    const base = { alertClientId: member.alertClientId, clientName: member.clientName };
    if (member.blocked) { clients.push({ ...base, ok: false, error: member.blocked }); continue; }
    const input = proposalForClient(rule, platforms, member.accounts);
    if (!input) { clients.push({ ...base, ok: false, error: `aucun compte ${platformsText(platforms ?? [])} : ce client n'est pas concerné` }); continue; }
    if (!member.series) { clients.push({ ...base, ok: false, error: FIGURES_UNREADABLE, retry: true }); continue; }
    const checked = validateAlertProposal(input, { accounts: member.accounts, series: member.series });
    if (!checked.ok) { clients.push({ ...base, ok: false, error: checked.errors.join(" "), hints: checked.hints }); continue; }
    let replay: Backtest;
    try {
      replay = backtest(checked.value, member.series, opts);
    } catch (e) {
      console.error("[client-alerts] lot backtest failed", e);
      clients.push({ ...base, ok: false, error: "la vérification sur 30 jours a échoué, réessayez", retry: true });
      continue;
    }
    const verdict = replayVerdict(checked.value, member.series, replay);
    if (verdict.kind === "wait") { clients.push({ ...base, ok: false, error: unread(verdict.unread), retry: true }); continue; }
    if (verdict.kind === "refused") { clients.push({ ...base, ok: false, error: verdict.error }); continue; }
    const noisy = replay.messages.length > NOISY_MESSAGES;
    clients.push({ ...base, ok: true, messages: replay.messages.length, judgedDays: Math.max(0, (replay.checkedDays ?? replay.days) - replay.skippedDays), days: replay.days, noisy });
    accepted.push({ member, definition: checked.value, warnings: checked.warnings, backtest: replay });
  }
  return { lot: { platforms, clients }, accepted };
}

/** Whatever is wrong with every client of the lot, said once for the card and the AI. */
export function lotRefusal(lot: LotCheck): { errors: string[]; hints: string[]; retry: boolean } {
  const errors = lot.clients.map((c) => `${c.clientName} : ${c.error ?? "non vérifiable"}`);
  const hints = [...new Set(lot.clients.flatMap((c) => c.hints ?? []))];
  // Waiting is only right when nothing of it is the rule's fault.
  return { errors, hints, retry: lot.clients.every((c) => c.retry) };
}
