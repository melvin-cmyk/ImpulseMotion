/**
 * Pilotage — a dynamic creative (asset_feed_spec) from the preview to the
 * send, against the same fakes as pilot-media.test.ts: an in-memory database,
 * Meta's writes as spies (image upload → hash, video upload, status,
 * creation), Meta's reads answering whether the ad set was created in dynamic
 * creative and how many ads it holds.
 *
 *   refusals  an ad set not created in dynamic creative; one already holding
 *             an ad; an image/video/carousel ad asked in a dynamic ad set;
 *   preview   the images go to the library at once (hashes kept on the media,
 *             `remoteId`), the video too (PilotMedia), nothing is created;
 *   send      the ad is created with the asset feed once the video is ready;
 *             before that the operation waits (« uploading »).
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
  const meta = { videoStatus: "processing" as "processing" | "ready" | "error", uploadRefused: null as string | null, statusById: {} as Record<string, "processing" | "ready" | "error">, nextVideoIds: [] as string[] };
  const uploads: Array<{ account: string; fileUrl: string; name: string }> = [];
  const creations: Array<Record<string, unknown>> = [];
  const statusReads: string[] = [];
  const metaObjects = new Map<string, { id: string; status: string } & Record<string, unknown>>();
  /** The ad set as Meta answers it: created in dynamic creative or not, and how many ads it holds. */
  const adset = { dynamic: true, ads: 0 };
  const reads: string[] = [];
  const imageUploads: Array<{ account: string; url: string }> = [];
  const HASH = "0123456789abcdef0123456789abcdef";
  const ACCOUNT = "1668772300254268";
  const ADSET = "23857040420440567";
  const CAMPAIGN = "23857030053030567";
  const VIDEO = "1234567890123456";
  const AD = "120250524723910999";
  return { actions, operations, medias, assets, hqEntries, state, matches, withOps, table, meta, uploads, creations, statusReads, metaObjects, adset, reads, imageUploads, HASH, adsFilter: null as string | null, ACCOUNT, ADSET, CAMPAIGN, VIDEO, AD };
});
const { actions, operations, medias, assets, hqEntries, state, meta, uploads, creations, metaObjects, adset, imageUploads, HASH, ACCOUNT, ADSET, CAMPAIGN, VIDEO, AD } = h;

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
  metaGraphGetOnce: async (path: string, _t: string, params?: Record<string, string>) => {
    h.reads.push(path);
    if (path === `/${h.ADSET}`) return { id: h.ADSET, account_id: h.ACCOUNT, campaign_id: h.CAMPAIGN, is_dynamic_creative: h.adset.dynamic };
    if (path === `/${h.ADSET}/ads`) { h.adsFilter = params?.filtering ?? null; return { data: Array.from({ length: h.adset.ads }, (_, i) => ({ id: `ad_${i}` })) }; }
    return {};
  },
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
      return { videoId: h.meta.nextVideoIds.shift() ?? h.VIDEO };
    },
    uploadImage: async (guard: unknown, account: string, url: string) => {
      const check = (await import("@/lib/routines/write-guard-check")).assertWriteGuard as unknown as (g: unknown) => void;
      check(guard);
      h.imageUploads.push({ account, url });
      if (h.meta.uploadRefused) throw new actual.MetaWriteError("refused", h.meta.uploadRefused);
      // Same bytes, same hash: the rank of the image makes the hash, as Meta would for distinct files.
      return { hash: `${h.HASH.slice(0, 30)}${String(h.imageUploads.length).padStart(2, "0")}` };
    },
    readVideoStatus: async (videoId: string) => { h.statusReads.push(videoId); const st = h.meta.statusById[videoId] ?? h.meta.videoStatus; return st === "error" ? { kind: "error", detail: "Your video is too long." } : { kind: st, detail: st }; },
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

