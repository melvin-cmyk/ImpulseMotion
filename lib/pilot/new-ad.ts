/**
 * Pilotage — a new Meta ad in an ad set (kind "create_ad"), on the same
 * writes as the routines (lib/meta-write.ts): an image ad, always created
 * PAUSED, read back, paused again if it is not.
 *
 *   identities  the Pages the ad account may promote and its Instagram
 *               accounts, to fill the form;
 *   check       before the preview: the ad set and its campaign, the Page
 *               (one the account may promote — an ad of a client never leaves
 *               under the Page of another), the Instagram account when
 *               given, every field; the campaign is kept in the spec;
 *   create      at the send, with the guard of the action.
 */

import { getMetaSystemToken, metaGraphGetOnce } from "@/lib/meta-api";
import {
  checkAdIdentity, createPausedAd, isMetaWriteError, listPromotablePages, pausedAdInputError, verifyPagePromotable,
  type PausedAdInput, type PromotablePage,
} from "@/lib/meta-write";
import type { WriteGuard } from "@/lib/routines/types";
import type { NewAdSpec } from "@/lib/pilot/ops";
import type { WriteOutcome } from "@/lib/pilot/meta";

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

/** The campaign of an ad set of the account; throws when it is not one of the account. */
async function adsetCampaign(account: string, adsetId: string): Promise<string> {
  const data = await metaGraphGetOnce<{ id?: string; account_id?: string; campaign_id?: string }>(`/${adsetId}`, getMetaSystemToken(), { fields: "id,account_id,campaign_id" });
  if (String(data?.id ?? "") !== adsetId || String(data.account_id ?? "").replace(/^act_/, "") !== account) throw new Error("Cet ensemble de publicités n'appartient pas au compte.");
  if (!/^\d{5,25}$/.test(String(data.campaign_id ?? ""))) throw new Error("Campagne de l'ensemble illisible.");
  return String(data.campaign_id);
}

const toInput = (account: string, adsetId: string, spec: NewAdSpec & { campaignId: string }): PausedAdInput => ({
  accountId: account, campaignId: spec.campaignId, adsetId, pageId: spec.pageId, instagramUserId: spec.instagramUserId,
  name: spec.name, primaryText: spec.primaryText, headline: spec.headline, description: spec.description,
  linkUrl: spec.linkUrl, callToAction: spec.callToAction, imageUrl: spec.imageUrl,
});

/** Before the preview: everything Meta will be asked, checked now. */
export async function checkNewAd(account: string, adsetId: string, spec: NewAdSpec): Promise<{ ok: true; spec: NewAdSpec & { campaignId: string }; notes: string[] } | { ok: false; error: string }> {
  let campaignId: string;
  try { campaignId = await adsetCampaign(account, adsetId); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  const full = { ...spec, campaignId };
  const invalid = pausedAdInputError(toInput(account, adsetId, full));
  if (invalid) return { ok: false, error: `Publicité refusée : ${invalid}.` };
  try {
    await verifyPagePromotable(account, spec.pageId);
  } catch (e) {
    return { ok: false, error: isMetaWriteError(e) ? e.message : "La Page n'a pas pu être vérifiée : réessayez dans quelques minutes." };
  }
  const identity = await checkAdIdentity(account, spec.pageId, spec.instagramUserId);
  return { ok: true, spec: full, notes: identity.notes };
}

/** At the send. Never throws: the outcome says what happened; `adId` when the ad exists. */
export async function createNewAd(guard: WriteGuard, account: string, adsetId: string, spec: NewAdSpec): Promise<WriteOutcome & { adId?: string }> {
  if (!spec.campaignId) return { kind: "refused", error: "Campagne de l'ensemble inconnue : préparez l'aperçu à nouveau." };
  try {
    const out = await createPausedAd(guard, toInput(account, adsetId, spec as NewAdSpec & { campaignId: string }));
    return { kind: "done", adId: out.adId };
  } catch (e) {
    if (isMetaWriteError(e)) {
      if (e.kind === "uncertain" || e.kind === "not_paused") return { kind: "uncertain", error: `${e.message} — vérifiez l'ensemble dans le Gestionnaire de publicités avant de recommencer.` };
      return { kind: "refused", error: e.message };
    }
    return { kind: "refused", error: e instanceof Error ? e.message : String(e) };
  }
}
