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
 * Platforms: Meta and Google Ads, through lib/pilot/adapters.ts.
 */

import { prisma } from "@/lib/prisma";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { mintWriteGuard, revokeWriteGuard } from "@/lib/routines/write-guard";
import type { WriteGuard } from "@/lib/routines/types";
import { HQ_PROJECT_RE, appendHqJournal, listHqProjects } from "@/lib/hq-journal";
import { pilotAdapter, type PilotAdapter } from "@/lib/pilot/adapters";
import { checkNewAd, createNewAd } from "@/lib/pilot/new-ad";
import { buildHqEntry, hqEntrySlug } from "@/lib/pilot/hq-entry";
import { readMetaAdTexts, readRsa } from "@/lib/pilot/creative";
import { IMPACT_HORIZONS, IMPACT_SETTLE_DAYS, addDays, impactWindows } from "@/lib/pilot/impact";
import {
  PILOT_DRAFT_TTL_MS, PILOT_MAX_OPERATIONS, PLATFORM_FR, describeOperation, readCopy, readKeyword, readNewAd, doubleReason, inverseRequest, prepareOperation, readGoal, readRequest,
  sameValue, stateValue, type PilotGoal, type PilotObjectState, type PilotRequest, type PilotValue, type PreparedOperation,
} from "@/lib/pilot/ops";

export type PilotSession = { userId: string; role?: string | null; baseRole?: string | null; user?: { email?: string | null; name?: string | null } | null };

type Fail = { ok: false; status: number; error: string; errors?: string[] };

const READ_CONCURRENCY = 4;

const parse = (json: string | null | undefined): PilotValue => {
  try { const v = JSON.parse(json ?? "null"); return typeof v === "string" || typeof v === "number" ? v : null; } catch { return null; }
};

// ── Client and account ────────────────────────────────────────────────────

export async function resolveAccount(session: PilotSession, alertClientId: string, accountId: string, platform: string = "meta") {
  const adapter = pilotAdapter(platform);
  if (!adapter) return { ok: false, status: 400, error: "Plateforme inconnue." } as Fail;
  const client = await prisma.alertClient.findUnique({ where: { id: alertClientId } });
  if (!client || client.gone) return { ok: false, status: 404, error: "Client introuvable." } as Fail;
  const digits = adapter.accountKey(accountId);
  const account = parseAlertAccounts(client.accountsJson).find((a) => a.platform === adapter.platform && adapter.accountKey(a.accountId) === digits);
  if (!digits || !account) return { ok: false, status: 404, error: `Ce compte ${adapter.name} n'est pas rattaché à ce client.` } as Fail;
  const scope = await getAccountScope(session);
  if (!platformAccountInScope(scope, adapter.platform, account.accountId)) return { ok: false, status: 403, error: "Vous n'avez pas accès à ce compte." } as Fail;
  return { ok: true as const, client, adapter, account: { ...account, digits } };
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
  alertClientId: string; accountId: string; platform?: string; requests: unknown; why?: unknown; goal?: unknown; undoOfId?: string | null;
}): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const raw = Array.isArray(input.requests) ? input.requests : [];
  if (!raw.length) return { ok: false, status: 400, error: "Aucune modification demandée." };
  if (raw.length > PILOT_MAX_OPERATIONS) return { ok: false, status: 400, error: `${PILOT_MAX_OPERATIONS} modifications au plus à la fois.` };
  const requests = raw.map(readRequest);
  if (requests.some((r) => !r)) return { ok: false, status: 400, error: "Une modification demandée est illisible : rechargez la page." };
  const list = requests as PilotRequest[];

  const resolved = await resolveAccount(session, input.alertClientId, input.accountId, input.platform ?? "meta");
  if (!resolved.ok) return resolved;
  const { client, account, adapter } = resolved;

  // Each object read once, as the platform holds it now; the currency too (budgets are in its minor units).
  const objects = [...new Map(list.map((r) => [r.objectId, r.objectType])).entries()];
  let states: Map<string, PilotObjectState | null>;
  let currency: string;
  try {
    currency = await adapter.readCurrency(account.digits);
    const read = await mapLimit(objects, READ_CONCURRENCY, async ([id, type]) => [id, await adapter.readObject(account.digits, id, type, currency)] as const);
    states = new Map(read);
  } catch (e) {
    console.error("[pilot] read before preview failed", e);
    return { ok: false, status: 503, error: `${adapter.name} ne répond pas pour le moment (ou limite d'appels atteinte) : rien n'a été préparé. Réessayez dans quelques minutes.` };
  }

  const errors: string[] = [];
  const ops: PreparedOperation[] = [];
  const seen = new Set<string>();
  for (const req of list) {
    const state = states.get(req.objectId);
    if (!state) { errors.push(`L'objet ${req.objectId} est introuvable sur ${adapter.name} (supprimé, ou hors de notre accès).`); continue; }
    if (state.accountId !== account.digits) { errors.push(`« ${state.name} » n'appartient pas au compte ${account.name}.`); continue; }
    const prepared = prepareOperation(req, state, currency, new Date(), adapter.platform);
    if (!prepared.ok) { errors.push(prepared.error); continue; }
    if (prepared.op.field === "copy" || prepared.op.field === "new_keyword" || prepared.op.field === "new_negative" || prepared.op.field === "ad_texts" || prepared.op.field === "rsa") { ops.push(prepared.op); continue; }
    if (prepared.op.field === "new_ad") {
      // The ad set, its campaign, the Page and every field, checked on Meta now; the campaign is kept for the send.
      const read = readNewAd(prepared.op.after);
      const checked = read.ok ? await checkNewAd(account.digits, req.objectId, read.spec) : read;
      if (!checked.ok) { errors.push(`« ${state.name} » : ${checked.error}`); continue; }
      prepared.op.after = JSON.stringify(checked.spec);
      ops.push(prepared.op);
      continue;
    }
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
      alertClientId: client.id, clientName: client.name, platform: adapter.platform,
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
    include: { operations: { orderBy: { position: "asc" } }, impacts: true },
  });
  return { ok: true, action: toActionView(action, session.userId) };
}

