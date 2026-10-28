/**
 * Pilotage — a new Meta ad in an ad set (kind "create_ad"), on the same
 * writes as the routines (lib/meta-write.ts): an image, a video or a carousel
 * ad, always created PAUSED, read back, paused again if it is not.
 *
 *   identities  the Pages the ad account may promote and its Instagram
 *               accounts, to fill the form;
 *   check       before the preview: the ad set and its campaign, the Page
 *               (one the account may promote — an ad of a client never leaves
 *               under the Page of another), the Instagram account when
 *               given, every field; the campaign is kept in the spec. A Studio
 *               media gets a fresh signed link (24 h: preview, send, processing).
 *               A video is sent to Meta NOW (uploadVideo, under a guard minted
 *               by the service) and followed by a PilotMedia row: Meta
 *               processes it for a few minutes;
 *   create      at the send, with the guard of the action. A video not yet
 *               « ready » gives the outcome `uploading`: the service keeps the
 *               operation open and the media pass finishes the creation. A
 *               carousel may carry several videos (one PilotMedia row each,
 *               all attached to the operation): the ad is created only when
 *               every one of them is ready.
 *   dynamic     (asset_feed_spec) only in an ad set created in dynamic
 *               creative and still empty — read on Meta at the preview and at
 *               the send; refused otherwise, as is any other format in such an
 *               ad set. Its images go to the library at the preview too
 *               (uploadImage → hash kept on the media, `remoteId`); its videos
 *               follow the same path as a carousel's.
 */

import { getMetaSystemToken, metaGraphGetOnce } from "@/lib/meta-api";
import {
  MetaWriteError, checkAdIdentity, createPausedAd, isMetaWriteError, listPromotablePages, pausedAdInputError, readVideoStatus, uploadImage, uploadVideo, verifyPagePromotable,
  type PausedAdInput, type PromotablePage,
} from "@/lib/meta-write";
import { prisma } from "@/lib/prisma";
import { publicMediaUrl } from "@/lib/studio";
import type { WriteGuard } from "@/lib/routines/types";
import { adTextsOf, dynamicMedia, metaAdSpecError, type AdSpec, type CarouselCard, type MediaRef } from "@/lib/pilot/ad-spec";
import type { WriteOutcome } from "@/lib/pilot/meta";

/** A signed link must outlive the preview (30 min), the send and Meta's processing (minutes, hours when Meta is slow). */
export const PUBLICATION_LINK_TTL_S = 24 * 3600;

export interface AdIdentities { pages: PromotablePage[]; pagesComplete: boolean; instagram: Array<{ id: string; name: string }> }

export async function adIdentities(account: string): Promise<AdIdentities> {
  const [pages, ig] = await Promise.all([
    listPromotablePages(account),
    metaGraphGetOnce<{ data?: Array<{ id?: string; username?: string }> }>(`/act_${account}/instagram_accounts`, getMetaSystemToken(), { fields: "id,username", limit: "50" })
      .then((r) => (r.data ?? []).filter((x) => /^\d{5,25}$/.test(String(x.id ?? ""))).map((x) => ({ id: String(x.id), name: x.username ? `@${x.username}` : String(x.id) })))
      .catch(() => [] as Array<{ id: string; name: string }>),
  ]);
  return { pages: pages.pages, pagesComplete: pages.complete, instagram: ig };
}

/** The campaign of an ad set of the account, and whether the ad set was created in dynamic creative; throws when it is not one of the account. */
async function adsetInfo(account: string, adsetId: string): Promise<{ campaignId: string; dynamic: boolean }> {
  const data = await metaGraphGetOnce<{ id?: string; account_id?: string; campaign_id?: string; is_dynamic_creative?: boolean }>(`/${adsetId}`, getMetaSystemToken(), { fields: "id,account_id,campaign_id,is_dynamic_creative" });
  if (String(data?.id ?? "") !== adsetId || String(data.account_id ?? "").replace(/^act_/, "") !== account) throw new Error("Cet ensemble de publicités n'appartient pas au compte.");
  if (!/^\d{5,25}$/.test(String(data.campaign_id ?? ""))) throw new Error("Campagne de l'ensemble illisible.");
  return { campaignId: String(data.campaign_id), dynamic: data.is_dynamic_creative === true };
}

