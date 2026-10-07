/**
 * Pilotage — one door per platform. The service (lib/pilot/service.ts) reads
 * and writes through these, never through a platform module directly, so a
 * change is checked, sent, read back, journalled and undone the same way on
 * Meta and on Google Ads.
 */

import { metaAccountDigits } from "@/lib/routines/accounts";
import type { WriteGuard } from "@/lib/routines/types";
import { copyObject, readAccountCurrency, readAds, readObject, readStructure, writeField, type StructureRow, type WriteOutcome } from "@/lib/pilot/meta";
import { googleCustomerDigits, googleWritesOpen, readGoogleCurrency, readGoogleObject, readGoogleStructure, writeGoogleField } from "@/lib/pilot/google";
import type { PilotObjectState, PilotObjectType, PilotPlatform } from "@/lib/pilot/ops";

export interface PilotAdapter {
  platform: PilotPlatform;
  /** Said on the buttons and in the messages: « Envoyer à Meta », « Google Ads ne répond pas ». */
  name: string;
  /** The account id as the platform's calls take it; null when it is not one. */
  accountKey(accountId: string): string | null;
  /** `currency` when already read: Google needs it to convert budgets. */
  readStructure(account: string, currency?: string): Promise<{ campaigns: StructureRow[]; adsets: StructureRow[]; truncated: boolean }>;
  /** The ads of an ad set, read when it is opened; null when the platform has no such level here. */
  readAds: ((account: string, adsetId: string) => Promise<StructureRow[]>) | null;
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
  writesOpen: () => process.env.PILOT_WRITES === "1",
};

const google: PilotAdapter = {
  platform: "google",
  name: "Google Ads",
  accountKey: googleCustomerDigits,
  readStructure: async (account, currency) => {
    const { campaigns, adsets, truncated } = await readGoogleStructure(account, currency);
    return { campaigns, adsets, truncated };
  },
  readAds: null,
  readCurrency: readGoogleCurrency,
  readObject: (account, objectId, type, currency) => readGoogleObject(account, objectId, type, currency),
  // The guard is minted for every send; Google writes go through the n8n flow, which has no guard of its own.
  writeField: (_guard, account, objectId, type, field, value, currency) => writeGoogleField(account, objectId, type, field, value, currency),
  copyObject: null,
  writesOpen: googleWritesOpen,
};

export const PILOT_ADAPTERS: Record<PilotPlatform, PilotAdapter> = { meta, google };

export function pilotAdapter(platform: string | null | undefined): PilotAdapter | null {
  return platform === "meta" || platform === "google" ? PILOT_ADAPTERS[platform] : null;
}
