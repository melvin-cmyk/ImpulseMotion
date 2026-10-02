/**
 * Pilotage — a change on an ad account, from the preview to HQ.
 *
 *   prepare  the requests are checked against the objects as Meta holds them
 *            now; the action is saved as a draft with, for each change, the
 *            value before and the value after. Nothing is sent.
 *   execute  by the person who prepared it, within PILOT_DRAFT_TTL_MS, with a
 *            reason, the HQ folder and — when the preview asked for it — the
 *            second confirmation. Each object is read again: a value that moved
 *            since the preview is not overwritten (`conflict`). Each write is
 *            read back. An unknown outcome stops what is left.
 *   HQ       the entry (who, what, before → after, why) is appended to the
 *            client's HQ journal; a failure is kept and can be written again.
 *   undo     a new draft that puts back what was applied (not a deletion).
 *
 * Access: staff (requireStaff in the routes), on the accounts of their scope.
 */

import { prisma } from "@/lib/prisma";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { metaAccountDigits } from "@/lib/routines/accounts";
import { mintWriteGuard, revokeWriteGuard } from "@/lib/routines/write-guard";
import { HQ_PROJECT_RE, appendHqJournal } from "@/lib/hq-journal";
import { readObject, writeField } from "@/lib/pilot/meta";
import { buildHqEntry, hqEntrySlug } from "@/lib/pilot/hq-entry";
import {
  PILOT_DRAFT_TTL_MS, PILOT_MAX_OPERATIONS, describeOperation, doubleReason, inverseRequest, prepareOperation, readGoal, readRequest,
  sameValue, stateValue, type PilotGoal, type PilotObjectState, type PilotRequest, type PilotValue, type PreparedOperation,
} from "@/lib/pilot/ops";

export type PilotSession = { userId: string; role?: string | null; baseRole?: string | null; user?: { email?: string | null; name?: string | null } | null };

type Fail = { ok: false; status: number; error: string; errors?: string[] };

const READ_CONCURRENCY = 4;

const parse = (json: string | null | undefined): PilotValue => {
  try { const v = JSON.parse(json ?? "null"); return typeof v === "string" || typeof v === "number" ? v : null; } catch { return null; }
};

// ── Client and account ────────────────────────────────────────────────────

export async function resolveAccount(session: PilotSession, alertClientId: string, accountId: string) {
  const client = await prisma.alertClient.findUnique({ where: { id: alertClientId } });
  if (!client || client.gone) return { ok: false, status: 404, error: "Client introuvable." } as Fail;
  const digits = metaAccountDigits(accountId);
  const account = parseAlertAccounts(client.accountsJson).find((a) => a.platform === "meta" && metaAccountDigits(a.accountId) === digits);
  if (!digits || !account) return { ok: false, status: 404, error: "Ce compte Meta n'est pas rattaché à ce client." } as Fail;
  const scope = await getAccountScope(session);
  if (!platformAccountInScope(scope, "meta", account.accountId)) return { ok: false, status: 403, error: "Vous n'avez pas accès à ce compte." } as Fail;
  return { ok: true as const, client, account: { ...account, digits } };
}

/** The HQ folder of the client: chosen in Pilotage before, else the one of its dashboard. */
export async function hqProjectOf(client: { hqSlug: string | null; dashboardId: string | null }): Promise<string | null> {
  if (client.hqSlug) return client.hqSlug;
  if (!client.dashboardId) return null;
  const d = await prisma.dashboard.findUnique({ where: { id: client.dashboardId }, select: { hqSlug: true } });
  return d?.hqSlug ?? null;
}

async function authorOf(session: PilotSession): Promise<{ name: string; email: string | null }> {
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { name: true, email: true } });
  const email = user?.email ?? session.user?.email ?? null;
  const name = (user?.name ?? session.user?.name ?? "").trim() || email || "Consultant inconnu";
  return { name, email };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── Prepare ───────────────────────────────────────────────────────────────