/** Said when a dynamic creative is asked outside an ad set created in dynamic creative, or in one that already holds an ad. */
export const DYNAMIC_ADSET_REQUIRED = "choisissez un ensemble créé en création dynamique et vide";
/** Said when an image, video or carousel ad is asked in a dynamic creative ad set. */
export const DYNAMIC_ADSET_ONLY = "Cet ensemble est en création dynamique : seul le format Dynamique y entre.";

/** True when the ad set already holds an ad that is neither deleted nor archived (a dynamic creative ad set takes one ad only). */
async function adsetHoldsAnAd(adsetId: string): Promise<boolean> {
  const data = await metaGraphGetOnce<{ data?: Array<{ id?: string }> }>(`/${adsetId}/ads`, getMetaSystemToken(), {
    fields: "id", limit: "1", filtering: JSON.stringify([{ field: "effective_status", operator: "NOT_IN", value: ["DELETED", "ARCHIVED"] }]),
  });
  return Array.isArray(data?.data) && data.data.length > 0;
}

/**
 * The ad set against the format asked: a dynamic creative needs an ad set
 * created in dynamic creative and still empty; such an ad set takes nothing
 * else. Null when they match, the reason otherwise. Throws when Meta cannot
 * be read.
 */
async function adsetFormatError(adsetId: string, dynamicAdset: boolean, format: AdSpec["format"]): Promise<string | null> {
  if (format === "dynamic") {
    if (!dynamicAdset) return `Cet ensemble n'a pas été créé en création dynamique : ${DYNAMIC_ADSET_REQUIRED} (le Gestionnaire ne convertit pas un ensemble existant).`;
    if (await adsetHoldsAnAd(adsetId)) return `Cet ensemble porte déjà une publicité (une seule par ensemble dynamique) : ${DYNAMIC_ADSET_REQUIRED}.`;
    return null;
  }
  return dynamicAdset ? DYNAMIC_ADSET_ONLY : null;
}

/** What createPausedAd takes, from the spec. */
export const toInput = (account: string, adsetId: string, spec: AdSpec & { campaignId: string }): PausedAdInput => {
  const texts = adTextsOf(spec);
  const base = {
    accountId: account, campaignId: spec.campaignId, adsetId, pageId: spec.identity.pageId, instagramUserId: spec.identity.instagramUserId,
    name: spec.name, primaryText: texts.primaryText, linkUrl: spec.linkUrl, callToAction: spec.callToAction,
  };
  if (spec.format === "carousel") {
    return {
      ...base, format: "carousel",
      cards: (spec.cards ?? []).map((c) => ({
        link: c.link,
        pictureUrl: c.media.kind === "video" ? c.media.thumbUrl ?? "" : c.media.url,
        ...(c.media.kind === "video" && c.media.remoteId ? { videoId: c.media.remoteId } : {}),
        ...(c.headline ? { name: c.headline } : {}),
        ...(c.description ? { description: c.description } : {}),
        ...(c.callToAction ? { callToAction: c.callToAction } : {}),
      })),
      multiShareOptimized: spec.options?.multiShareOptimized === true,
      endCard: spec.options?.endCard !== false,
    };
  }
  if (spec.format === "dynamic") {
    const { images, videos } = dynamicMedia(spec);
    return {
      ...base, callToAction: undefined, format: "dynamic",
      dynamic: {
        images: images.map((m) => m.remoteId ?? ""),
        videos: videos.map((m) => ({ videoId: m.remoteId ?? "", thumbnailUrl: m.thumbUrl ?? "" })),
        bodies: spec.texts.primary, titles: spec.texts.headline, descriptions: spec.texts.description,
        callToActions: spec.callToActions ?? [],
      },
    };
  }
  const media = spec.media[0];
  return {
    ...base, headline: texts.headline, description: texts.description,
    format: spec.format === "video" ? "video" : "image",
    imageUrl: spec.format === "video" ? media?.thumbUrl ?? "" : media?.url ?? "",
    ...(spec.format === "video" && media?.remoteId ? { videoId: media.remoteId } : {}),
  };
};

// ── Studio links ─────────────────────────────────────────────────────────

type StudioFile = { id: string; kind: string; file: string | null; url: string | null; sourceId: string | null };

/** A completed, not deleted Studio asset; null otherwise. */
async function studioAsset(id: string): Promise<StudioFile | null> {
  const a = await prisma.creativeAsset.findFirst({ where: { id, deletedAt: null, status: "completed" }, select: { id: true, kind: true, file: true, url: true, sourceId: true } });
  return a ?? null;
}