// ── Execute ───────────────────────────────────────────────────────────────

/**
 * Live writes are closed until PILOT_WRITES=1 (trial on a test account first,
 * then Melvin opens them); Google Ads also needs PILOT_GOOGLE_WRITES=1 and its
 * n8n flow (lib/pilot/google.ts).
 */
export const pilotWritesOpen = (platform: string = "meta") => pilotAdapter(platform)?.writesOpen() ?? false;

/** A send still `running` after this long was cut short (function killed, timeout): it is closed as such. */
const STALE_RUNNING_MS = 10 * 60 * 1000;

export interface ExecuteOptions {
  /** A scheduled send (status « scheduled », no preview age limit) or a rule's send: run by the cron as the person who prepared it. */
  scheduled?: boolean;
}

export async function executeAction(session: PilotSession, id: string, input: {
  why?: unknown; goal?: unknown; hqProject?: unknown; confirmDouble?: unknown;
}, now: Date = new Date(), opts: ExecuteOptions = {}): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, include: { operations: { orderBy: { position: "asc" } }, impacts: true } });
  if (!action || action.createdById !== session.userId) return { ok: false, status: 404, error: "Modification introuvable." };
  if (!pilotWritesOpen(action.platform)) return { ok: false, status: 403, error: `L'envoi vers ${PLATFORM_FR[action.platform] ?? action.platform} n'est pas encore ouvert : la page est en essai.` };
  if (action.status !== (opts.scheduled ? "scheduled" : "draft")) return { ok: false, status: 409, error: action.status === "scheduled" ? "Cette modification est programmée : annulez la programmation pour l'envoyer maintenant." : "Cette modification a déjà été envoyée." };
  if (!opts.scheduled && now.getTime() - action.createdAt.getTime() > PILOT_DRAFT_TTL_MS) {
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
  const resolved = await resolveAccount(session, action.alertClientId, action.accountId, action.platform);
  if (!resolved.ok) return resolved;
  // A folder other than the client's known one must exist in HQ: a typo never receives a client's changes.
  const known = await hqProjectOf(resolved.client);
  if (hqProject !== known) {
    const projects = await listHqProjects();
    if (!projects) return { ok: false, status: 503, error: "HQ ne répond pas : impossible de vérifier ce dossier. Réessayez dans quelques minutes." };
    if (!projects.some((p) => p.slug === hqProject)) return { ok: false, status: 400, error: `Le dossier HQ « ${hqProject} » n'existe pas.` };
  }

  // Claimed once: a second click, or a second tab, finds it running.
  const goal: PilotGoal = input.goal === undefined ? readGoal(JSON.parse(action.goalJson || "{}")) : readGoal(input.goal);
  const claimed = await prisma.pilotAction.updateMany({
    where: { id, status: opts.scheduled ? "scheduled" : "draft" },
    data: { status: "running", why, goalJson: JSON.stringify(goal), hqProject, executedAt: now },
  });
  if (claimed.count !== 1) return { ok: false, status: 409, error: "Cette modification est déjà en cours d'envoi." };

  try {
    await sendOperations(resolved.adapter, action.id, action.accountId, action.currency, action.operations);
  } catch (e) {
    // Whatever stopped the loop (a database write that failed right after a platform accepted the change…),
    // the outcome of what is left is not known: it may have been applied. Said so, never « non envoyé ».
    console.error("[pilot] send interrupted", action.id, e);
    await prisma.pilotOperation.updateMany({ where: { actionId: id, status: "pending" }, data: { status: "uncertain", error: "Envoi interrompu : vérifiez sur la plateforme si ce changement a été appliqué." } }).catch(() => {});
  }
  await finishAction(id);
  return { ok: true, action: await loadView(id, session.userId) };
}

type OpRow = { id: string; objectId: string; objectType: string; field: string; beforeJson: string; afterJson: string };

/** No write is started past this (the function is cut at 300 s): what is left is said « non envoyé ». */
const SEND_BUDGET_MS = 240_000;