export async function prepareAction(session: PilotSession, input: {
  alertClientId: string; accountId: string; requests: unknown; why?: unknown; goal?: unknown; undoOfId?: string | null;
}): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const raw = Array.isArray(input.requests) ? input.requests : [];
  if (!raw.length) return { ok: false, status: 400, error: "Aucune modification demandée." };
  if (raw.length > PILOT_MAX_OPERATIONS) return { ok: false, status: 400, error: `${PILOT_MAX_OPERATIONS} modifications au plus à la fois.` };
  const requests = raw.map(readRequest);
  if (requests.some((r) => !r)) return { ok: false, status: 400, error: "Une modification demandée est illisible : rechargez la page." };
  const list = requests as PilotRequest[];

  const resolved = await resolveAccount(session, input.alertClientId, input.accountId);
  if (!resolved.ok) return resolved;
  const { client, account } = resolved;
  const currency = account.currency || "EUR";

  // Each object read once, as Meta holds it now.
  const objects = [...new Map(list.map((r) => [r.objectId, r.objectType])).entries()];
  let states: Map<string, PilotObjectState | null>;
  try {
    const read = await mapLimit(objects, READ_CONCURRENCY, async ([id, type]) => [id, await readObject(id, type)] as const);
    states = new Map(read);
  } catch (e) {
    console.error("[pilot] read before preview failed", e);
    return { ok: false, status: 503, error: "Meta ne répond pas pour le moment : rien n'a été préparé. Réessayez dans quelques minutes." };
  }

  const errors: string[] = [];
  const ops: PreparedOperation[] = [];
  const seen = new Set<string>();
  for (const req of list) {
    const state = states.get(req.objectId);
    if (!state) { errors.push(`L'objet ${req.objectId} est introuvable sur Meta (supprimé ?).`); continue; }
    if (state.accountId !== account.digits) { errors.push(`« ${state.name} » n'appartient pas au compte ${account.name}.`); continue; }
    const prepared = prepareOperation(req, state, currency);
    if (!prepared.ok) { errors.push(prepared.error); continue; }
    const key = `${prepared.op.objectId}:${prepared.op.field}`;
    if (seen.has(key)) { errors.push(`Deux changements du même réglage sur « ${state.name} » : gardez-en un seul.`); continue; }
    seen.add(key);
    ops.push(prepared.op);
  }
  // A deleted object takes no other change in the same action.
  for (const op of ops) {
    if (op.after === "DELETED" && ops.some((o) => o !== op && o.objectId === op.objectId)) errors.push(`« ${op.objectName} » est supprimé : retirez ses autres changements.`);
  }
  if (errors.length) return { ok: false, status: 422, error: "Certaines modifications ne peuvent pas être faites : rien n'a été préparé.", errors };

  const author = await authorOf(session);
  const goal = readGoal(input.goal);
  const action = await prisma.pilotAction.create({
    data: {
      alertClientId: client.id, clientName: client.name, platform: "meta",
      accountId: account.digits, accountName: account.name ?? "", currency,
      createdById: session.userId, createdByName: author.name, createdByEmail: author.email,
      why: typeof input.why === "string" ? input.why.trim().slice(0, 2000) : "",
      goalJson: JSON.stringify(goal),
      needsDouble: ops.some((o) => o.double),
      hqProject: await hqProjectOf(client),
      undoOfId: input.undoOfId ?? null,
      operations: {
        create: ops.map((op, position) => ({
          position, kind: op.kind, objectType: op.objectType, objectId: op.objectId, objectName: op.objectName, parentName: op.parentName,
          field: op.field, beforeJson: JSON.stringify(op.before), afterJson: JSON.stringify(op.after),
        })),
      },
    },
    include: { operations: { orderBy: { position: "asc" } } },
  });
  return { ok: true, action: toActionView(action, session.userId) };
}

// ── Execute ───────────────────────────────────────────────────────────────

