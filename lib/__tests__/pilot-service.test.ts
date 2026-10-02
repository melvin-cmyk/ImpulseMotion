/**
 * Pilotage service, end to end against fakes: an in-memory database, Meta as
 * a map of objects (reads and writes), HQ as a list of entries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PilotObjectState } from "@/lib/pilot/ops";

type Row = Record<string, unknown> & { id: string };

const actions: Row[] = [];
const operations: Row[] = [];
const clients: Row[] = [];
const dashboards: Row[] = [];
const users: Row[] = [];
const hqEntries: Array<{ project: string; slug: string; content: string }> = [];
const metaObjects = new Map<string, PilotObjectState>();
const metaWrites: Array<{ objectId: string; field: string; value: string | number }> = [];
let nextId = 1;
let hqDown = false;
let scopeAll = true;
/** Next writes to answer « unknown outcome » (timeout). */
const uncertainWrites = new Set<string>();
/** Fields that Meta accepts but leaves unchanged on the re-read. */
const ignoredWrites = new Set<string>();

const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Array<Record<string, unknown>>).some((w) => matches(row, w));
    if (v && typeof v === "object" && "notIn" in (v as object)) return !(v as { notIn: unknown[] }).notIn.includes(row[k]);
    if (v && typeof v === "object" && "in" in (v as object)) return (v as { in: unknown[] }).in.includes(row[k]);
    return row[k] === v;
  });
const withOps = (a: Row | undefined) => (a ? { ...a, operations: operations.filter((o) => o.actionId === a.id).sort((x, y) => Number(x.position) - Number(y.position)) } : null);

vi.mock("@/lib/prisma", () => {
  const prisma = {
    pilotAction: {
      create: async ({ data }: { data: Record<string, unknown> & { operations: { create: Array<Record<string, unknown>> } } }) => {
        const { operations: nested, ...rest } = data;
        const row: Row = {
          id: `act_${nextId++}`, status: "draft", why: "", goalJson: "{}", needsDouble: false, hqProject: null, hqWrittenAt: null, hqError: null,
          undoOfId: null, undoneById: null, executedAt: null, createdAt: new Date(), updatedAt: new Date(), accountName: "", currency: "EUR", ...rest,
        };
        actions.push(row);
        for (const op of nested.create) operations.push({ id: `op_${nextId++}`, actionId: row.id, readBackJson: null, status: "pending", error: null, executedAt: null, ...op });
        return withOps(row);
      },
      findUnique: async ({ where, include }: { where: { id: string }; include?: unknown }) => {
        const a = actions.find((x) => x.id === where.id);
        return include ? withOps(a) : a ?? null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => withOps(actions.find((x) => x.id === where.id))!,
      findMany: async ({ where }: { where: Record<string, unknown> }) => actions.filter((a) => matches(a, where)).map((a) => withOps(a)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(actions.find((x) => x.id === where.id)!, data),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = actions.filter((a) => matches(a, where));
        for (const a of hit) Object.assign(a, data);
        return { count: hit.length };
      },
    },
    pilotOperation: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(operations.find((x) => x.id === where.id)!, data),
      findMany: async ({ where }: { where: { actionId: string } }) => operations.filter((o) => o.actionId === where.actionId).sort((x, y) => Number(x.position) - Number(y.position)),
    },
    alertClient: {
      findUnique: async ({ where }: { where: { id: string } }) => clients.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(clients.find((c) => c.id === where.id)!, data),
    },
    dashboard: { findUnique: async ({ where }: { where: { id: string } }) => dashboards.find((d) => d.id === where.id) ?? null },
    user: { findUnique: async ({ where }: { where: { id: string } }) => users.find((u) => u.id === where.id) ?? null },
  };
  return { prisma };
});

vi.mock("@/lib/scope", () => ({
  getAccountScope: async () => (scopeAll ? { all: true } : { all: false, meta: new Set<string>(), google: new Set<string>(), tiktok: new Set<string>() }),
  platformAccountInScope: (scope: { all: boolean }) => scope.all,
}));

vi.mock("@/lib/hq-journal", () => ({
  HQ_PROJECT_RE: /^[a-z0-9][a-z0-9-]{0,79}$/,
  appendHqJournal: async (args: { project: string; slug: string; content: string }) => {
    if (hqDown) return { ok: false, error: "Écriture dans HQ impossible (relay indisponible)" };
    hqEntries.push(args);
    return { ok: true };
  },
}));