/** A fresh public link to a Studio asset (24 h), or its provider link when the relay holds no copy; null when there is none. */
function studioLink(a: StudioFile): string | null {
  if (a.file) { try { return publicMediaUrl(a.file, PUBLICATION_LINK_TTL_S); } catch { return null; } }
  return a.url && /^https:\/\//.test(a.url) ? a.url : null;
}

/**
 * The media of the spec with fresh links: a Studio asset is re-read now (the
 * link the form held expires in 6 h); a video without a thumbnail takes the
 * Studio image it was animated from, when there is one. Said in French when
 * a Studio asset is gone.
 */
async function refreshMedia(media: MediaRef): Promise<{ ok: true; media: MediaRef } | { ok: false; error: string }> {
  const out: MediaRef = { ...media };
  let source: string | null = null;
  if (media.studioAssetId) {
    const a = await studioAsset(media.studioAssetId);
    if (!a || a.kind !== media.kind) return { ok: false, error: `${media.kind === "video" ? "La vidéo" : "L'image"} du Studio n'existe plus (ou n'est pas terminée) : choisissez-en une autre.` };
    const link = studioLink(a);
    if (!link) return { ok: false, error: `${media.kind === "video" ? "La vidéo" : "L'image"} du Studio n'a pas d'adresse publique que Meta puisse télécharger.` };
    out.url = link;
    source = a.sourceId;
  }
  if (media.kind === "video") {
    const thumbId = media.thumbStudioAssetId ?? (media.thumbUrl ? null : source);
    if (thumbId) {
      const t = await studioAsset(thumbId);
      const link = t && t.kind === "image" ? studioLink(t) : null;
      if (link) { out.thumbUrl = link; out.thumbStudioAssetId = thumbId; }
      else if (media.thumbStudioAssetId) return { ok: false, error: "L'image de vignette du Studio n'existe plus : choisissez-en une autre." };
    }
  }
  return { ok: true, media: out };
}

// ── Video upload (PilotMedia) ────────────────────────────────────────────

/** Mints a guard for a side effect of the preview (the upload of a video); the service gives it (withPilotGuard). */
export type GuardLender = <T>(key: string, fn: (guard: WriteGuard) => Promise<T>) => Promise<T>;

export const MEDIA_UPLOADING_NOTE = "Vidéo envoyée à Meta, en traitement (quelques minutes). Si elle n'est pas prête à l'envoi, la publicité sera créée automatiquement dès qu'elle l'est.";
const mediaUploadingNote = (n: number) => (n > 1 ? `${n} vidéos envoyées à Meta, en traitement (quelques minutes). Si elles ne sont pas toutes prêtes à l'envoi, la publicité sera créée automatiquement dès qu'elles le sont.` : MEDIA_UPLOADING_NOTE);

/** Starts the upload on Meta and keeps the PilotMedia row following it. Throws MetaWriteError. */
async function startVideoUpload(guard: WriteGuard, account: string, spec: AdSpec, media: MediaRef, createdById: string | null): Promise<{ mediaId: string; videoId: string }> {
  const { videoId } = await uploadVideo(guard, account, media.url, spec.name);
  const row = await prisma.pilotMedia.create({
    data: {
      platform: "meta", accountId: account, kind: "video", sourceUrl: media.url, studioAssetId: media.studioAssetId ?? null,
      thumbUrl: media.thumbUrl ?? null, remoteId: videoId, status: "uploading", createdById,
    },
    select: { id: true },
  });
  return { mediaId: row.id, videoId };
}

/**
 * A video the ad needs in Meta's library before its creation: the one of a
 * video ad (its PilotMedia id lives on the spec, `mediaId`) or the one of a
 * carousel card (on the card's media, `MediaRef.mediaId`). `label` names it
 * in French for the messages.
 */
interface PendingVideo { media: MediaRef; label: string; mediaId: () => string | undefined; setMediaId: (id: string | undefined) => void }

function pendingVideos(spec: AdSpec): PendingVideo[] {
  if (spec.format === "video" && spec.media[0]) {
    const media = spec.media[0];
    return [{ media, label: "Vidéo", mediaId: () => spec.mediaId, setMediaId: (id) => { spec.mediaId = id; } }];
  }
  if (spec.format === "carousel") {
    return (spec.cards ?? []).flatMap((card, i) => card.media.kind === "video"
      ? [{ media: card.media, label: `Vidéo de la carte ${i + 1}`, mediaId: () => card.media.mediaId, setMediaId: (id: string | undefined) => { card.media.mediaId = id; } }]
      : []);
  }
  if (spec.format === "dynamic") {
    return dynamicMedia(spec).videos.map((media, i) => ({ media, label: `Vidéo ${i + 1}`, mediaId: () => media.mediaId, setMediaId: (id: string | undefined) => { media.mediaId = id; } }));
  }
  return [];
}