export async function executeAction(session: PilotSession, id: string, input: {
  why?: unknown; goal?: unknown; hqProject?: unknown; confirmDouble?: unknown;
}, now: Date = new Date()): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, include: { operations: { orderBy: { position: "asc" } } } });
  if (!action || action.createdById !== session.userId) return { ok: false, status: 404, error: "Modification introuvable." };
  if (action.status !== "draft") return { ok: false, status: 409, error: "Cette modification a déjà été envoyée." };
  if (now.getTime() - action.createdAt.getTime() > PILOT_DRAFT_TTL_MS) {
    await prisma.pilotAction.updateMany({ where: { id, status: "draft" }, data: { status: "expired" } });
    return { ok: false, status: 409, error: "L'aperçu a plus de 30 minutes : préparez-le à nouveau, le compte a pu changer." };
  }
  const why = typeof input.why === "string" ? input.why.trim().slice(0, 2000) : action.why;
  if (why.length < 3) return { ok: false, status: 400, error: "Dites en quelques mots pourquoi vous faites cette modification : c'est ce qui sera écrit dans HQ." };
  const hqProject = typeof input.hqProject === "string" && input.hqProject ? input.hqProject : action.hqProject;
  if (!hqProject || !HQ_PROJECT_RE.test(hqProject)) return { ok: false, status: 400, error: "Choisissez le dossier HQ du client : la modification y sera consignée." };
  if (action.needsDouble && input.confirmDouble !== true) return { ok: false, status: 409, error: "Cette modification demande une seconde confirmation." };

  // The account may have left the person's scope since the preview.
  if (!action.alertClientId) return { ok: false, status: 404, error: "Client introuvable." };
  const resolved = await resolveAccount(session, action.alertClientId, action.accountId);
  if (!resolved.ok) return resolved;

  // Claimed once: a second click, or a second tab, finds it running.
  const goal: PilotGoal = input.goal === undefined ? readGoal(JSON.parse(action.goalJson || "{}")) : readGoal(input.goal);
  const claimed = await prisma.pilotAction.updateMany({
    where: { id, status: "draft" },
    data: { status: "running", why, goalJson: JSON.stringify(goal), hqProject, executedAt: now },
  });
  if (claimed.count !== 1) return { ok: false, status: 409, error: "Cette modification est déjà en cours d'envoi." };
  if (resolved.client.hqSlug !== hqProject) {
    await prisma.alertClient.update({ where: { id: resolved.client.id }, data: { hqSlug: hqProject } }).catch(() => {});
  }

  const guard = mintWriteGuard("live", action.id);
  let stopped = false;
  try {
    for (const op of action.operations) {
      if (stopped) { await setOp(op.id, { status: "skipped", error: "Non envoyé : une modification précédente a une issue inconnue." }); continue; }
      const before = parse(op.beforeJson);
      const after = parse(op.afterJson);
      let current: PilotObjectState | null;
      try {
        current = await readObject(op.objectId, op.objectType as PilotObjectState["type"]);
      } catch {
        await setOp(op.id, { status: "failed", error: "Meta ne répond pas : rien n'a été envoyé pour ce changement." });
        continue;
      }
      if (!current || current.accountId !== action.accountId) { await setOp(op.id, { status: "failed", error: "Objet introuvable sur Meta : rien n'a été envoyé." }); continue; }
      const held = stateValue(current, op.field);
      if (sameValue(op.field, held, after)) { await setOp(op.id, { status: "unchanged", readBackJson: JSON.stringify(held), error: "Déjà à cette valeur sur Meta : rien à envoyer." }); continue; }
      if (!sameValue(op.field, held, before)) {
        await setOp(op.id, { status: "conflict", readBackJson: JSON.stringify(held), error: `La valeur a changé depuis l'aperçu (${describeValue(op.field, held)}) : rien n'a été envoyé.` });
        continue;
      }
      const outcome = await writeField(guard, op.objectId, op.field, after as string | number);
      if (outcome.kind === "uncertain") { stopped = true; await setOp(op.id, { status: "uncertain", error: outcome.error }); continue; }
      if (outcome.kind === "refused") { await setOp(op.id, { status: "failed", error: outcome.error }); continue; }
      // Read back: what Meta holds now is what the journal says.
      let check: PilotObjectState | null = null;
      try { check = await readObject(op.objectId, op.objectType as PilotObjectState["type"]); } catch { check = null; }
      const readBack = check ? stateValue(check, op.field) : null;
      if (check && !sameValue(op.field, readBack, after)) {
        await setOp(op.id, { status: "uncertain", readBackJson: JSON.stringify(readBack), error: "Meta a accepté, mais la relecture donne une autre valeur : vérifiez dans le Gestionnaire de publicités." });
        continue;
      }
      await setOp(op.id, { status: "done", readBackJson: check ? JSON.stringify(readBack) : null, error: check ? null : "Envoyé ; la relecture a échoué." });
    }
  } finally {
    revokeWriteGuard(guard);
  }

  const ops = await prisma.pilotOperation.findMany({ where: { actionId: id }, orderBy: { position: "asc" } });
  const done = ops.filter((o) => o.status === "done").length;
  const settled = done + ops.filter((o) => o.status === "unchanged").length;
  const status = settled === ops.length ? "done" : done === 0 && !ops.some((o) => o.status === "uncertain") ? "failed" : "partial";
  await prisma.pilotAction.update({ where: { id }, data: { status } });
  if (action.undoOfId && done > 0) {
    await prisma.pilotAction.updateMany({ where: { id: action.undoOfId, undoneById: null }, data: { undoneById: id } });
  }
  // Something was (maybe) changed on the account: HQ keeps it. Nothing sent at all is not written.
  if (ops.some((o) => o.status === "done" || o.status === "uncertain")) await writeHq(id);
  return { ok: true, action: await loadView(id, session.userId) };
}