vi.mock("@/lib/pilot/meta", () => ({
  readObject: async (id: string) => {
    const o = metaObjects.get(id);
    return o ? { ...o } : null;
  },
  writeField: async (_guard: unknown, objectId: string, field: string, value: string | number) => {
    metaWrites.push({ objectId, field, value });
    if (uncertainWrites.has(objectId)) return { kind: "uncertain", error: "Meta n'a pas répondu à temps" };
    const o = metaObjects.get(objectId)!;
    if (ignoredWrites.has(`${objectId}:${field}`)) return { kind: "done" };
    if (field === "status") o.status = String(value);
    if (field === "daily_budget") o.dailyBudget = Number(value);
    if (field === "name") o.name = String(value);
    if (field === "end_time" || field === "stop_time") o.endTime = String(value);
    return { kind: "done" };
  },
}));

import { executeAction, listActions, prepareAction, prepareUndo, retryHq } from "@/lib/pilot/service";

const LEA = { userId: "u-lea", role: "admin", baseRole: "consultant", user: { email: "lea@impulse-analytics.com" } };
const SAM = { userId: "u-sam", role: "admin", baseRole: "consultant", user: { email: "sam@impulse-analytics.com" } };

const CAMPAIGN: PilotObjectState = { id: "1200001", type: "campaign", accountId: "5550001111", name: "Prospection", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: 12000, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "" };
const AD: PilotObjectState = { id: "1200003", type: "ad", accountId: "5550001111", name: "UGC Julie v3", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: null, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "Retargeting 30j" };
const FOREIGN: PilotObjectState = { ...AD, id: "9900001", accountId: "7770001111", name: "Pub d'un autre compte" };

const pauseAd = { kind: "set_status", objectType: "ad", objectId: "1200003", value: "PAUSED" };
const budget = (value: number) => ({ kind: "set_daily_budget", objectType: "campaign", objectId: "1200001", value });

async function prepared(requests: unknown[], who = LEA) {
  const r = await prepareAction(who, { alertClientId: "c-lpev", accountId: "act_5550001111", requests, why: "", goal: {} });
  if (!r.ok) throw new Error(`${r.error} ${r.errors?.join(" | ") ?? ""}`);
  return r.action;
}

