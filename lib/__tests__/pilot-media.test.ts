/**
 * Pilotage — a video ad from the preview to HQ, against fakes: an in-memory
 * database (actions, operations, media, Studio assets), Meta's writes as
 * spies (upload, status, creation), HQ as a list of entries.
 *
 *   preview  the Studio video gets a fresh link, is sent to Meta at once
 *            (uploadVideo under a guard), and a PilotMedia row follows it;
 *   send     a video still processed by Meta leaves the operation « uploading »
 *            and the action « running »; recoverStale leaves it alone;
 *   pass     once Meta says « ready », the media pass creates the ad with a
 *            guard minted for the action, closes it and writes HQ, once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PilotObjectState } from "@/lib/pilot/ops";

type Row = Record<string, unknown> & { id: string };

// Hoisted with the mocks: the factories below run before the rest of the file.
const h = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const actions: Row[] = [];
  const operations: Row[] = [];
  const medias: Row[] = [];
  const assets: Row[] = [];
  const hqEntries: Array<{ project: string; slug: string; content: string }> = [];
  const state = { nextId: 1 };
  const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "OR") return (v as Array<Record<string, unknown>>).some((w) => matches(row, w));
      if (k === "NOT") return !matches(row, v as Record<string, unknown>);
      if (k === "operations") {
        const ops = operations.filter((o) => o.actionId === row.id);
        const cond = v as { none?: Record<string, unknown>; some?: Record<string, unknown> };
        if (cond.none) return !ops.some((o) => matches(o, cond.none!));
        if (cond.some) return ops.some((o) => matches(o, cond.some!));
        return true;
      }
      if (v && typeof v === "object" && "notIn" in (v as object)) return !(v as { notIn: unknown[] }).notIn.includes(row[k]);
      if (v && typeof v === "object" && "in" in (v as object)) return (v as { in: unknown[] }).in.includes(row[k]);
      if (v && typeof v === "object" && "lt" in (v as object)) return row[k] instanceof Date && (row[k] as Date) < (v as { lt: Date }).lt;
      if (v && typeof v === "object" && "not" in (v as object)) { const n = (v as { not: unknown }).not; return n === null ? row[k] !== null && row[k] !== undefined : row[k] !== n; }
      return row[k] === v;
    });
  const sortBy = (rows: Row[], orderBy?: Record<string, string>) => {
    if (!orderBy) return rows;
    const [[k, dir]] = Object.entries(orderBy);
    return [...rows].sort((a, b) => (Number(a[k] instanceof Date ? (a[k] as Date).getTime() : a[k]) - Number(b[k] instanceof Date ? (b[k] as Date).getTime() : b[k])) * (dir === "desc" ? -1 : 1));
  };
  const withOps = (a: Row | undefined) => (a ? { ...a, operations: operations.filter((o) => o.actionId === a.id).sort((x, y) => Number(x.position) - Number(y.position)), impacts: [] } : null);
  const table = (rows: Row[], defaults: Record<string, unknown>) => ({
    create: async ({ data }: { data: Record<string, unknown> }) => { const row: Row = { id: `${state.nextId++}`, createdAt: new Date(), updatedAt: new Date(), ...defaults, ...data }; rows.push(row); return row; },
    findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id)!,
    findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number }) => sortBy(rows.filter((r) => matches(r, where)), orderBy).slice(0, take ?? 1000),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find((r) => r.id === where.id)!, data, { updatedAt: new Date() }),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { const hit = rows.filter((r) => matches(r, where)); for (const r of hit) Object.assign(r, data, { updatedAt: new Date() }); return { count: hit.length }; },
  });
  /** Meta as the test wants it: the status it answers for a video, what the upload does. */
  const meta = { videoStatus: "processing" as "processing" | "ready" | "error", uploadRefused: null as string | null };
  const uploads: Array<{ account: string; fileUrl: string; name: string }> = [];
  const creations: Array<Record<string, unknown>> = [];
  const statusReads: string[] = [];
  const metaObjects = new Map<string, { id: string; status: string } & Record<string, unknown>>();
  const ACCOUNT = "1668772300254268";
  const ADSET = "23857040420440567";
  const CAMPAIGN = "23857030053030567";
  const VIDEO = "1234567890123456";
  const AD = "120250524723910999";
  return { actions, operations, medias, assets, hqEntries, state, matches, withOps, table, meta, uploads, creations, statusReads, metaObjects, ACCOUNT, ADSET, CAMPAIGN, VIDEO, AD };
});
const { actions, operations, medias, assets, hqEntries, state, meta, uploads, creations, metaObjects, ACCOUNT, ADSET, CAMPAIGN, VIDEO, AD } = h;