function describeValue(field: string, value: PilotValue): string {
  return value === null ? "vide" : field === "status" ? String(value).toLowerCase() : String(value);
}

function setOp(id: string, data: { status: string; error?: string | null; readBackJson?: string | null }) {
  return prisma.pilotOperation.update({ where: { id }, data: { ...data, executedAt: new Date() } });
}

// ── HQ ────────────────────────────────────────────────────────────────────

export async function writeHq(id: string): Promise<{ ok: boolean; error?: string }> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, include: { operations: { orderBy: { position: "asc" } } } });
  if (!action || !action.hqProject || !action.executedAt) return { ok: false, error: "Rien à consigner." };
  const undoOf = action.undoOfId ? await prisma.pilotAction.findUnique({ where: { id: action.undoOfId }, select: { executedAt: true, createdAt: true, createdByName: true } }) : null;
  const content = buildHqEntry({
    id: action.id, clientName: action.clientName, platform: action.platform, accountName: action.accountName, accountId: action.accountId,
    currency: action.currency, authorName: action.createdByName, authorEmail: action.createdByEmail, executedAt: action.executedAt,
    why: action.why, goal: readGoal(JSON.parse(action.goalJson || "{}")),
    undoOf: undoOf ? { date: undoOf.executedAt ?? undoOf.createdAt, author: undoOf.createdByName } : null,
    operations: action.operations.map((o) => ({
      kind: o.kind, objectType: o.objectType, objectName: o.objectName, parentName: o.parentName, field: o.field,
      before: parse(o.beforeJson), after: parse(o.afterJson), status: o.status, error: o.error,
    })),
  });
  const written = await appendHqJournal({ project: action.hqProject, slug: hqEntrySlug({ id: action.id, executedAt: action.executedAt }), content });
  await prisma.pilotAction.update({
    where: { id },
    data: written.ok ? { hqWrittenAt: new Date(), hqError: null } : { hqError: written.error },
  });
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}

export async function retryHq(session: PilotSession, id: string): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, select: { alertClientId: true, accountId: true, hqWrittenAt: true, executedAt: true } });
  if (!action?.alertClientId || !action.executedAt) return { ok: false, status: 404, error: "Modification introuvable." };
  const resolved = await resolveAccount(session, action.alertClientId, action.accountId);
  if (!resolved.ok) return resolved;
  if (action.hqWrittenAt) return { ok: true, action: await loadView(id, session.userId) };
  const written = await writeHq(id);
  if (!written.ok) return { ok: false, status: 502, error: written.error ?? "Écriture dans HQ impossible." };
  return { ok: true, action: await loadView(id, session.userId) };
}

// ── Undo ──────────────────────────────────────────────────────────────────

export async function prepareUndo(session: PilotSession, id: string): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, include: { operations: { orderBy: { position: "asc" } } } });
  if (!action?.alertClientId) return { ok: false, status: 404, error: "Modification introuvable." };
  if (action.undoneById) return { ok: false, status: 409, error: "Cette modification a déjà été annulée." };
  if (action.status !== "done" && action.status !== "partial") return { ok: false, status: 409, error: "Seule une modification envoyée peut être annulée." };
  const requests = action.operations
    .filter((o) => o.status === "done")
    .map((o) => inverseRequest({ kind: o.kind, objectType: o.objectType, objectId: o.objectId, field: o.field, before: parse(o.beforeJson), after: parse(o.afterJson) }, action.currency))
    .filter((r): r is PilotRequest => !!r);
  if (!requests.length) return { ok: false, status: 409, error: "Rien à remettre en place : une suppression ne s'annule pas." };
  const date = (action.executedAt ?? action.createdAt).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
  return prepareAction(session, {
    alertClientId: action.alertClientId, accountId: action.accountId, requests,
    why: `Annulation de la modification du ${date} (${action.createdByName}).`,
    goal: { metric: null, target: null, note: "" }, undoOfId: action.id,
  });
}