async function sendOperations(adapter: PilotAdapter, actionId: string, accountId: string, currency: string, operations: OpRow[]) {
  const name = adapter.name;
  const started = Date.now();
  const guard = mintWriteGuard("live", actionId);
  let stopped = false;
  try {
    for (const op of operations) {
      if (stopped) { await setOp(op.id, { status: "skipped", error: "Non envoyé : une modification précédente a une issue inconnue." }); continue; }
      if (Date.now() - started > SEND_BUDGET_MS) { await setOp(op.id, { status: "skipped", error: "Non envoyé : temps d'envoi dépassé. Préparez à nouveau ce changement." }); continue; }
      const before = parse(op.beforeJson);
      const after = parse(op.afterJson);
      if (op.field === "new_ad") {
        // A creation: nothing to compare with, the ad set is checked again by createPausedAd.
        const read = readNewAd(after);
        if (!read.ok) { await setOp(op.id, { status: "failed", error: read.error }); continue; }
        const created = await createNewAd(guard, accountId, op.objectId, read.spec);
        if (created.kind === "uncertain") { stopped = true; await setOp(op.id, { status: "uncertain", error: created.error }); continue; }
        if (created.kind === "refused") { await setOp(op.id, { status: "failed", error: created.error }); continue; }
        await setOp(op.id, { status: "done", readBackJson: JSON.stringify(created.adId ?? null), error: null });
        continue;
      }
      if (op.field === "ad_texts") {
        const read = readMetaAdTexts(after);
        if (!read.ok) { await setOp(op.id, { status: "failed", error: read.error }); continue; }
        if (!adapter.rewriteAdTexts) { await setOp(op.id, { status: "failed", error: `${name} ne réécrit pas les textes depuis ImpulseMotion.` }); continue; }
        // The creative shown must still be the one of the preview: a creative changed meanwhile is not overwritten.
        let current: PilotObjectState | null;
        try { current = await adapter.readObject(accountId, op.objectId, "ad", currency); } catch { current = null; }
        const beforeId = (() => { try { return String(JSON.parse(String(before))?.creativeId ?? ""); } catch { return ""; } })();
        if (!current || current.accountId !== accountId) { await setOp(op.id, { status: "failed", error: `Annonce introuvable sur ${name} : rien n'a été envoyé.` }); continue; }
        if (beforeId && current.creativeId && current.creativeId !== beforeId) { await setOp(op.id, { status: "conflict", readBackJson: JSON.stringify(current.creativeId), error: "La créa de l'annonce a changé depuis l'aperçu : rien n'a été envoyé." }); continue; }
        const done = await adapter.rewriteAdTexts(guard, accountId, op.objectId, read.texts);
        if (done.kind === "uncertain") { stopped = true; await setOp(op.id, { status: "uncertain", readBackJson: JSON.stringify(done.creativeId ?? null), error: done.error }); continue; }
        if (done.kind === "refused") { await setOp(op.id, { status: "failed", readBackJson: JSON.stringify(done.creativeId ?? null), error: done.error }); continue; }
        await setOp(op.id, { status: "done", readBackJson: JSON.stringify(done.creativeId ?? null), error: null });
        continue;
      }
      if (op.field === "rsa") {
        const read = readRsa(after);
        if (!read.ok) { await setOp(op.id, { status: "failed", error: read.error }); continue; }
        if (!adapter.replaceRsa) { await setOp(op.id, { status: "failed", error: `${name} n'a pas d'annonces responsives.` }); continue; }
        const done = await adapter.replaceRsa(guard, accountId, op.objectId, read.spec);
        if (done.kind === "uncertain") { stopped = true; await setOp(op.id, { status: "uncertain", readBackJson: JSON.stringify(done.createdId ?? null), error: done.error }); continue; }
        if (done.kind === "refused") { await setOp(op.id, { status: "failed", error: done.error }); continue; }
        await setOp(op.id, { status: "done", readBackJson: JSON.stringify(done.createdId ?? null), error: done.oldPaused === false ? "Nouvelle annonce créée ; l'ancienne était déjà en pause." : null });
        continue;
      }
      if (op.field === "new_keyword" || op.field === "new_negative") {
        const read = readKeyword(after);
        if (!read.ok) { await setOp(op.id, { status: "failed", error: read.error }); continue; }
        if (!adapter.createKeyword) { await setOp(op.id, { status: "failed", error: `${name} n'a pas de mots-clés.` }); continue; }
        const created = await adapter.createKeyword(guard, accountId, op.objectId, read.spec, op.field === "new_negative");
        if (created.kind === "uncertain") { stopped = true; await setOp(op.id, { status: "uncertain", error: created.error }); continue; }
        if (created.kind === "refused") { await setOp(op.id, { status: "failed", error: created.error }); continue; }
        await setOp(op.id, { status: "done", readBackJson: JSON.stringify(created.createdId ?? null), error: null });
        continue;
      }
      if (op.field === "copy") {
        // A copy: the object is read now (its name is what Meta suffixes), then copied paused.
        const read = readCopy(after);
        if (!read.ok) { await setOp(op.id, { status: "failed", error: read.error }); continue; }
        if (!adapter.copyObject) { await setOp(op.id, { status: "failed", error: `${name} ne duplique pas depuis ImpulseMotion.` }); continue; }
        let current: PilotObjectState | null;
        try { current = await adapter.readObject(accountId, op.objectId, op.objectType as PilotObjectState["type"], currency); } catch { current = null; }
        if (!current || current.accountId !== accountId) { await setOp(op.id, { status: "failed", error: `Objet introuvable sur ${name} : rien n'a été envoyé.` }); continue; }
        const copied = await adapter.copyObject(guard, accountId, op.objectId, op.objectType as PilotObjectState["type"], current.name, read.spec.name);
        if (copied.kind === "uncertain") { stopped = true; await setOp(op.id, { status: "uncertain", error: copied.error }); continue; }
        if (copied.kind === "refused") { await setOp(op.id, { status: "failed", error: copied.error }); continue; }
        await setOp(op.id, { status: "done", readBackJson: JSON.stringify(copied.copiedId ?? null), error: null });
        continue;
      }
      let current: PilotObjectState | null;
      try {
        current = await adapter.readObject(accountId, op.objectId, op.objectType as PilotObjectState["type"], currency);
      } catch {
        await setOp(op.id, { status: "failed", error: `${name} ne répond pas (ou limite d'appels atteinte) : rien n'a été envoyé pour ce changement.` });
        continue;
      }
      if (!current || current.accountId !== accountId) { await setOp(op.id, { status: "failed", error: `Objet introuvable sur ${name} : rien n'a été envoyé.` }); continue; }
      const held = stateValue(current, op.field);
      if (sameValue(op.field, held, after)) { await setOp(op.id, { status: "unchanged", readBackJson: JSON.stringify(held), error: `Déjà à cette valeur sur ${name} : rien à envoyer.` }); continue; }
      if (!sameValue(op.field, held, before)) {
        await setOp(op.id, { status: "conflict", readBackJson: JSON.stringify(held), error: `La valeur a changé depuis l'aperçu (${describeValue(op.field, held)}) : rien n'a été envoyé.` });
        continue;
      }
      const outcome = await adapter.writeField(guard, accountId, op.objectId, op.objectType as PilotObjectState["type"], op.field, after as string | number, currency);
      if (outcome.kind === "uncertain") { stopped = true; await setOp(op.id, { status: "uncertain", error: outcome.error }); continue; }
      if (outcome.kind === "refused") { await setOp(op.id, { status: "failed", error: outcome.error }); continue; }
      // Read back: what the platform holds now is what the journal says.
      let check: PilotObjectState | null = null;
      let readFailed = false;
      try { check = await adapter.readObject(accountId, op.objectId, op.objectType as PilotObjectState["type"], currency); } catch { readFailed = true; }
      // Deleted and no longer found (Meta may stop serving a deleted object): gone is what was asked.
      if (!check && !readFailed && after === "DELETED") { await setOp(op.id, { status: "done", readBackJson: JSON.stringify("DELETED"), error: null }); continue; }
      const readBack = check ? stateValue(check, op.field) : null;
      if (check && !sameValue(op.field, readBack, after)) {
        // Not what was asked: the account is not in the state the rest of the action was prepared for.
        stopped = true;
        await setOp(op.id, { status: "uncertain", readBackJson: JSON.stringify(readBack), error: `${name} a accepté, mais la relecture donne une autre valeur : vérifiez dans ${adapter.platform === "google" ? "Google Ads" : "le Gestionnaire de publicités"}.` });
        continue;
      }
      await setOp(op.id, { status: "done", readBackJson: check ? JSON.stringify(readBack) : null, error: check ? null : "Envoyé ; la relecture a échoué." });
    }
  } finally {
    revokeWriteGuard(guard);
  }
}