vi.mock("@/lib/prisma", () => {
  const { actions, operations, medias, assets, state, withOps, table } = h;
  const pilotAction = table(actions, { status: "draft", why: "", goalJson: "{}", needsDouble: false, hqProject: null, hqWrittenAt: null, hqError: null, undoOfId: null, undoneById: null, executedAt: null, accountName: "", currency: "EUR" });
  const prisma = {
    pilotAction: {
      ...pilotAction,
      create: async ({ data }: { data: Record<string, unknown> & { operations: { create: Array<Record<string, unknown>> } } }) => {
        const { operations: nested, ...rest } = data;
        const row = (await pilotAction.create({ data: rest })) as Row;
        for (const op of nested.create) operations.push({ id: `op_${state.nextId++}`, actionId: row.id, readBackJson: null, status: "pending", error: null, executedAt: null, ...op });
        return withOps(row);
      },
      findUnique: async ({ where, include }: { where: { id: string }; include?: unknown }) => { const a = actions.find((x) => x.id === where.id); return include ? withOps(a) : a ?? null; },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => withOps(actions.find((x) => x.id === where.id))!,
      findMany: async (args: { where: Record<string, unknown>; orderBy?: Record<string, string>; take?: number }) => (await pilotAction.findMany(args)).map((a) => withOps(a)),
    },
    pilotOperation: table(operations, {}),
    pilotMedia: table(medias, { status: "uploading", error: null, actionId: null, operationId: null, remoteId: null, checkedAt: null }),
    creativeAsset: table(assets, {}),
    alertClient: { findUnique: async () => ({ id: "c-nat", name: "Naturalia", gone: false, hqSlug: "naturalia", dashboardId: null, accountsJson: JSON.stringify([{ platform: "meta", accountId: "act_1668772300254268", name: "Naturalia IA", currency: "EUR" }]) }), updateMany: async () => ({ count: 0 }) },
    dashboard: { findUnique: async () => null },
    user: { findUnique: async () => ({ id: "u-lea", name: "Léa Martin", email: "lea@impulse-analytics.com" }) },
  };
  return { prisma };
});

vi.mock("@/lib/scope", () => ({ getAccountScope: async () => ({ all: true }), platformAccountInScope: () => true }));
vi.mock("@/lib/hq-journal", () => ({
  HQ_PROJECT_RE: /^[a-z0-9][a-z0-9-]{0,79}$/,
  listHqProjects: async () => [{ slug: "naturalia", name: "Naturalia" }],
  appendHqJournal: async (args: { project: string; slug: string; content: string }) => { h.hqEntries.push(args); return { ok: true }; },
}));
vi.mock("@/lib/pilot/meta", () => ({
  readAccountCurrency: async () => "EUR",
  readObject: async (id: string) => { const o = h.metaObjects.get(id); return o ? { ...o } : null; },
  writeField: async (_g: unknown, objectId: string, field: string, value: string | number) => { const o = h.metaObjects.get(objectId)!; if (field === "status") o.status = String(value); return { kind: "done" }; },
}));
vi.mock("@/lib/meta-api", () => ({
  getMetaSystemToken: () => "token",
  getMetaTokens: () => ["token"],
  isMetaWriteUncertain: () => false,
  metaGraphPost: async () => { throw new Error("no write here"); },
  metaGraphGetOnce: async (path: string) => (path === `/${h.ADSET}` ? { id: h.ADSET, account_id: h.ACCOUNT, campaign_id: h.CAMPAIGN } : {}),
}));
vi.mock("@/lib/studio", () => ({ publicMediaUrl: (file: string, ttl: number) => `https://app.impulse-analytics.com/api/studio/media/${file}?exp=${ttl}&sig=0` }));
vi.mock("@/lib/meta-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-write")>();
  return {
    ...actual,
    verifyPagePromotable: async (_a: string, pageId: string) => ({ id: pageId, name: "Naturalia" }),
    checkAdIdentity: async () => ({ pageReadable: true, pagePromotable: true, instagramKnown: null, notes: [] }),
    uploadVideo: async (guard: unknown, account: string, fileUrl: string, name: string) => {
      const check = (await import("@/lib/routines/write-guard-check")).assertWriteGuard as unknown as (g: unknown) => void;
      check(guard);
      h.uploads.push({ account, fileUrl, name });
      if (h.meta.uploadRefused) throw new actual.MetaWriteError("refused", h.meta.uploadRefused);
      return { videoId: h.VIDEO };
    },
    readVideoStatus: async (videoId: string) => { h.statusReads.push(videoId); return h.meta.videoStatus === "error" ? { kind: "error", detail: "Your video is too long." } : { kind: h.meta.videoStatus, detail: h.meta.videoStatus }; },
    createPausedAd: async (guard: unknown, input: Record<string, unknown>) => {
      const check = (await import("@/lib/routines/write-guard-check")).assertWriteGuard as unknown as (g: unknown) => void;
      check(guard);
      const bad = actual.pausedAdInputError(input as never);
      if (bad) throw new actual.MetaWriteError("refused", `Publicité refusée : ${bad}`);
      h.creations.push(input);
      return { adId: h.AD, creativeId: "777", status: "PAUSED" };
    },
  };
});