// ── Views ─────────────────────────────────────────────────────────────────

export interface PilotOperationView {
  id: string; kind: string; objectType: string; objectId: string; objectName: string; parentName: string; field: string;
  before: PilotValue; after: PilotValue; readBack: PilotValue; status: string; error: string | null;
  line: string; double: string | null; irreversible: boolean;
}

export interface PilotActionView {
  id: string; alertClientId: string | null; clientName: string; platform: string; accountId: string; accountName: string; currency: string;
  createdByName: string; createdByEmail: string | null; mine: boolean; status: string; why: string; goal: PilotGoal;
  needsDouble: boolean; doubleReasons: string[]; hqProject: string | null; hqWrittenAt: string | null; hqError: string | null;
  undoOfId: string | null; undoneById: string | null; executedAt: string | null; createdAt: string; expiresAt: string | null;
  operations: PilotOperationView[];
}

type ActionRow = NonNullable<Awaited<ReturnType<typeof prisma.pilotAction.findUnique>>> & {
  operations: Array<NonNullable<Awaited<ReturnType<typeof prisma.pilotOperation.findUnique>>>>;
};

export function toActionView(a: ActionRow, viewerId: string): PilotActionView {
  const ops = a.operations.map((o) => {
    const before = parse(o.beforeJson);
    const after = parse(o.afterJson);
    const double = doubleReason({ objectType: o.objectType, field: o.field, before, after }, a.currency);
    return {
      id: o.id, kind: o.kind, objectType: o.objectType, objectId: o.objectId, objectName: o.objectName, parentName: o.parentName,
      field: o.field, before, after, readBack: parse(o.readBackJson), status: o.status, error: o.error,
      line: describeOperation({ ...o, before, after }, a.currency),
      double, irreversible: after === "DELETED",
    };
  });
  return {
    id: a.id, alertClientId: a.alertClientId, clientName: a.clientName, platform: a.platform, accountId: a.accountId, accountName: a.accountName,
    currency: a.currency, createdByName: a.createdByName, createdByEmail: a.createdByEmail, mine: a.createdById === viewerId,
    status: a.status, why: a.why, goal: readGoal(JSON.parse(a.goalJson || "{}")),
    needsDouble: a.needsDouble, doubleReasons: [...new Set(ops.map((o) => o.double).filter((d): d is string => !!d))],
    hqProject: a.hqProject, hqWrittenAt: a.hqWrittenAt?.toISOString() ?? null, hqError: a.hqError,
    undoOfId: a.undoOfId, undoneById: a.undoneById, executedAt: a.executedAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString(),
    expiresAt: a.status === "draft" ? new Date(a.createdAt.getTime() + PILOT_DRAFT_TTL_MS).toISOString() : null,
    operations: ops,
  };
}

async function loadView(id: string, viewerId: string): Promise<PilotActionView> {
  const a = await prisma.pilotAction.findUniqueOrThrow({ where: { id }, include: { operations: { orderBy: { position: "asc" } } } });
  return toActionView(a, viewerId);
}

/** The journal: sent actions (and the viewer's own drafts) of a client, or of every client in scope. */
export async function listActions(session: PilotSession, opts: { alertClientId?: string | null; take?: number }): Promise<PilotActionView[]> {
  const scope = await getAccountScope(session);
  const rows = await prisma.pilotAction.findMany({
    where: {
      ...(opts.alertClientId ? { alertClientId: opts.alertClientId } : {}),
      OR: [{ status: { notIn: ["draft", "expired"] } }, { status: "draft", createdById: session.userId }],
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.take ?? 50, 200),
    include: { operations: { orderBy: { position: "asc" } } },
  });
  return rows.filter((r) => platformAccountInScope(scope, r.platform, r.accountId)).map((r) => toActionView(r, session.userId));
}