/** Final status, the undo it completes, and the HQ entry. Safe to run again on an action cut short. */
async function finishAction(id: string) {
  const action = await prisma.pilotAction.findUnique({ where: { id }, include: { operations: { orderBy: { position: "asc" } }, impacts: true } });
  if (!action) return;
  const ops = action.operations;
  const done = ops.filter((o) => o.status === "done").length;
  const settled = done + ops.filter((o) => o.status === "unchanged").length;
  const status = settled === ops.length ? "done" : done === 0 && !ops.some((o) => o.status === "uncertain") ? "failed" : "partial";
  await prisma.pilotAction.update({ where: { id }, data: { status } });
  if (action.undoOfId && settled > 0) await markUndone(action.undoOfId, id);
  // Something was (maybe) changed on the account: HQ keeps it. Nothing sent at all is not written.
  if (ops.some((o) => o.status === "done" || o.status === "uncertain")) await writeHq(id);
}

/** The original action is undone when every change it applied was put back by this one. */
async function markUndone(originalId: string, undoId: string) {
  const [original, undo] = await Promise.all([
    prisma.pilotOperation.findMany({ where: { actionId: originalId }, orderBy: { position: "asc" } }),
    prisma.pilotOperation.findMany({ where: { actionId: undoId }, orderBy: { position: "asc" } }),
  ]);
  const back = new Set(undo.filter((o) => o.status === "done" || o.status === "unchanged").map((o) => `${o.objectId}:${o.field}`));
  if (original.filter((o) => o.status === "done").every((o) => back.has(`${o.objectId}:${o.field}`))) {
    await prisma.pilotAction.updateMany({ where: { id: originalId, undoneById: null }, data: { undoneById: undoId } });
  }
}

