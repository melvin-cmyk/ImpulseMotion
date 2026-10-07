/**
 * Pilotage — one door per platform. The service (lib/pilot/service.ts) reads
 * and writes through these, never through a platform module directly, so a
 * change is checked, sent, read back, journalled and undone the same way on
 * Meta, Google Ads and TikTok Ads.
 */

import { metaAccountDigits } from "@/lib/routines/accounts";
import type { WriteGuard } from "@/lib/routines/types";
import { copyObject, readAccountCurrency, readAds, readObject, readStructure, rewriteAdTexts, writeField, type StructureRow, type WriteOutcome } from "@/lib/pilot/meta";
import { createGoogleKeyword, googleCustomerDigits, googleWritesOpen, readGoogleAds, readGoogleCurrency, readGoogleKeywords, readGoogleObject, readGoogleStructure, replaceGoogleRsa, writeGoogleField } from "@/lib/pilot/google";
import type { KeywordSpec, PilotObjectState, PilotObjectType, PilotPlatform } from "@/lib/pilot/ops";
import type { MetaAdTexts, RsaSpec } from "@/lib/pilot/creative";
import { readTikTokAds, readTikTokCurrency, readTikTokObject, readTikTokStructure, tiktokAdvertiserDigits, tiktokWritesOpen, writeTikTokField } from "@/lib/pilot/tiktok";

export interface PilotAdapter {
  platform: PilotPlatform;
  /** Said on the buttons and in the messages: « Envoyer à Meta », « Google Ads ne répond pas ». */
  name: string;
  /** The account id as the platform's calls take it; null when it is not one. */
  accountKey(accountId: string): string | null;
  /** `currency` when already read: Google needs it to convert budgets. `negatives`: Google's negative keywords, under their campaign. */
  readStructure(account: string, currency?: string): Promise<{ campaigns: StructureRow[]; adsets: StructureRow[]; negatives?: StructureRow[]; truncated: boolean }>;
  /** What an ad set (ad group) holds, read when it is opened: Meta its ads, Google Ads its keywords; null when nothing. */
  readAds: ((account: string, adsetId: string, currency: string) => Promise<StructureRow[]>) | null;
  /** A keyword added in an ad group (or negative on a campaign); null when the platform has no keywords. */
  createKeyword: ((guard: WriteGuard, account: string, parentId: string, spec: KeywordSpec, negative: boolean) => Promise<WriteOutcome & { createdId?: string }>) | null;
  /** Meta: new texts = a new creative the ad is switched to. */
  rewriteAdTexts: ((guard: WriteGuard, account: string, adId: string, texts: MetaAdTexts) => Promise<WriteOutcome & { creativeId?: string }>) | null;
  /** Google Ads: new texts = a new responsive search ad, the old one paused. */
  replaceRsa: ((guard: WriteGuard, account: string, adId: string, spec: RsaSpec) => Promise<WriteOutcome & { createdId?: string; oldPaused?: boolean }>) | null;
  readCurrency(account: string): Promise<string>;
  readObject(account: string, objectId: string, type: PilotObjectType, currency: string): Promise<PilotObjectState | null>;
  writeField(guard: WriteGuard, account: string, objectId: string, type: PilotObjectType, field: string, value: string | number, currency: string): Promise<WriteOutcome>;
  /** A paused copy of an object under a new name; null when the platform has no such thing here. */
  copyObject: ((guard: WriteGuard, account: string, objectId: string, type: PilotObjectType, currentName: string, newName: string) => Promise<WriteOutcome & { copiedId?: string }>) | null;
  writesOpen(): boolean;
}

const meta: PilotAdapter = {
  platform: "meta",
  name: "Meta",
  accountKey: metaAccountDigits,
  readStructure: (account) => readStructure(account),
  readAds: async (account, adsetId) => (await readAds(adsetId)).filter((a) => a.accountId === account),
  readCurrency: (account) => readAccountCurrency(account),
  readObject: (_account, objectId, type) => readObject(objectId, type),
  writeField: (guard, _account, objectId, _type, field, value) => writeField(guard, objectId, field, value),
  copyObject: (guard, _account, objectId, type, currentName, newName) => copyObject(guard, objectId, type, currentName, newName),
  createKeyword: null,
  rewriteAdTexts: (guard, account, adId, texts) => rewriteAdTexts(guard, account, adId, texts),
  replaceRsa: null,
  writesOpen: () => process.env.PILOT_WRITES === "1",
};

const google: PilotAdapter = {
  platform: "google",
  name: "Google Ads",
  accountKey: googleCustomerDigits,
  readStructure: async (account, currency) => {
    const { campaigns, adsets, negatives, truncated } = await readGoogleStructure(account, currency);
    return { campaigns, adsets, negatives, truncated };
  },
  // What an ad group holds: its keywords, then its ads.
  readAds: async (account, adGroupId, currency) => [...(await readGoogleKeywords(account, adGroupId, currency)), ...(await readGoogleAds(account, adGroupId))],
  readCurrency: readGoogleCurrency,
  readObject: (account, objectId, type, currency) => readGoogleObject(account, objectId, type, currency),
  // The guard is minted for every send; Google writes go through the n8n flow, which has no guard of its own.
  writeField: (_guard, account, objectId, type, field, value, currency) => writeGoogleField(account, objectId, type, field, value, currency),
  copyObject: null,
  // The guard is minted for every send; the n8n flow has its own secret.
  createKeyword: (_guard, account, parentId, spec, negative) => createGoogleKeyword(account, parentId, spec, negative),
  rewriteAdTexts: null,
  replaceRsa: (_guard, account, adId, spec) => replaceGoogleRsa(account, adId, spec),
  writesOpen: googleWritesOpen,
};

const tiktok: PilotAdapter = {
  platform: "tiktok",
  name: "TikTok Ads",
  accountKey: tiktokAdvertiserDigits,
  readStructure: (account, currency) => readTikTokStructure(account, currency),
  readAds: (account, adGroupId) => readTikTokAds(account, adGroupId),
  readCurrency: readTikTokCurrency,
  readObject: (account, objectId, type, currency) => readTikTokObject(account, objectId, type, currency),
  // The guard is minted for every send; TikTok writes go through the n8n flow, which has its own secret.
  writeField: (_guard, account, objectId, type, field, value, currency) => writeTikTokField(account, objectId, type, field, value, currency),
  copyObject: null,
  createKeyword: null,
  rewriteAdTexts: null,
  replaceRsa: null,
  writesOpen: tiktokWritesOpen,
};

export const PILOT_ADAPTERS: Record<PilotPlatform, PilotAdapter> = { meta, google, tiktok };

export function pilotAdapter(platform: string | null | undefined): PilotAdapter | null {
  return platform === "meta" || platform === "google" || platform === "tiktok" ? PILOT_ADAPTERS[platform] : null;
}
