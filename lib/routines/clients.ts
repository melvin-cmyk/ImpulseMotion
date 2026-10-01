/**
 * Routines — the routines that read several clients, on the server: which
 * accounts a run may read, and who may see such a routine.
 *
 * A client is a client of the automatic alerts (AlertClient,
 * lib/auto-alerts/clients.ts): every account the agency reads, with or
 * without a dashboard, Meta, Google and TikTok accounts of one client put
 * together. It is named by its id, which survives a change of key when the
 * list is rebuilt (reconcile). This module only READS that list: it never
 * builds it (syncAlertClients writes, a routine does not).
 *
 * The rule of scope, at EVERY run, scheduled or not:
 *   - an account is read only when it is in the scope (lib/scope.ts) of who
 *     answers for the routine (who activated it, its author otherwise) AND,
 *     for a run started by a person, of that person;
 *   - « all my clients » is resolved at that moment against that scope:
 *     nothing is frozen, a client that left the scope is no longer read;
 *   - an account of a named client that left the scope is skipped, and the
 *     run says so;
 *   - MAX_ACCOUNTS_PER_RUN accounts at most, all steps together.
 *
 * Who may SEE a routine that reads several clients, or a routine without a
 * client (routineVisible):
 *   - a person whose scope is everything (admins; consultants as long as
 *     lib/roles.ts gives them full access) sees every routine;
 *   - the owner (author, or who activated it) sees it;
 *   - another person sees a routine that names its clients when every one of
 *     them is in their scope; never a routine of « all my clients » nor a
 *     free routine of someone else (its Sheets and messages may concern any
 *     client: what the owner sees is not theirs to see).
 */

import { prisma } from "@/lib/prisma";
import { effectiveRole } from "@/lib/roles";
import { clientInScope, parseAlertAccounts, type AlertAccount } from "@/lib/auto-alerts/clients";
import { bindingOutOfScope, getAccountScope, platformAccountInScope, type AccountScope } from "@/lib/scope";
import { definitionClients, isFreeRoutine, storedDefinitionClients } from "@/lib/routines/client-selection";
import {
  CLIENT_COLUMNS, MAX_ACCOUNTS_PER_RUN, type AccountReader, type AdPlatform, type ClientSelection, type RoutineDefinition, type Row,
} from "@/lib/routines/types";

const PLATFORM_NAME: Record<AdPlatform, string> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok Ads" };

interface StoredClient { id: string; name: string; accounts: AlertAccount[]; dormant: boolean }

/** The clients of the alerts that are still there. Read only. */
async function loadClients(ids?: string[]): Promise<StoredClient[]> {
  const rows = await prisma.alertClient.findMany({
    where: { gone: false, ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, name: true, accountsJson: true, dormant: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, accounts: parseAlertAccounts(r.accountsJson), dormant: r.dormant === true }));
}

// ── Who reads ────────────────────────────────────────────────────────────

/** Scope of a person while they are staff; null otherwise (gone, or no longer of the team). */
async function staffScope(userId: string | null | undefined): Promise<AccountScope | null> {
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!user) return null;
  const role = effectiveRole(user.role);
  if (role !== "admin" && role !== "consultant") return null;
  return getAccountScope({ userId: user.id, role });
}

/** A reader over fixed scopes: every one of them must hold the account. */
export function readerOver(scopes: AccountScope[], problem: string | null = null, max = MAX_ACCOUNTS_PER_RUN): AccountReader {
  let left = problem ? 0 : max;
  return {
    problem,
    canRead: (platform, accountId) => !problem && scopes.length > 0 && scopes.every((s) => platformAccountInScope(s, platform, accountId)),
    take(wanted) {
      const granted = Math.max(0, Math.min(left, Math.floor(wanted)));
      left -= granted;
      return granted;
    },
  };
}

/**
 * The reader of one run: scope of who answers for the routine (who activated
 * it, its author otherwise), and of who started the run when it is a person
 * (run by hand, dry run). Read at the start of every run.
 */
export async function accountReaderFor(
  routine: { createdById: string; activatedById?: string | null },
  startedById?: string | null,
): Promise<AccountReader> {
  const ownerId = routine.activatedById || routine.createdById;
  const owner = await staffScope(ownerId);
  if (!owner) return readerOver([], "La personne qui répond de la routine ne fait plus partie de l'équipe : aucun compte client n'est lu.");
  const scopes = [owner];
  if (startedById && startedById !== ownerId) {
    const starter = await staffScope(startedById);
    if (!starter) return readerOver([], "La personne qui a lancé l'exécution ne fait pas partie de l'équipe : aucun compte client n'est lu.");
    scopes.push(starter);
  }
  return readerOver(scopes);
}