/** Sends cut short (function killed, timeout) are closed: what was not confirmed is unknown, and HQ is told. */
export async function recoverStale(now: Date = new Date()) {
  const stale = await prisma.pilotAction.findMany({
    where: { status: "running", executedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
    select: { id: true }, take: 20,
  });
  for (const { id } of stale) {
    await prisma.pilotOperation.updateMany({ where: { actionId: id, status: "pending" }, data: { status: "uncertain", error: "Envoi interrompu : vérifiez dans le Gestionnaire de publicités si ce changement a été appliqué." } });
    await finishAction(id);
  }
}

function describeValue(field: string, value: PilotValue): string {
  return value === null ? "vide" : field === "status" ? String(value).toLowerCase() : String(value);
}

function setOp(id: string, data: { status: string; error?: string | null; readBackJson?: string | null }) {
  return prisma.pilotOperation.update({ where: { id }, data: { ...data, executedAt: new Date() } });
}

// ── HQ ────────────────────────────────────────────────────────────────────

/** Written by one request at a time; a claim older than this was cut short and may be taken again. */
const HQ_CLAIM_MS = 3 * 60 * 1000;
const HQ_WRITING = "Écriture dans HQ en cours…";

export async function writeHq(id: string): Promise<{ ok: boolean; error?: string }> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, include: { operations: { orderBy: { position: "asc" } }, impacts: true } });
  if (!action || !action.hqProject || !action.executedAt) return { ok: false, error: "Rien à consigner." };
  if (action.hqWrittenAt) return { ok: true };
  // One writer: two tabs (or a retry during a slow write) never put the entry twice in HQ.
  const claimed = await prisma.pilotAction.updateMany({
    where: { id, hqWrittenAt: null, OR: [{ hqError: null }, { hqError: { not: HQ_WRITING } }, { updatedAt: { lt: new Date(Date.now() - HQ_CLAIM_MS) } }] },
    data: { hqError: HQ_WRITING },
  });
  if (claimed.count !== 1) return { ok: false, error: HQ_WRITING };
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
  // The folder that received a client's change is its folder from now on.
  if (written.ok && action.alertClientId) {
    await prisma.alertClient.updateMany({ where: { id: action.alertClientId, NOT: { hqSlug: action.hqProject } }, data: { hqSlug: action.hqProject } }).catch(() => {});
  }
  return written.ok ? { ok: true } : { ok: false, error: written.error };
}

export async function retryHq(session: PilotSession, id: string): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, select: { alertClientId: true, accountId: true, platform: true, hqWrittenAt: true, executedAt: true, status: true } });
  if (!action?.alertClientId || !action.executedAt) return { ok: false, status: 404, error: "Modification introuvable." };
  const resolved = await resolveAccount(session, action.alertClientId, action.accountId, action.platform);
  if (!resolved.ok) return resolved;
  if (action.status === "running") return { ok: false, status: 409, error: "L'envoi est encore en cours." };
  if (action.hqWrittenAt) return { ok: true, action: await loadView(id, session.userId) };
  const written = await writeHq(id);
  if (!written.ok) return { ok: false, status: written.error === HQ_WRITING ? 409 : 502, error: written.error ?? "Écriture dans HQ impossible." };
  return { ok: true, action: await loadView(id, session.userId) };
}

// ── Undo ──────────────────────────────────────────────────────────────────