import { executeAction, prepareAction, recoverStale, runPilotMediaPass } from "@/lib/pilot/service";
import { MEDIA_UPLOADING_NOTE } from "@/lib/pilot/new-ad";
import type { AdSpec } from "@/lib/pilot/ad-spec";

const LEA = { userId: "u-lea", role: "admin", baseRole: "consultant", user: { email: "lea@impulse-analytics.com" } };

const adsetState: PilotObjectState = { id: ADSET, type: "adset", accountId: ACCOUNT, name: "IA - Broad", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: 1000, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "IA - [TRA - ACQ]" };
const spec: AdSpec = {
  v: 2, platform: "meta", format: "video", name: "Gourde plage (vidéo)", linkUrl: "https://naturalia.fr/gourde", callToAction: "SHOP_NOW",
  texts: { primary: ["Fraîcheur garantie tout l'été"], headline: [], description: [] },
  media: [{ kind: "video", url: "https://app.impulse-analytics.com/api/studio/media/video_abc.mp4?exp=old&sig=0", studioAssetId: "vid1" }],
  identity: { pageId: "123456789" },
};
const request = (value: unknown = spec) => ({ kind: "create_ad", objectType: "adset", objectId: ADSET, value: JSON.stringify(value) });

async function prepared(requests: unknown[]) {
  const r = await prepareAction(LEA, { alertClientId: "c-nat", accountId: `act_${ACCOUNT}`, requests, why: "", goal: {} });
  if (!r.ok) throw new Error(`${r.error} ${r.errors?.join(" | ") ?? ""}`);
  return r.action;
}
const send = (id: string) => executeAction(LEA, id, { why: "Test vidéo", hqProject: "naturalia" });
const opOf = (actionId: string) => operations.find((o) => o.actionId === actionId && o.field === "new_ad")!;

