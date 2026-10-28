/**
 * Pilotage — what the parts of « Nouvelle publicité » share (components/pilot/ad-form):
 * the buttons Meta offers, the Studio assets as the pickers see them, the
 * platforms and formats with what is open today.
 */

import type { MediaRef } from "@/lib/pilot/ad-spec";

export const CTA_FR: Array<[string, string]> = [
  ["LEARN_MORE", "En savoir plus"], ["SHOP_NOW", "Acheter"], ["BUY_NOW", "Acheter maintenant"], ["ORDER_NOW", "Commander"],
  ["SIGN_UP", "S'inscrire"], ["SUBSCRIBE", "S'abonner"], ["BOOK_NOW", "Réserver"], ["BOOK_TRAVEL", "Réserver (voyage)"],
  ["CONTACT_US", "Nous contacter"], ["GET_OFFER", "Profiter de l'offre"], ["GET_QUOTE", "Demander un devis"], ["APPLY_NOW", "Postuler"],
  ["DOWNLOAD", "Télécharger"], ["SEE_MORE", "Voir plus"], ["WATCH_MORE", "Regarder plus"], ["DONATE_NOW", "Faire un don"], ["NO_BUTTON", "Sans bouton"],
];
export const ctaLabel = (value: string | undefined | null) => (value ? CTA_FR.find(([v]) => v === value)?.[1] ?? value : "En savoir plus");

/** A completed Studio asset, image or video, with its public link. */
export type StudioMedia = { id: string; url: string; prompt: string; kind: "image" | "video"; sourceId: string | null; clientId: string | null; clientName?: string };
/** A Studio visual chosen beforehand (« Pousser sur Meta », /pilotage?studioAsset=…). */
export type StudioPick = { id: string; url: string; prompt: string; clientId: string | null; kind?: "image" | "video"; sourceId?: string | null };

/** The media of a Studio asset as a spec takes it; a video takes the Studio image it was animated from as its thumbnail. */
export function studioMediaRef(a: StudioMedia, studio: StudioMedia[]): MediaRef {
  if (a.kind === "video") {
    const source = a.sourceId ? studio.find((s) => s.id === a.sourceId && s.kind === "image") : undefined;
    return { kind: "video", url: a.url, studioAssetId: a.id, ...(source ? { thumbUrl: source.url, thumbStudioAssetId: source.id } : {}) };
  }
  return { kind: "image", url: a.url, studioAssetId: a.id };
}

export type AdPlatform = "meta" | "google" | "tiktok";
export const AD_PLATFORM_TABS: Array<{ id: AdPlatform; label: string; soon: string | null }> = [
  { id: "meta", label: "Meta", soon: null },
  { id: "google", label: "Google Ads", soon: "Bientôt : annonces display et Demand Gen (le flux n8n d'écriture doit d'abord accepter les images)." },
  { id: "tiktok", label: "TikTok Ads", soon: "Bientôt : le jeton TikTok n'a pas encore le droit « médiathèque » et aucun annonceur de test n'est désigné." },
];

export type AdFormatTab = "image" | "video" | "carousel" | "dynamic";
export const AD_FORMAT_TABS: Array<{ id: AdFormatTab; label: string; soon: string | null }> = [
  { id: "image", label: "Image", soon: null },
  { id: "video", label: "Vidéo", soon: null },
  { id: "carousel", label: "Carrousel", soon: null },
  { id: "dynamic", label: "Dynamique", soon: "Bientôt : création dynamique (plusieurs visuels et textes, Meta choisit la combinaison) — lot suivant." },
];

export const input = "w-full bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-violet-500";
export const tabClass = (on: boolean, disabled = false) =>
  `px-3 py-1.5 text-xs rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${disabled ? "border-gray-800/60 text-gray-600 cursor-not-allowed" : on ? "border-violet-500 text-white bg-violet-500/10" : "border-gray-800 text-gray-400 hover:text-white"}`;

/** Left/Right (and Home/End) move between the tabs of a tablist, as the ARIA pattern asks. */
export function tabKeyNav<T extends string>(e: React.KeyboardEvent, ids: T[], current: T, select: (id: T) => void) {
  const i = ids.indexOf(current);
  if (i < 0 || !ids.length) return;
  const next = e.key === "ArrowRight" ? ids[(i + 1) % ids.length] : e.key === "ArrowLeft" ? ids[(i - 1 + ids.length) % ids.length] : e.key === "Home" ? ids[0] : e.key === "End" ? ids[ids.length - 1] : null;
  if (!next) return;
  e.preventDefault();
  select(next);
  (e.currentTarget.parentElement?.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
}