export async function prepareUndo(session: PilotSession, id: string, now: Date = new Date()): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, include: { operations: { orderBy: { position: "asc" } }, impacts: true } });
  if (!action?.alertClientId) return { ok: false, status: 404, error: "Modification introuvable." };
  if (action.undoneById) return { ok: false, status: 409, error: "Cette modification a déjà été annulée." };
  if (action.status !== "done" && action.status !== "partial") return { ok: false, status: 409, error: "Seule une modification envoyée peut être annulée." };
  const applied = action.operations.filter((o) => o.status === "done");
  const adapter = pilotAdapter(action.platform);
  if (!adapter) return { ok: false, status: 400, error: "Plateforme inconnue." };

  // Put back only what still holds the value this action wrote: a later change (here or in Ads Manager) is never overwritten.
  let currents: Array<PilotObjectState | null>;
  try {
    currents = await mapLimit(applied, READ_CONCURRENCY, (o) => adapter.readObject(action.accountId, o.objectId, o.objectType as PilotObjectState["type"], action.currency));
  } catch {
    return { ok: false, status: 503, error: `${adapter.name} ne répond pas pour le moment : réessayez dans quelques minutes.` };
  }
  const requests: PilotRequest[] = [];
  const left: string[] = [];
  applied.forEach((o, i) => {
    const before = parse(o.beforeJson);
    const after = parse(o.afterJson);
    const line = describeOperation({ ...o, before, after }, action.currency, action.platform);
    if (o.field === "new_ad") { left.push(`${line} (ne peut pas être remis : publicité créée en pause, à supprimer depuis l'arbre si besoin)`); return; }
    if (o.field === "copy") { left.push(`${line} (ne peut pas être remis : copie créée en pause, à supprimer depuis l'arbre si besoin)`); return; }
    if (o.field === "new_keyword" || o.field === "new_negative") { left.push(`${line} (ne peut pas être remis : mot-clé ajouté, à supprimer depuis l'arbre si besoin)`); return; }
    if (o.field === "rsa") { left.push(`${line} (ne peut pas être remis automatiquement : réactivez l'ancienne annonce et mettez la nouvelle en pause depuis l'arbre)`); return; }
    if (o.field === "ad_texts") {
      // Put back = the old creative, if the ad still shows the one this action created.
      const current = currents[i];
      const created = parse(o.readBackJson);
      if (!current) { left.push(`${line} (annonce introuvable)`); return; }
      if (created && current.creativeId && String(created) !== current.creativeId) { left.push(`${line} (la créa a changé depuis : ${current.creativeId})`); return; }
      const inverse = inverseRequest({ kind: o.kind, objectType: o.objectType, objectId: o.objectId, field: o.field, before, after }, action.currency);
      if (!inverse) { left.push(`${line} (créa d'origine inconnue)`); return; }
      requests.push(inverse);
      return;
    }
    const current = currents[i];
    if (!current) { left.push(`${line} (objet introuvable)`); return; }
    const held = stateValue(current, o.field);
    if (!sameValue(o.field, held, after)) { left.push(`${line} (modifié depuis : ${describeValue(o.field, held)})`); return; }
    const inverse = inverseRequest({ kind: o.kind, objectType: o.objectType, objectId: o.objectId, field: o.field, before, after }, action.currency);
    const pastDate = (o.field === "end_time" || o.field === "stop_time") && before !== null && new Date(String(before)).getTime() <= now.getTime() + 60 * 60 * 1000;
    if (!inverse || pastDate) { left.push(`${line} (ne peut pas être remis : ${o.field === "new_ad" ? "publicité créée en pause, à supprimer depuis l'arbre si besoin" : after === "DELETED" ? "suppression" : before === null ? "il n'y avait pas de date" : "date d'origine passée"})`); return; }
    requests.push(inverse);
  });
  if (!requests.length) return { ok: false, status: 409, error: "Rien ne peut être remis en place automatiquement.", errors: left };
  const date = (action.executedAt ?? action.createdAt).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
  return prepareAction(session, {
    alertClientId: action.alertClientId, accountId: action.accountId, platform: action.platform, requests,
    why: `Annulation de la modification du ${date} (${action.createdByName}).${left.length ? ` Non remis en place : ${left.join(" ; ")}.` : ""}`,
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
  scheduledAt: string | null; revertAt: string | null; revertedAt: string | null; ruleId: string | null;
  operations: PilotOperationView[];
  /** J+7 and J+14 analyses (lib/pilot/impact-run.ts), computed or not yet. */
  impacts: PilotImpactView[];
}

export interface PilotImpactView {
  horizon: number;
  /** done | skipped | failed | pending (not yet due or not yet computed) */
  status: string;
  verdict: string;
  summary: string;
  computedAt: string | null;
  /** When it will be computed (pending). */
  dueOn: string | null;
  hqWritten: boolean;
  result: unknown;
}

type ActionRow = NonNullable<Awaited<ReturnType<typeof prisma.pilotAction.findUnique>>> & {
  operations: Array<NonNullable<Awaited<ReturnType<typeof prisma.pilotOperation.findUnique>>>>;
  impacts?: Array<NonNullable<Awaited<ReturnType<typeof prisma.pilotImpact.findUnique>>>>;
};

function impactViews(a: ActionRow): PilotImpactView[] {
  const sent = (a.status === "done" || a.status === "partial") && a.executedAt && !a.undoOfId;
  if (!sent) return [];
  return IMPACT_HORIZONS.map((horizon) => {
    const row = a.impacts?.find((i) => i.horizon === horizon);
    const settled = addDays(impactWindows(a.executedAt!, horizon).after.until, IMPACT_SETTLE_DAYS + 1);
    if (!row || row.status === "failed") {
      return { horizon, status: "pending", verdict: "", summary: "", computedAt: null, dueOn: settled, hqWritten: false, result: null };
    }
    let result: unknown = null;
    try { result = JSON.parse(row.resultJson); } catch { result = null; }
    return { horizon, status: row.status, verdict: row.verdict, summary: row.summary, computedAt: row.computedAt.toISOString(), dueOn: null, hqWritten: !!row.hqWrittenAt, result };
  });
}

export function toActionView(a: ActionRow, viewerId: string): PilotActionView {
  const ops = a.operations.map((o) => {
    const before = parse(o.beforeJson);
    const after = parse(o.afterJson);
    const double = doubleReason({ objectType: o.objectType, field: o.field, before, after }, a.currency);
    return {
      id: o.id, kind: o.kind, objectType: o.objectType, objectId: o.objectId, objectName: o.objectName, parentName: o.parentName,
      field: o.field, before, after, readBack: parse(o.readBackJson), status: o.status, error: o.error,
      line: describeOperation({ ...o, before, after }, a.currency, a.platform),
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
    scheduledAt: a.scheduledAt?.toISOString() ?? null, revertAt: a.revertAt?.toISOString() ?? null, revertedAt: a.revertedAt?.toISOString() ?? null, ruleId: a.ruleId,
    operations: ops,
    impacts: impactViews(a),
  };
}

async function loadView(id: string, viewerId: string): Promise<PilotActionView> {
  const a = await prisma.pilotAction.findUniqueOrThrow({ where: { id }, include: { operations: { orderBy: { position: "asc" } }, impacts: true } });
  return toActionView(a, viewerId);
}

/** The journal: sent actions (and the viewer's own drafts) of a client, or of every client in scope. */
export async function listActions(session: PilotSession, opts: { alertClientId?: string | null; take?: number }): Promise<PilotActionView[]> {
  await recoverStale().catch((e) => console.error("[pilot] stale sends not recovered", e));
  const scope = await getAccountScope(session);
  const rows = await prisma.pilotAction.findMany({
    where: {
      ...(opts.alertClientId ? { alertClientId: opts.alertClientId } : {}),
      OR: [{ status: { notIn: ["draft", "expired"] } }, { status: "draft", createdById: session.userId }],
    },
    orderBy: { createdAt: "desc" },
    // Read wider than asked when the scope filters: the person's clients may not be among the latest actions.
    take: scope.all ? Math.min(opts.take ?? 50, 200) : 500,
    include: { operations: { orderBy: { position: "asc" } }, impacts: true },
  });
  return rows.filter((r) => platformAccountInScope(scope, r.platform, r.accountId)).slice(0, Math.min(opts.take ?? 50, 200)).map((r) => toActionView(r, session.userId));
}

/** A guard for a side effect of Pilotage (a rule's Slack word): minted here, as every guard is, revoked after. */
export async function withPilotGuard<T>(key: string, fn: (guard: WriteGuard) => Promise<T>): Promise<T> {
  const guard = mintWriteGuard("live", key);
  try { return await fn(guard); } finally { revokeWriteGuard(guard); }
}

// ── Scheduled sends and automatic reverts ─────────────────────────────────

/** A send can be planned this far ahead; a revert this long after the send. */
const SCHEDULE_MAX_DAYS = 60;

/**
 * The preview is kept and sent later by the cron (status « scheduled »), as
 * the person who prepared it, with the reason, the folder and the second
 * confirmation given now. `revertAt`: the cron then puts it back at that time.
 */
export async function scheduleAction(session: PilotSession, id: string, input: {
  why?: unknown; goal?: unknown; hqProject?: unknown; confirmDouble?: unknown; scheduledAt?: unknown; revertAt?: unknown;
}, now: Date = new Date()): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, include: { operations: { orderBy: { position: "asc" } }, impacts: true } });
  if (!action || action.createdById !== session.userId) return { ok: false, status: 404, error: "Modification introuvable." };
  if (action.status !== "draft") return { ok: false, status: 409, error: "Seul un aperçu non envoyé se programme." };
  if (!pilotWritesOpen(action.platform)) return { ok: false, status: 403, error: `L'envoi vers ${PLATFORM_FR[action.platform] ?? action.platform} n'est pas encore ouvert.` };
  const scheduledAt = input.scheduledAt ? new Date(String(input.scheduledAt)) : null;
  const revertAt = input.revertAt ? new Date(String(input.revertAt)) : null;
  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) return { ok: false, status: 400, error: "Date d'envoi invalide." };
  if (scheduledAt.getTime() < now.getTime() + 5 * 60 * 1000) return { ok: false, status: 400, error: "L'envoi programmé doit être dans plus de cinq minutes (sinon envoyez maintenant)." };
  if (scheduledAt.getTime() > now.getTime() + SCHEDULE_MAX_DAYS * 86_400_000) return { ok: false, status: 400, error: `L'envoi se programme ${SCHEDULE_MAX_DAYS} jours à l'avance au plus.` };
  if (revertAt && (Number.isNaN(revertAt.getTime()) || revertAt.getTime() <= scheduledAt.getTime() + 30 * 60 * 1000)) return { ok: false, status: 400, error: "Le retour en arrière doit être au moins trente minutes après l'envoi." };
  if (revertAt && revertAt.getTime() > scheduledAt.getTime() + SCHEDULE_MAX_DAYS * 86_400_000) return { ok: false, status: 400, error: `Le retour en arrière se programme ${SCHEDULE_MAX_DAYS} jours après l'envoi au plus.` };
  if (revertAt && action.operations.some((o) => o.field === "new_ad" || o.field === "copy" || o.field === "rsa" || o.field === "new_keyword" || o.field === "new_negative" || JSON.parse(o.afterJson) === "DELETED")) return { ok: false, status: 400, error: "Une création ou une suppression ne se remet pas en arrière automatiquement : programmez l'envoi sans retour." };
  const why = typeof input.why === "string" ? input.why.trim().slice(0, 2000) : action.why;
  if (why.length < 3) return { ok: false, status: 400, error: "Dites en quelques mots pourquoi vous faites cette modification : c'est ce qui sera écrit dans HQ." };
  const hqProject = typeof input.hqProject === "string" && input.hqProject ? input.hqProject : action.hqProject;
  if (!hqProject || !HQ_PROJECT_RE.test(hqProject)) return { ok: false, status: 400, error: "Choisissez le dossier HQ du client." };
  if (action.needsDouble && input.confirmDouble !== true) return { ok: false, status: 409, error: "Cette modification demande une seconde confirmation." };
  if (!action.alertClientId) return { ok: false, status: 404, error: "Client introuvable." };
  const resolved = await resolveAccount(session, action.alertClientId, action.accountId, action.platform);
  if (!resolved.ok) return resolved;
  const goal: PilotGoal = input.goal === undefined ? readGoal(JSON.parse(action.goalJson || "{}")) : readGoal(input.goal);
  const claimed = await prisma.pilotAction.updateMany({ where: { id, status: "draft" }, data: { status: "scheduled", why, goalJson: JSON.stringify(goal), hqProject, scheduledAt, revertAt } });
  if (claimed.count !== 1) return { ok: false, status: 409, error: "Cette modification n'est plus un aperçu." };
  return { ok: true, action: await loadView(id, session.userId) };
}