// ── What a step reads ────────────────────────────────────────────────────

export interface ClientAccount {
  clientId: string;
  clientName: string;
  platform: AdPlatform;
  accountId: string;
  accountName: string;
  currency: string | null;
}

/**
 * The accounts of one platform a step reads for its selection, in the order
 * of the clients' names, already counted against the ceiling of the run.
 * Nothing outside the reader's scope ever comes out of here.
 */
export async function resolveClientAccounts(
  selection: ClientSelection, platform: AdPlatform, reader: AccountReader,
): Promise<{ accounts: ClientAccount[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (reader.problem) return { accounts: [], warnings: [reader.problem] };
  const all = selection === "all";
  const clients = await loadClients(all ? undefined : selection);
  if (!all) {
    const found = new Set(clients.map((c) => c.id));
    const missing = selection.filter((id) => !found.has(id));
    if (missing.length) warnings.push(`${missing.length} client${missing.length > 1 ? "s" : ""} introuvable${missing.length > 1 ? "s" : ""} (fusionné${missing.length > 1 ? "s" : ""} ou disparu${missing.length > 1 ? "s" : ""}) : ignoré${missing.length > 1 ? "s" : ""}.`);
  }
  const wanted: ClientAccount[] = [];
  const seen = new Set<string>();
  const outside: string[] = [];
  const without: string[] = [];
  for (const client of [...clients].sort((a, b) => a.name.localeCompare(b.name, "fr"))) {
    // « All my clients » leaves out those that spent nothing for ten days: nothing to compare there.
    if (all && client.dormant) continue;
    const mine = client.accounts.filter((a) => a.platform === platform);
    if (!mine.length) { if (!all) without.push(client.name); continue; }
    for (const a of mine) {
      if (seen.has(a.accountId)) continue;
      // The check of scope, account by account. « All »: what is not in scope is simply not one of my clients.
      if (!reader.canRead(platform, a.accountId)) { if (!all) outside.push(`${client.name} (${a.accountId})`); continue; }
      seen.add(a.accountId);
      wanted.push({ clientId: client.id, clientName: client.name, platform, accountId: a.accountId, accountName: a.name, currency: a.currency });
    }
  }
  if (outside.length) warnings.push(`Compte${outside.length > 1 ? "s" : ""} hors du périmètre de la personne qui répond de la routine, non lu${outside.length > 1 ? "s" : ""} : ${outside.slice(0, 10).join(", ")}${outside.length > 10 ? "…" : ""}.`);
  if (without.length) warnings.push(`Sans compte ${PLATFORM_NAME[platform]} : ${without.slice(0, 10).join(", ")}${without.length > 10 ? "…" : ""}.`);
  const granted = reader.take(wanted.length);
  if (granted < wanted.length) {
    warnings.push(`${wanted.length} comptes ${PLATFORM_NAME[platform]} à lire : seuls les ${granted} premiers (ordre alphabétique des clients) sont lus, plafond de ${MAX_ACCOUNTS_PER_RUN} comptes par exécution.`);
  }
  if (all && wanted.length === 0) warnings.push(`Aucun client de votre périmètre n'a de compte ${PLATFORM_NAME[platform]} actif.`);
  return { accounts: wanted.slice(0, granted), warnings };
}

/** Columns of a step that reads several clients: who first, then what the step reads. */
export function withClientColumns(columns: readonly string[]): string[] {
  return [...CLIENT_COLUMNS, ...columns.filter((c) => !(CLIENT_COLUMNS as readonly string[]).includes(c))];
}

/** Who a row belongs to, written over what the platform said (account_id the same on every platform: Meta without « act_ »). */
export function clientCells(a: ClientAccount): Row {
  return { client_name: a.clientName, platform: a.platform, account_id: a.accountId, account_name: a.accountName };
}

/**
 * Reads the accounts one after the other, a few at a time, and stops before
 * the end of the run's budget: what was not read is said. `read` never
 * throws for one account: it says what went wrong.
 */
export async function readEachAccount<T>(
  accounts: ClientAccount[],
  read: (account: ClientAccount) => Promise<T>,
  opts: { deadlineAt: number; signal?: AbortSignal; concurrency?: number; marginMs?: number },
): Promise<{ results: Array<{ account: ClientAccount; result: T }>; unread: number }> {
  const results: Array<{ account: ClientAccount; result: T }> = [];
  let next = 0;
  let unread = 0;
  const margin = opts.marginMs ?? 20_000;
  async function worker() {
    while (next < accounts.length) {
      const account = accounts[next++];
      if (opts.signal?.aborted || Date.now() > opts.deadlineAt - margin) { unread++; continue; }
      results.push({ account, result: await read(account) });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, accounts.length)) }, worker));
  // Same order as the accounts, whatever the order the answers came in.
  const order = new Map(accounts.map((a, i) => [`${a.platform}:${a.accountId}`, i]));
  results.sort((x, y) => (order.get(`${x.account.platform}:${x.account.accountId}`) ?? 0) - (order.get(`${y.account.platform}:${y.account.accountId}`) ?? 0));
  return { results, unread };
}