import { executeAction, prepareAction, runPilotMediaPass } from "@/lib/pilot/service";
import { DYNAMIC_ADSET_ONLY, DYNAMIC_ADSET_REQUIRED } from "@/lib/pilot/new-ad";
import type { AdSpec } from "@/lib/pilot/ad-spec";
import type { PausedAdInput } from "@/lib/meta-write";

const LEA = { userId: "u-lea", role: "admin", baseRole: "consultant", user: { email: "lea@impulse-analytics.com" } };

const adsetState: PilotObjectState = { id: ADSET, type: "adset", accountId: ACCOUNT, name: "IA - Dyn", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudget: 1000, lifetimeBudget: null, endTime: null, bidAmount: null, parentName: "IA - [TRA - ACQ]", dynamicCreative: true };
const IMG = (n: number) => `https://cdn.example.org/visuel-${n}.jpg`;
const dynamic: AdSpec = {
  v: 2, platform: "meta", format: "dynamic", name: "Gourdes (dynamique)", linkUrl: "https://naturalia.fr/gourdes", callToActions: ["SHOP_NOW", "LEARN_MORE"],
  texts: { primary: ["Fraîcheur garantie tout l'été", "Trois tailles, un prix doux"], headline: ["Nouveau", "Gourdes bio"], description: ["Livraison offerte"] },
  media: [{ kind: "image", url: IMG(1) }, { kind: "image", url: "https://app.impulse-analytics.com/api/studio/media/img_abc.png?exp=old&sig=0", studioAssetId: "img1" }, { kind: "image", url: IMG(3) }],
  identity: { pageId: "123456789" },
};
const withVideo: AdSpec = { ...dynamic, media: [...dynamic.media, { kind: "video", url: "https://app.impulse-analytics.com/api/studio/media/video_abc.mp4?exp=old&sig=0", studioAssetId: "vid1" }] };
const image: AdSpec = { ...dynamic, format: "image", callToActions: undefined, callToAction: "SHOP_NOW", texts: { primary: ["Un texte"], headline: [], description: [] }, media: [{ kind: "image", url: IMG(1) }] };
const request = (value: unknown = dynamic) => ({ kind: "create_ad", objectType: "adset", objectId: ADSET, value: JSON.stringify(value) });

const prepare = (requests: unknown[]) => prepareAction(LEA, { alertClientId: "c-nat", accountId: `act_${ACCOUNT}`, requests, why: "", goal: {} });
async function prepared(requests: unknown[]) {
  const r = await prepare(requests);
  if (!r.ok) throw new Error(`${r.error} ${r.errors?.join(" | ") ?? ""}`);
  return r.action;
}
const send = (id: string) => executeAction(LEA, id, { why: "Test dynamique", hqProject: "naturalia" });
const opOf = (actionId: string) => operations.find((o) => o.actionId === actionId && o.field === "new_ad")!;