/** The images of a dynamic creative that are not in Meta's library yet (no hash). */
const pendingImages = (spec: AdSpec): MediaRef[] => (spec.format === "dynamic" ? dynamicMedia(spec).images.filter((m) => !m.remoteId) : []);

/** Puts the images in the library and keeps the hash on each media. Throws MetaWriteError (said with the image's rank). */
async function uploadImages(guard: WriteGuard, account: string, images: MediaRef[], allImages: MediaRef[]): Promise<void> {
  for (const m of images) {
    try {
      const { hash } = await uploadImage(guard, account, m.url);
      m.remoteId = hash;
    } catch (e) {
      const n = allImages.indexOf(m) + 1;
      throw isMetaWriteError(e) ? new MetaWriteError(e.kind, `Image ${n} : ${e.message}`) : e;
    }
  }
}

/** The input of the send, with placeholders where an upload has not happened yet (checked with the same rule at the preview). */
function previewInput(account: string, adsetId: string, spec: AdSpec & { campaignId: string }): PausedAdInput {
  const input = toInput(account, adsetId, spec);
  if (spec.format === "video") return { ...input, videoId: "00000" };
  if (spec.format === "dynamic" && input.dynamic) {
    return { ...input, dynamic: { ...input.dynamic, images: input.dynamic.images.map((h) => h || "0".repeat(32)), videos: input.dynamic.videos.map((v) => ({ ...v, videoId: v.videoId || "00000" })) } };
  }
  return input;
}

export type CheckedAd = { ok: true; spec: AdSpec & { campaignId: string }; notes: string[] } | { ok: false; error: string };

/**
 * Before the preview: everything Meta will be asked, checked now. `lend` is
 * how a video gets sent to Meta from here (absent = writes closed: the video
 * is sent at the send instead, and said so).
 */