// ── What a definition names ──────────────────────────────────────────────

/** A client that can be named in `clients`, as the AI that writes the routine is told. */
export interface SelectableClient { id: string; name: string; platforms: AdPlatform[] }

/** The clients in a person's scope, by name, with the platforms they have. */
export async function selectableClients(scope: AccountScope): Promise<SelectableClient[]> {
  const clients = await loadClients();
  return clients
    .filter((c) => c.accounts.length && clientInScope(scope, c.accounts))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"))
    .map((c) => ({ id: c.id, name: c.name, platforms: (["meta", "google", "tiktok"] as const).filter((p) => c.accounts.some((a) => a.platform === p)) }));
}

/** Names of the clients a definition names, for the pages. Unknown ids are left out. */
export async function clientNamesOf(definitionJson: string | null | undefined): Promise<Record<string, string>> {
  const { ids } = storedDefinitionClients(definitionJson);
  if (!ids.length) return {};
  const clients = await loadClients(ids);
  return Object.fromEntries(clients.map((c) => [c.id, c.name]));
}

/**
 * Errors of a definition's clients for the person who applies it: a client
 * that does not exist, or that is not in their scope, is refused. Said in
 * French, handed back to the AI as they are.
 */
export async function clientSelectionErrors(definition: RoutineDefinition, scope: AccountScope): Promise<string[]> {
  const errors: string[] = [];
  for (const [i, step] of definition.steps.entries()) {
    const selection = "clients" in step ? step.clients : undefined;
    if (!selection || selection === "all") continue;
    const clients = new Map((await loadClients(selection)).map((c) => [c.id, c]));
    for (const id of selection) {
      const client = clients.get(id);
      if (!client) errors.push(`Étape ${i + 1} « ${step.id} » (${step.type}) : client « ${id} » inconnu. Reprends l'identifiant dans la liste des clients donnée en fin de prompt.`);
      else if (!client.accounts.length || !clientInScope(scope, client.accounts)) errors.push(`Étape ${i + 1} « ${step.id} » (${step.type}) : le client « ${client.name} » n'est pas dans votre périmètre.`);
    }
  }
  return errors;
}

// ── Who sees a routine ───────────────────────────────────────────────────

type VisibleRoutine = {
  createdById: string; activatedById?: string | null;
  dashboardId?: string | null; metaAccountId: string | null; googleCustomerId: string | null; definitionJson?: string | null;
};

/**
 * True when the person may see the routine, beyond its own accounts (checked
 * by the caller with bindingOutOfScope): the rule of the header of this file.
 * `clients` is the list already loaded, for the list of routines.
 */
export async function routineVisible(
  session: { userId: string }, scope: AccountScope, routine: VisibleRoutine, clients?: StoredClient[],
): Promise<boolean> {
  if (bindingOutOfScope(scope, routine)) return false;
  if (scope.all) return true;
  if (session.userId === routine.createdById || (!!routine.activatedById && session.userId === routine.activatedById)) return true;
  const reads = storedDefinitionClients(routine.definitionJson);
  if (reads.all) return false;
  if (reads.ids.length) {
    const known = clients ?? await loadClients(reads.ids);
    return reads.ids.every((id) => {
      const client = known.find((c) => c.id === id);
      // A client gone is no longer read: it hides nothing.
      return !client || (client.accounts.length > 0 && client.accounts.every((a) => platformAccountInScope(scope, a.platform, a.accountId)));
    });
  }
  return !isFreeRoutine(routine);
}

/** The routines of a list a person may see; the clients are read once for the whole list. */
export async function visibleRoutines<R extends VisibleRoutine>(session: { userId: string }, scope: AccountScope, routines: R[]): Promise<R[]> {
  if (scope.all) return routines.filter((r) => !bindingOutOfScope(scope, r));
  const named = routines.some((r) => storedDefinitionClients(r.definitionJson).ids.length > 0);
  const clients = named ? await loadClients() : [];
  const out: R[] = [];
  for (const r of routines) if (await routineVisible(session, scope, r, clients)) out.push(r);
  return out;
}

/** The definition reads several clients: the engine then makes a reader. */
export const readsSeveralClients = (definition: RoutineDefinition): boolean => definitionClients(definition.steps).multi;