beforeEach(() => {
  actions.length = 0; operations.length = 0; medias.length = 0; assets.length = 0; hqEntries.length = 0; uploads.length = 0; creations.length = 0; h.statusReads.length = 0; h.reads.length = 0; imageUploads.length = 0;
  metaObjects.clear(); state.nextId = 1; meta.videoStatus = "processing"; meta.uploadRefused = null; meta.statusById = {}; meta.nextVideoIds = [];
  adset.dynamic = true; adset.ads = 0; h.adsFilter = null;
  vi.stubEnv("PILOT_WRITES", "1");
  metaObjects.set(ADSET, { ...adsetState } as never);
  assets.push({ id: "vid1", kind: "video", status: "completed", deletedAt: null, file: "video_abc.mp4", url: null, sourceId: "img1" });
  assets.push({ id: "img1", kind: "image", status: "completed", deletedAt: null, file: "img_abc.png", url: null, sourceId: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("pilotage — publicité dynamique : l'ensemble", () => {
  it("refuse un ensemble qui n'a pas été créé en création dynamique, sans rien envoyer", async () => {
    adset.dynamic = false;
    const r = await prepare([request()]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.errors?.[0]).toContain(DYNAMIC_ADSET_REQUIRED);
    expect(r.errors?.[0]).toMatch(/n'a pas été créé en création dynamique/);
    expect(imageUploads).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(actions).toHaveLength(0);
  });

  it("refuse un ensemble dynamique qui porte déjà une publicité (hors supprimées et archivées)", async () => {
    adset.ads = 1;
    const r = await prepare([request()]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors?.[0]).toMatch(/porte déjà une publicité/);
    expect(r.errors?.[0]).toContain(DYNAMIC_ADSET_REQUIRED);
    expect(JSON.parse(h.adsFilter ?? "[]")).toEqual([{ field: "effective_status", operator: "NOT_IN", value: ["DELETED", "ARCHIVED"] }]);
    expect(imageUploads).toHaveLength(0);
  });

  it("refuse une publicité image dans un ensemble dynamique (il ne prend que le format dynamique)", async () => {
    const r = await prepare([request(image)]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors?.[0]).toContain(DYNAMIC_ADSET_ONLY);
  });

  it("une publicité image dans un ensemble ordinaire passe comme avant", async () => {
    adset.dynamic = false;
    metaObjects.set(ADSET, { ...adsetState, dynamicCreative: false } as never);
    const a = await prepared([request(image)]);
    expect(a.operations[0].line).toContain("nouvelle publicité image");
    expect(h.reads.filter((p) => p === `/${ADSET}/ads`)).toHaveLength(0);
  });
});

describe("pilotage — publicité dynamique : aperçu", () => {
  it("envoie les images à Meta dès l'aperçu, garde leur empreinte sur la publicité, et ne crée rien", async () => {
    const a = await prepared([request()]);
    expect(imageUploads).toHaveLength(3);
    expect(imageUploads.map((u) => u.account)).toEqual([ACCOUNT, ACCOUNT, ACCOUNT]);
    // The Studio image gets a fresh 24 h link before it is sent.
    expect(imageUploads[1].url).toBe("https://app.impulse-analytics.com/api/studio/media/img_abc.png?exp=86400&sig=0");
    const kept = JSON.parse(String(a.operations[0].after)) as AdSpec;
    expect(kept.media.map((m) => m.remoteId)).toEqual([`${HASH.slice(0, 30)}01`, `${HASH.slice(0, 30)}02`, `${HASH.slice(0, 30)}03`]);
    expect(kept).toMatchObject({ format: "dynamic", campaignId: CAMPAIGN, callToActions: ["SHOP_NOW", "LEARN_MORE"], texts: { primary: ["Fraîcheur garantie tout l'été", "Trois tailles, un prix doux"] } });
    expect(a.operations[0].line).toContain("nouvelle publicité dynamique (3 visuels, 2 textes) « Gourdes (dynamique) »");
    expect(creations).toHaveLength(0);
    expect(medias).toHaveLength(0);
  });

  it("une image que Meta refuse arrête l'aperçu en la nommant", async () => {
    meta.uploadRefused = "Image refusée : Meta n'a pas pu la télécharger ou l'a refusée (Invalid image).";
    const r = await prepare([request()]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors?.[0]).toMatch(/Image 1 : Image refusée/);
    expect(actions).toHaveLength(0);
  });

  it("une vidéo du flux part aussi à l'aperçu (PilotMedia) ; un second aperçu ne renvoie ni les images ni la vidéo", async () => {
    const a = await prepared([request(withVideo)]);
    expect(imageUploads).toHaveLength(3);
    expect(uploads).toHaveLength(1);
    expect(medias).toHaveLength(1);
    const kept = JSON.parse(String(a.operations[0].after)) as AdSpec;
    expect(kept.media[3]).toMatchObject({ kind: "video", remoteId: VIDEO, mediaId: medias[0].id, thumbUrl: "https://app.impulse-analytics.com/api/studio/media/img_abc.png?exp=86400&sig=0" });
    expect(a.notes?.some((n) => /Vidéo envoyée à Meta/.test(n))).toBe(true);
    // Prepared again with what the first preview kept.
    await prepared([request(kept)]);
    expect(imageUploads).toHaveLength(3);
    expect(uploads).toHaveLength(1);
  });

  it("11 images ou 6 textes sont refusés avant tout envoi", async () => {
    const eleven = await prepare([request({ ...dynamic, media: Array.from({ length: 11 }, (_, i) => ({ kind: "image", url: IMG(i + 1) })) })]);
    expect(eleven).toMatchObject({ ok: false, errors: [expect.stringMatching(/10 images au plus/)] });
    const six = await prepare([request({ ...dynamic, texts: { ...dynamic.texts, primary: ["a", "b", "c", "d", "e", "f"] } })]);
    expect(six).toMatchObject({ ok: false, errors: [expect.stringMatching(/5 textes principaux au plus/)] });
    expect(imageUploads).toHaveLength(0);
  });
});

describe("pilotage — publicité dynamique : envoi", () => {
  it("crée la publicité avec le flux d'éléments (empreintes, textes, un lien, boutons), en pause, et l'écrit dans HQ", async () => {
    const a = await prepared([request()]);
    const r = await send(a.id);
    expect(r.ok).toBe(true);
    expect(creations).toHaveLength(1);
    const input = creations[0] as unknown as PausedAdInput;
    expect(input).toMatchObject({ format: "dynamic", accountId: ACCOUNT, adsetId: ADSET, campaignId: CAMPAIGN, pageId: "123456789", linkUrl: "https://naturalia.fr/gourdes", primaryText: "Fraîcheur garantie tout l'été" });
    expect(input.callToAction).toBeUndefined();
    expect(input.dynamic).toEqual({
      images: [`${HASH.slice(0, 30)}01`, `${HASH.slice(0, 30)}02`, `${HASH.slice(0, 30)}03`], videos: [],
      bodies: ["Fraîcheur garantie tout l'été", "Trois tailles, un prix doux"], titles: ["Nouveau", "Gourdes bio"], descriptions: ["Livraison offerte"], callToActions: ["SHOP_NOW", "LEARN_MORE"],
    });
    expect(opOf(a.id)).toMatchObject({ status: "done", readBackJson: JSON.stringify(AD) });
    expect(hqEntries).toHaveLength(1);
    expect(hqEntries[0].content).toContain("nouvelle publicité dynamique (3 visuels, 2 textes)");
  });

  it("l'ensemble est relu à l'envoi : une publicité arrivée entre-temps fait refuser la création", async () => {
    const a = await prepared([request()]);
    adset.ads = 1;
    await send(a.id);
    expect(creations).toHaveLength(0);
    expect(opOf(a.id)).toMatchObject({ status: "failed" });
    expect(String(opOf(a.id).error)).toContain(DYNAMIC_ADSET_REQUIRED);
  });

  it("avec une vidéo encore en traitement, l'opération attend ; le passage média crée la publicité quand elle est prête", async () => {
    const a = await prepared([request(withVideo)]);
    await send(a.id);
    expect(creations).toHaveLength(0);
    expect(opOf(a.id).status).toBe("uploading");
    meta.videoStatus = "ready";
    await runPilotMediaPass();
    expect(creations).toHaveLength(1);
    const input = creations[0] as unknown as PausedAdInput;
    expect(input.dynamic?.videos).toEqual([{ videoId: VIDEO, thumbnailUrl: "https://app.impulse-analytics.com/api/studio/media/img_abc.png?exp=86400&sig=0" }]);
    expect(input.dynamic?.images).toHaveLength(3);
    expect(opOf(a.id)).toMatchObject({ status: "done" });
    expect(hqEntries).toHaveLength(1);
  });
});