beforeEach(() => {
  actions.length = 0; operations.length = 0; clients.length = 0; dashboards.length = 0; users.length = 0; hqEntries.length = 0; metaWrites.length = 0;
  metaObjects.clear(); uncertainWrites.clear(); ignoredWrites.clear();
  nextId = 1; hqDown = false; scopeAll = true;
  clients.push({ id: "c-lpev", name: "LPEV", gone: false, hqSlug: null, dashboardId: "d-lpev", accountsJson: JSON.stringify([{ platform: "meta", accountId: "act_5550001111", name: "LPEV Meta", currency: "EUR" }]) });
  dashboards.push({ id: "d-lpev", hqSlug: "lpev" });
  users.push({ id: "u-lea", name: "Léa Martin", email: "lea@impulse-analytics.com" }, { id: "u-sam", name: null, email: "sam@impulse-analytics.com" });
  metaObjects.set(CAMPAIGN.id, { ...CAMPAIGN });
  metaObjects.set(AD.id, { ...AD });
  metaObjects.set(FOREIGN.id, { ...FOREIGN });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("pilotage — aperçu", () => {
  it("lit chaque objet sur Meta et garde la valeur avant et après, sans rien envoyer", async () => {
    const a = await prepared([pauseAd, budget(150)]);
    expect(a.status).toBe("draft");
    expect(a.hqProject).toBe("lpev");
    expect(a.createdByName).toBe("Léa Martin");
    expect(a.operations.map((o) => [o.field, o.before, o.after])).toEqual([["status", "ACTIVE", "PAUSED"], ["daily_budget", 12000, 15000]]);
    expect(a.operations[0].line).toContain("UGC Julie v3");
    expect(a.needsDouble).toBe(false);
    expect(metaWrites).toEqual([]);
  });

  it("refuse tout si une seule demande ne peut pas être faite, avec chaque raison", async () => {
    const r = await prepareAction(LEA, { alertClientId: "c-lpev", accountId: "act_5550001111", requests: [pauseAd, { ...pauseAd, objectId: "9900001" }, { ...pauseAd, objectId: "1234567" }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.errors).toEqual([expect.stringContaining("n'appartient pas au compte"), expect.stringContaining("introuvable")]);
    expect(actions).toHaveLength(0);
  });

  it("refuse un compte hors de portée ou qui n'est pas celui du client", async () => {
    scopeAll = false;
    const out = await prepareAction(LEA, { alertClientId: "c-lpev", accountId: "act_5550001111", requests: [pauseAd] });
    expect(out).toMatchObject({ ok: false, status: 403 });
    scopeAll = true;
    expect(await prepareAction(LEA, { alertClientId: "c-lpev", accountId: "act_7770001111", requests: [pauseAd] })).toMatchObject({ ok: false, status: 404 });
  });

  it("annonce la seconde confirmation", async () => {
    const a = await prepared([budget(400)]);
    expect(a.needsDouble).toBe(true);
    expect(a.doubleReasons[0]).toMatch(/50 %/);
  });
});

describe("pilotage — envoi", () => {
  it("applique, relit, écrit dans HQ avec le nom de la personne", async () => {
    const a = await prepared([pauseAd, budget(150)]);
    const r = await executeAction(LEA, a.id, { why: "créas fatiguées", goal: { metric: "cpa", target: 45 }, hqProject: "lpev" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action.status).toBe("done");
    expect(r.action.operations.map((o) => o.status)).toEqual(["done", "done"]);
    expect(metaWrites).toEqual([{ objectId: "1200003", field: "status", value: "PAUSED" }, { objectId: "1200001", field: "daily_budget", value: 15000 }]);
    expect(metaObjects.get("1200003")!.status).toBe("PAUSED");
    expect(hqEntries).toHaveLength(1);
    expect(hqEntries[0].project).toBe("lpev");
    expect(hqEntries[0].content).toContain("Fait par Léa Martin (lea@impulse-analytics.com)");
    expect(hqEntries[0].content).toContain("créas fatiguées");
    expect(r.action.hqWrittenAt).not.toBeNull();
  });

  it("n'envoie rien sans raison, sans dossier HQ, ou sans la seconde confirmation demandée", async () => {
    clients[0].dashboardId = null;
    const a = await prepared([budget(400)]);
    expect(await executeAction(LEA, a.id, { why: "", hqProject: "lpev", confirmDouble: true })).toMatchObject({ ok: false, status: 400 });
    expect(await executeAction(LEA, a.id, { why: "test", confirmDouble: true })).toMatchObject({ ok: false, status: 400 });
    expect(await executeAction(LEA, a.id, { why: "test", hqProject: "lpev" })).toMatchObject({ ok: false, status: 409 });
    expect(metaWrites).toEqual([]);
    expect((await executeAction(LEA, a.id, { why: "test", hqProject: "lpev", confirmDouble: true })).ok).toBe(true);
    // The folder chosen is kept for the next time.
    expect(clients[0].hqSlug).toBe("lpev");
  });

  it("n'est envoyé qu'une fois, et seulement par la personne qui l'a préparé", async () => {
    const a = await prepared([pauseAd]);
    expect(await executeAction(SAM, a.id, { why: "x y z", hqProject: "lpev" })).toMatchObject({ ok: false, status: 404 });
    expect((await executeAction(LEA, a.id, { why: "x y z", hqProject: "lpev" })).ok).toBe(true);
    expect(await executeAction(LEA, a.id, { why: "x y z", hqProject: "lpev" })).toMatchObject({ ok: false, status: 409 });
    expect(metaWrites).toHaveLength(1);
  });

  it("un aperçu de plus de 30 minutes doit être refait", async () => {
    const a = await prepared([pauseAd]);
    const later = new Date(Date.now() + 31 * 60 * 1000);
    expect(await executeAction(LEA, a.id, { why: "x y z", hqProject: "lpev" }, later)).toMatchObject({ ok: false, status: 409 });
    expect(actions[0].status).toBe("expired");
    expect(metaWrites).toEqual([]);
  });

  it("n'écrase pas une valeur changée par quelqu'un d'autre depuis l'aperçu", async () => {
    const a = await prepared([pauseAd, budget(150)]);
    metaObjects.get("1200001")!.dailyBudget = 13000;
    const r = await executeAction(LEA, a.id, { why: "x y z", hqProject: "lpev" });
    if (!r.ok) throw new Error(r.error);
    expect(r.action.status).toBe("partial");
    expect(r.action.operations[1]).toMatchObject({ status: "conflict", error: expect.stringContaining("a changé") });
    expect(metaWrites.map((w) => w.field)).toEqual(["status"]);
  });

  it("s'arrête après une issue inconnue et le dit dans HQ", async () => {
    uncertainWrites.add("1200003");
    const a = await prepared([pauseAd, budget(150)]);
    const r = await executeAction(LEA, a.id, { why: "x y z", hqProject: "lpev" });
    if (!r.ok) throw new Error(r.error);
    expect(r.action.operations.map((o) => o.status)).toEqual(["uncertain", "skipped"]);
    expect(r.action.status).toBe("partial");
    expect(metaWrites).toHaveLength(1);
    expect(hqEntries[0].content).toContain("issue inconnue");
  });

  it("signale une relecture qui ne donne pas la valeur envoyée", async () => {
    ignoredWrites.add("1200003:status");
    const a = await prepared([pauseAd]);
    const r = await executeAction(LEA, a.id, { why: "x y z", hqProject: "lpev" });
    if (!r.ok) throw new Error(r.error);
    expect(r.action.operations[0]).toMatchObject({ status: "uncertain", error: expect.stringContaining("relecture") });
  });

  it("garde l'échec d'écriture dans HQ et permet de réécrire", async () => {
    hqDown = true;
    const a = await prepared([pauseAd]);
    const r = await executeAction(LEA, a.id, { why: "x y z", hqProject: "lpev" });
    if (!r.ok) throw new Error(r.error);
    expect(r.action.hqWrittenAt).toBeNull();
    expect(r.action.hqError).toMatch(/HQ impossible/);
    hqDown = false;
    const again = await retryHq(LEA, a.id);
    expect(again.ok && again.action.hqWrittenAt).toBeTruthy();
    expect(hqEntries).toHaveLength(1);
  });
});

describe("pilotage — annulation et journal", () => {
  it("prépare le retour en arrière, l'envoie, et marque l'action annulée", async () => {
    const a = await prepared([pauseAd, budget(150)]);
    await executeAction(LEA, a.id, { why: "x y z", hqProject: "lpev" });
    const undo = await prepareUndo(SAM, a.id);
    if (!undo.ok) throw new Error(undo.error);
    expect(undo.action.undoOfId).toBe(a.id);
    expect(undo.action.operations.map((o) => [o.field, o.before, o.after])).toEqual([["status", "PAUSED", "ACTIVE"], ["daily_budget", 15000, 12000]]);
    const sent = await executeAction(SAM, undo.action.id, { why: undo.action.why, hqProject: "lpev" });
    expect(sent.ok).toBe(true);
    expect(actions.find((x) => x.id === a.id)!.undoneById).toBe(undo.action.id);
    expect(metaObjects.get("1200001")!.dailyBudget).toBe(12000);
    expect(hqEntries[1].content).toContain("Annulation d'une modification");
    expect(hqEntries[1].content).toContain("Fait par sam@impulse-analytics.com");
    expect(await prepareUndo(LEA, a.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("ne propose pas d'annuler une suppression", async () => {
    const a = await prepared([{ ...pauseAd, value: "DELETED" }]);
    await executeAction(LEA, a.id, { why: "x y z", hqProject: "lpev", confirmDouble: true });
    expect(await prepareUndo(LEA, a.id)).toMatchObject({ ok: false, error: expect.stringContaining("suppression") });
  });

  it("le journal montre les actions envoyées de tous, et seulement ses propres aperçus", async () => {
    const mine = await prepared([pauseAd]);
    await executeAction(LEA, mine.id, { why: "x y z", hqProject: "lpev" });
    await prepared([budget(150)], SAM);
    expect((await listActions(LEA, { alertClientId: "c-lpev" })).map((a) => a.status)).toEqual(["done"]);
    expect((await listActions(SAM, { alertClientId: "c-lpev" })).map((a) => a.status).sort()).toEqual(["done", "draft"]);
  });
});