beforeEach(() => {
  actions.length = 0; operations.length = 0; medias.length = 0; assets.length = 0; hqEntries.length = 0; uploads.length = 0; creations.length = 0; h.statusReads.length = 0;
  metaObjects.clear(); state.nextId = 1; meta.videoStatus = "processing"; meta.uploadRefused = null;
  vi.stubEnv("PILOT_WRITES", "1");
  metaObjects.set(ADSET, { ...adsetState } as never);
  assets.push({ id: "vid1", kind: "video", status: "completed", deletedAt: null, file: "video_abc.mp4", url: null, sourceId: "img1" });
  assets.push({ id: "img1", kind: "image", status: "completed", deletedAt: null, file: "img_abc.png", url: null, sourceId: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("pilotage — publicité vidéo : aperçu", () => {
  it("envoie la vidéo à Meta dès l'aperçu, avec un lien frais de 24 h et la vignette du Studio, et le dit", async () => {
    const a = await prepared([request()]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ account: ACCOUNT, name: "Gourde plage (vidéo)" });
    expect(uploads[0].fileUrl).toBe("https://app.impulse-analytics.com/api/studio/media/video_abc.mp4?exp=86400&sig=0");
    expect(medias).toHaveLength(1);
    expect(medias[0]).toMatchObject({ status: "uploading", remoteId: VIDEO, accountId: ACCOUNT, studioAssetId: "vid1", thumbUrl: "https://app.impulse-analytics.com/api/studio/media/img_abc.png?exp=86400&sig=0" });
    const kept = JSON.parse(String(a.operations[0].after)) as AdSpec;
    expect(kept).toMatchObject({ v: 2, format: "video", campaignId: CAMPAIGN, mediaId: medias[0].id, media: [{ remoteId: VIDEO, thumbStudioAssetId: "img1" }] });
    expect(a.notes?.some((n) => n.includes(MEDIA_UPLOADING_NOTE))).toBe(true);
    expect(a.operations[0].line).toContain("nouvelle publicité vidéo « Gourde plage (vidéo) »");
    expect(creations).toHaveLength(0);
  });

  it("une vidéo que Meta ne peut pas lire est refusée proprement : rien n'est préparé", async () => {
    meta.uploadRefused = "Vidéo refusée : Meta n'a pas pu télécharger le fichier (adresse injoignable, lien expiré ou format non lu).";
    const r = await prepareAction(LEA, { alertClientId: "c-nat", accountId: `act_${ACCOUNT}`, requests: [request()], why: "", goal: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.errors?.[0]).toMatch(/Meta n'a pas pu télécharger/);
    expect(actions).toHaveLength(0);
  });

  it("sans vignette ni image d'origine, ou avec une vidéo du Studio disparue, l'aperçu refuse", async () => {
    assets.splice(1, 1);
    let r = await prepareAction(LEA, { alertClientId: "c-nat", accountId: `act_${ACCOUNT}`, requests: [request()], why: "", goal: {} });
    expect(r.ok === false && r.errors?.[0]).toMatch(/vignette/);
    assets.length = 0;
    r = await prepareAction(LEA, { alertClientId: "c-nat", accountId: `act_${ACCOUNT}`, requests: [request()], why: "", goal: {} });
    expect(r.ok === false && r.errors?.[0]).toMatch(/n'existe plus/);
    expect(uploads).toHaveLength(0);
  });

  it("envoi fermé (page en essai) : la vidéo n'est pas envoyée à l'aperçu, et c'est dit", async () => {
    vi.stubEnv("PILOT_WRITES", "");
    const a = await prepared([request()]);
    expect(uploads).toHaveLength(0);
    expect(a.notes?.some((n) => /fermé/.test(n))).toBe(true);
  });
});

describe("pilotage — publicité vidéo : envoi, attente et passage média", () => {
  it("vidéo en traitement à l'envoi → opération « uploading », action en cours, pas d'entrée HQ ; prête → créée par le passage, HQ écrit une fois", async () => {
    const a = await prepared([request()]);
    const sent = await send(a.id);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.action.status).toBe("running");
    expect(sent.action.operations[0]).toMatchObject({ status: "uploading", error: expect.stringContaining("en traitement chez Meta") });
    expect(medias[0]).toMatchObject({ actionId: a.id, operationId: opOf(a.id).id });
    expect(creations).toHaveLength(0);
    expect(hqEntries).toHaveLength(0);

    // Still processing: the pass changes nothing.
    expect(await runPilotMediaPass()).toMatchObject({ checked: 1, ready: 0, created: 0 });
    expect(opOf(a.id).status).toBe("uploading");

    meta.videoStatus = "ready";
    const pass = await runPilotMediaPass();
    expect(pass).toMatchObject({ checked: 1, ready: 1, created: 1, refused: 0 });
    expect(creations).toHaveLength(1);
    expect(creations[0]).toMatchObject({ format: "video", videoId: VIDEO, adsetId: ADSET, campaignId: CAMPAIGN, imageUrl: expect.stringContaining("img_abc.png"), name: "Gourde plage (vidéo)" });
    expect(opOf(a.id)).toMatchObject({ status: "done", readBackJson: JSON.stringify(AD) });
    const action = actions.find((x) => x.id === a.id)!;
    expect(action.status).toBe("done");
    expect(hqEntries).toHaveLength(1);
    expect(hqEntries[0].content).toContain("nouvelle publicité vidéo « Gourde plage (vidéo) »");
    expect(hqEntries[0].content).toContain("✅ appliqué");

    // A second pass finds nothing to do and writes nothing again.
    expect(await runPilotMediaPass()).toMatchObject({ checked: 0, created: 0 });
    expect(creations).toHaveLength(1);
    expect(hqEntries).toHaveLength(1);
  });

  it("recoverStale laisse tranquille une action qui attend sa vidéo, et ferme les autres", async () => {
    const a = await prepared([request()]);
    await send(a.id);
    // Another action cut short without a video: closed as usual.
    actions.push({ id: "cut", status: "running", executedAt: new Date(Date.now() - 20 * 60_000), hqProject: null, operations: [] } as unknown as Row);
    operations.push({ id: "op_cut", actionId: "cut", position: 0, kind: "set_status", objectType: "ad", objectId: "1", objectName: "x", parentName: "", field: "status", beforeJson: '"ACTIVE"', afterJson: '"PAUSED"', readBackJson: null, status: "pending", error: null, executedAt: null });
    await recoverStale(new Date(Date.now() + 15 * 60_000));
    expect(opOf(a.id).status).toBe("uploading");
    expect(actions.find((x) => x.id === a.id)!.status).toBe("running");
    expect(operations.find((o) => o.id === "op_cut")!.status).toBe("uncertain");
    expect(actions.find((x) => x.id === "cut")!.status).toBe("partial");
  });

  it("vidéo refusée par Meta pendant le traitement → opération refusée, action fermée, le journal dit pourquoi", async () => {
    const a = await prepared([request()]);
    await send(a.id);
    meta.videoStatus = "error";
    expect(await runPilotMediaPass()).toMatchObject({ failed: 1, refused: 1, created: 0 });
    expect(opOf(a.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Your video is too long.") });
    expect(actions.find((x) => x.id === a.id)!.status).toBe("failed");
    // Nothing changed on the account: like any refusal, nothing is written in HQ; the journal says why.
    expect(hqEntries).toHaveLength(0);
    expect(creations).toHaveLength(0);
  });

  it("vidéo déjà prête à l'envoi : créée tout de suite, sans passage", async () => {
    const a = await prepared([request()]);
    meta.videoStatus = "ready";
    const sent = await send(a.id);
    expect(sent.ok && sent.action.status).toBe("done");
    expect(creations).toHaveLength(1);
    expect(medias[0].status).toBe("ready");
    expect(hqEntries).toHaveLength(1);
  });

  it("une action mêlant une pause et une vidéo : la pause part tout de suite, l'action attend la vidéo", async () => {
    metaObjects.set("1200003", { id: "1200003", type: "ad", accountId: ACCOUNT, name: "UGC", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: null, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "R" } as never);
    const a = await prepared([{ kind: "set_status", objectType: "ad", objectId: "1200003", value: "PAUSED" }, request()]);
    const sent = await send(a.id);
    expect(sent.ok && sent.action.status).toBe("running");
    expect(metaObjects.get("1200003")!.status).toBe("PAUSED");
    expect(hqEntries).toHaveLength(0);
    meta.videoStatus = "ready";
    await runPilotMediaPass();
    expect(actions.find((x) => x.id === a.id)!.status).toBe("done");
    expect(hqEntries).toHaveLength(1);
    expect(hqEntries[0].content).toContain("⏸");
  });

  it("la première forme (image, celle de Mo) passe toujours sans vidéo ni passage média", async () => {
    const legacy = { name: "Gourde plage", primaryText: "Fraîcheur", linkUrl: "https://naturalia.fr/gourde", imageUrl: "https://cdn.example.org/x.png", pageId: "123456789", callToAction: "SHOP_NOW" };
    const a = await prepared([request(legacy)]);
    expect(uploads).toHaveLength(0);
    const sent = await send(a.id);
    expect(sent.ok && sent.action.status).toBe("done");
    expect(creations[0]).toMatchObject({ format: "image", imageUrl: "https://cdn.example.org/x.png" });
    expect(creations[0]).not.toHaveProperty("videoId");
  });
});