export async function cancelSchedule(session: PilotSession, id: string): Promise<{ ok: true; action: PilotActionView } | Fail> {
  const action = await prisma.pilotAction.findUnique({ where: { id }, select: { createdById: true, status: true, revertAt: true, revertedAt: true } });
  if (!action || action.createdById !== session.userId) return { ok: false, status: 404, error: "Modification introuvable." };
  if (action.status === "scheduled") {
    await prisma.pilotAction.updateMany({ where: { id, status: "scheduled" }, data: { status: "cancelled" } });
    return { ok: true, action: await loadView(id, session.userId) };
  }
  // A sent action waiting for its automatic revert: the revert alone is cancelled.
  if ((action.status === "done" || action.status === "partial") && action.revertAt && !action.revertedAt) {
    await prisma.pilotAction.update({ where: { id }, data: { revertAt: null } });
    return { ok: true, action: await loadView(id, session.userId) };
  }
  return { ok: false, status: 409, error: "Rien à annuler sur cette modification." };
}

export interface ScheduledPassSummary { sent: number; reverted: number; failed: number; left: number }

/** The cron: sends what is due, puts back what is due, as the people who prepared them. */
export async function runScheduledActions(now: Date = new Date(), budgetMs = 120_000): Promise<ScheduledPassSummary> {
  const started = Date.now();
  const summary: ScheduledPassSummary = { sent: 0, reverted: 0, failed: 0, left: 0 };
  const due = await prisma.pilotAction.findMany({ where: { status: "scheduled", scheduledAt: { lte: now } }, orderBy: { scheduledAt: "asc" }, take: 20, select: { id: true, createdById: true, why: true, hqProject: true, scheduledAt: true } });
  for (const [i, a] of due.entries()) {
    if (Date.now() - started > budgetMs) { summary.left += due.length - i; break; }
    // Too late by more than a day (cron down): not sent blindly, the consultant is told through the journal.
    if (a.scheduledAt && now.getTime() - a.scheduledAt.getTime() > 86_400_000) {
      await prisma.pilotAction.update({ where: { id: a.id }, data: { status: "cancelled", hqError: "Envoi programmé manqué de plus d'un jour : non envoyé." } });
      summary.failed++;
      continue;
    }
    const out = await executeAction({ userId: a.createdById }, a.id, { why: a.why, hqProject: a.hqProject, confirmDouble: true }, now, { scheduled: true });
    if (out.ok) summary.sent++; else { summary.failed++; await prisma.pilotAction.updateMany({ where: { id: a.id, status: "scheduled" }, data: { status: "cancelled", hqError: `Envoi programmé refusé : ${out.error}` } }); }
  }
  const reverts = await prisma.pilotAction.findMany({ where: { status: { in: ["done", "partial"] }, revertAt: { lte: now }, revertedAt: null, undoneById: null }, orderBy: { revertAt: "asc" }, take: 20, select: { id: true, createdById: true, hqProject: true } });
  for (const [i, a] of reverts.entries()) {
    if (Date.now() - started > budgetMs) { summary.left += reverts.length - i; break; }
    const session = { userId: a.createdById };
    const undo = await prepareUndo(session, a.id, now);
    if (!undo.ok) { summary.failed++; await prisma.pilotAction.update({ where: { id: a.id }, data: { revertedAt: now, hqError: `Retour programmé impossible : ${undo.error}${undo.errors?.length ? ` (${undo.errors.join(" ; ")})` : ""}` } }); continue; }
    const sent = await executeAction(session, undo.action.id, { why: `${undo.action.why} Retour programmé.`, hqProject: a.hqProject, confirmDouble: true }, now);
    await prisma.pilotAction.update({ where: { id: a.id }, data: { revertedAt: now, ...(sent.ok ? {} : { hqError: `Retour programmé refusé : ${sent.error}` }) } });
    if (sent.ok) summary.reverted++; else summary.failed++;
  }
  return summary;
}