export async function checkNewAd(account: string, adsetId: string, spec: AdSpec, lend?: GuardLender, createdById: string | null = null): Promise<CheckedAd> {
  let campaignId: string;
  try {
    const adset = await adsetInfo(account, adsetId);
    campaignId = adset.campaignId;
    const mismatch = await adsetFormatError(adsetId, adset.dynamic, spec.format);
    if (mismatch) return { ok: false, error: mismatch };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  // Fresh links for every media: the one of the ad, those of the cards of a carousel, every one of a dynamic creative.
  let full: AdSpec & { campaignId: string };
  if (spec.format === "dynamic") {
    const media: MediaRef[] = [];
    for (const [i, m] of spec.media.entries()) {
      const r = await refreshMedia(m);
      if (!r.ok) return { ok: false, error: `${m.kind === "video" ? "Vidéo" : "Image"} ${i + 1} : ${r.error}` };
      media.push(r.media);
    }
    full = { ...spec, media, campaignId };
  } else if (spec.format === "carousel") {
    const cards: CarouselCard[] = [];
    for (const [i, card] of (spec.cards ?? []).entries()) {
      const m = await refreshMedia(card.media);
      if (!m.ok) return { ok: false, error: `Carte ${i + 1} : ${m.error}` };
      cards.push({ ...card, media: m.media });
    }
    full = { ...spec, media: [], cards, campaignId };
  } else {
    const media = spec.media[0] ? await refreshMedia(spec.media[0]) : { ok: true as const, media: undefined };
    if (!media.ok) return media;
    full = { ...spec, media: media.media ? [media.media] : [], campaignId };
  }
  const invalid = metaAdSpecError(full);
  if (invalid) return { ok: false, error: invalid.endsWith(".") ? invalid : `${invalid}.` };
  // The same input as the send, checked with the same rule (a video has no id, an image no hash yet: placeholders there).
  const inputError = pausedAdInputError(previewInput(account, adsetId, full));
  if (inputError) return { ok: false, error: `Publicité refusée : ${inputError}.` };
  try {
    await verifyPagePromotable(account, spec.identity.pageId);
  } catch (e) {
    return { ok: false, error: isMetaWriteError(e) ? e.message : "La Page n'a pas pu être vérifiée : réessayez dans quelques minutes." };
  }
  const identity = await checkAdIdentity(account, spec.identity.pageId, spec.identity.instagramUserId);
  const notes = [...identity.notes];
  // Dynamic: the images go to the library now (their hash is what the creative refers to). A hash already kept is not asked again.
  const images = pendingImages(full);
  if (images.length) {
    if (!lend) notes.push(`L'envoi vers Meta est fermé (page en essai) : ${images.length > 1 ? "les images seront envoyées" : "l'image sera envoyée"} à Meta au moment de l'envoi.`);
    else {
      try {
        await lend(`media:${account}:${adsetId}`, (guard) => uploadImages(guard, account, images, dynamicMedia(full).images));
      } catch (e) {
        if (isMetaWriteError(e)) return { ok: false, error: e.kind === "uncertain" ? `${e.message} — l'image a peut-être été reçue par Meta ; préparez l'aperçu à nouveau dans une minute.` : e.message };
        return { ok: false, error: `Envoi de l'image impossible : ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }
  const pending = pendingVideos(full);
  const toUpload: PendingVideo[] = [];
  let processing = 0;
  for (const v of pending) {
    const id = v.mediaId();
    if (id) {
      // Prepared again with the same video (an undo, a second preview): the upload is not repeated.
      const row = await prisma.pilotMedia.findUnique({ where: { id }, select: { status: true, remoteId: true, accountId: true } });
      if (row && row.accountId === account && row.status !== "failed" && row.remoteId) {
        v.media.remoteId = row.remoteId;
        if (row.status !== "ready") processing++;
        continue;
      }
      v.setMediaId(undefined);
      delete v.media.remoteId;
    }
    toUpload.push(v);
  }
  if (toUpload.length) {
    if (!lend) notes.push(`L'envoi vers Meta est fermé (page en essai) : ${toUpload.length > 1 ? "les vidéos seront envoyées" : "la vidéo sera envoyée"} à Meta au moment de l'envoi, puis traitée${toUpload.length > 1 ? "s" : ""} quelques minutes.`);
    else {
      let current: PendingVideo = toUpload[0];
      try {
        await lend(`media:${account}:${adsetId}`, async (guard) => {
          for (const v of toUpload) {
            current = v;
            const up = await startVideoUpload(guard, account, full, v.media, createdById);
            v.setMediaId(up.mediaId);
            v.media.remoteId = up.videoId;
            processing++;
          }
        });
      } catch (e) {
        const where = full.format === "carousel" ? `${current.label.replace(/^Vidéo de la /, "")} : ` : full.format === "dynamic" ? `${current.label} : ` : "";
        if (isMetaWriteError(e)) return { ok: false, error: `${where}${e.kind === "uncertain" ? `${e.message} — la vidéo a peut-être été reçue par Meta ; préparez l'aperçu à nouveau dans une minute.` : e.message}` };
        return { ok: false, error: `${where}Envoi de la vidéo impossible : ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }
  if (processing) notes.push(mediaUploadingNote(processing));
  return { ok: true, spec: full, notes };
}

export type NewAdOutcome = (WriteOutcome & { adId?: string }) | { kind: "uploading"; mediaIds: string[]; error: string };

const mediaWaitText = (n: number) => (n > 1 ? "Vidéos en traitement chez Meta : la publicité sera créée automatiquement dès qu'elles sont toutes prêtes (quelques minutes)." : "Vidéo en traitement chez Meta : la publicité sera créée automatiquement dès qu'elle est prête (quelques minutes).");

/**
 * At the send. Never throws: the outcome says what happened; `adId` when the
 * ad exists; `uploading` when a video is not ready yet (the media pass
 * finishes the creation once every video of the operation is ready;
 * `mediaIds` are all the PilotMedia rows of the operation).
 */
export async function createNewAd(guard: WriteGuard, account: string, adsetId: string, spec: AdSpec, createdById: string | null = null): Promise<NewAdOutcome> {
  if (!spec.campaignId) return { kind: "refused", error: "Campagne de l'ensemble inconnue : préparez l'aperçu à nouveau." };
  const full = spec as AdSpec & { campaignId: string };
  try {
    // The ad set is read again: a dynamic creative ad set may have received an ad since the preview.
    const adset = await adsetInfo(account, adsetId);
    const mismatch = await adsetFormatError(adsetId, adset.dynamic, full.format);
    if (mismatch) return { kind: "refused", error: mismatch };
    // Writes were closed at the preview: the images go to Meta now.
    const images = pendingImages(full);
    if (images.length) await uploadImages(guard, account, images, dynamicMedia(full).images);
    const pending = pendingVideos(full);
    const mediaIds: string[] = [];
    let waiting = 0;
    for (const v of pending) {
      const id = v.mediaId();
      let row = id ? await prisma.pilotMedia.findUnique({ where: { id } }) : null;
      if (row && row.accountId !== account) row = null;
      if (!row || !row.remoteId) {
        // Writes were closed at the preview: the video goes to Meta now.
        const up = await startVideoUpload(guard, account, full, v.media, createdById);
        row = await prisma.pilotMedia.findUniqueOrThrow({ where: { id: up.mediaId } });
      }
      if (row.status === "failed") return { kind: "refused", error: `${v.label} refusée par Meta : ${row.error ?? "traitement en erreur"}.` };
      if (row.status !== "ready") {
        const st = await readVideoStatus(row.remoteId!);
        if (st.kind === "error") {
          await prisma.pilotMedia.update({ where: { id: row.id }, data: { status: "failed", error: st.detail, checkedAt: new Date() } });
          return { kind: "refused", error: `${v.label} refusée par Meta : ${st.detail}.` };
        }
        if (st.kind === "processing") {
          await prisma.pilotMedia.update({ where: { id: row.id }, data: { checkedAt: new Date() } });
          waiting++;
        } else {
          row = await prisma.pilotMedia.update({ where: { id: row.id }, data: { status: "ready", error: null, checkedAt: new Date() } });
        }
      }
      v.media.remoteId = row.remoteId!;
      v.setMediaId(row.id);
      mediaIds.push(row.id);
    }
    if (waiting) return { kind: "uploading", mediaIds, error: mediaWaitText(pending.length) };
    const out = await createPausedAd(guard, toInput(account, adsetId, full));
    return { kind: "done", adId: out.adId };
  } catch (e) {
    if (isMetaWriteError(e)) {
      if (e.kind === "uncertain" || e.kind === "not_paused") return { kind: "uncertain", error: `${e.message} — vérifiez l'ensemble dans le Gestionnaire de publicités avant de recommencer.` };
      return { kind: "refused", error: e.message };
    }
    return { kind: "refused", error: e instanceof Error ? e.message : String(e) };
  }
}

/** How long a video may stay « processing » at Meta before the creation is given up. */
export const MEDIA_MAX_WAIT_MS = 2 * 60 * 60 * 1000;

export interface MediaCheck { id: string; status: "ready" | "failed" | "uploading"; error?: string }

/**
 * Asks Meta where one PilotMedia is and records it. Never throws: a Meta
 * that does not answer leaves the row as it is (asked again next pass).
 */
export async function refreshMediaStatus(row: { id: string; remoteId: string | null; status: string; createdAt: Date }, now: Date = new Date()): Promise<MediaCheck> {
  if (row.status !== "uploading") return { id: row.id, status: row.status as MediaCheck["status"] };
  if (!row.remoteId) {
    await prisma.pilotMedia.update({ where: { id: row.id }, data: { status: "failed", error: "Vidéo jamais reçue par Meta.", checkedAt: now } });
    return { id: row.id, status: "failed", error: "Vidéo jamais reçue par Meta." };
  }
  let st: Awaited<ReturnType<typeof readVideoStatus>>;
  try {
    st = await readVideoStatus(row.remoteId);
  } catch (e) {
    if (isMetaWriteError(e) && e.kind === "refused") {
      await prisma.pilotMedia.update({ where: { id: row.id }, data: { status: "failed", error: e.message, checkedAt: now } });
      return { id: row.id, status: "failed", error: e.message };
    }
    return { id: row.id, status: "uploading" };
  }
  if (st.kind === "ready") {
    await prisma.pilotMedia.update({ where: { id: row.id }, data: { status: "ready", error: null, checkedAt: now } });
    return { id: row.id, status: "ready" };
  }
  if (st.kind === "error" || now.getTime() - row.createdAt.getTime() > MEDIA_MAX_WAIT_MS) {
    const error = st.kind === "error" ? st.detail : "Traitement de la vidéo trop long chez Meta (plus de deux heures) : publicité non créée, recommencez avec un fichier plus léger.";
    await prisma.pilotMedia.update({ where: { id: row.id }, data: { status: "failed", error, checkedAt: now } });
    return { id: row.id, status: "failed", error };
  }
  await prisma.pilotMedia.update({ where: { id: row.id }, data: { checkedAt: now } });
  return { id: row.id, status: "uploading" };
}
