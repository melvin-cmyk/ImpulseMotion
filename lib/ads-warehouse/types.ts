/**
 * Creative warehouse — shared types (lib/ads-warehouse).
 *
 * The warehouse is platform-agnostic: each platform has an ADAPTER that turns
 * its API into `CatalogRow` (one ad) and `DailyRow` (one ad × one day). The
 * orchestrator (sync.ts) owns the bookkeeping (AdSyncState), the query layer
 * (query.ts) owns the aggregations. Adding LinkedIn = adding one adapter.
 */

export type WarehousePlatform = "meta" | "google" | "tiktok" | "linkedin";
export const WAREHOUSE_PLATFORMS: WarehousePlatform[] = ["meta", "google", "tiktok", "linkedin"];

export type AdFormat = "Video" | "Image" | "Carousel" | "Unknown";

export interface CatalogRow {
  platform: WarehousePlatform;
  accountId: string;
  adId: string;
  name: string;
  status?: string | null;
  adsetId?: string | null;
  adsetName?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  format: AdFormat;
  dynamic?: boolean;
  creativeId?: string | null;
  creativeKey?: string | null;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  videoId?: string | null;
  previewUrl?: string | null;
  title?: string | null;
  body?: string | null;
  cta?: string | null;
  landingUrl?: string | null;
  createdTime?: Date | null;
  platformUpdatedAt?: Date | null;
  /** Tags parsed from the name (naming.ts); AI tags are merged later. */
  tags: Record<string, string>;
}

export interface DailyRow {
  platform: WarehousePlatform;
  accountId: string;
  adId: string;
  /** yyyy-mm-dd in the account time zone. */
  date: string;
  currency?: string | null;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  conversions: number;
  conversionValue: number;
  purchases: number;
  purchaseValue: number;
  leads: number;
  videoPlays: number;
  video3s: number;
  thruPlays: number;
  videoP25: number;
  videoP50: number;
  videoP75: number;
  videoP100: number;
  actions: Record<string, number>;
  /** Name/adset/campaign carried by the insight row — lets the catalogue name an ad whose metadata is unreachable. */
  adName?: string;
  adsetId?: string;
  adsetName?: string;
  campaignId?: string;
  campaignName?: string;
}

export interface SyncWindow {
  /** yyyy-mm-dd inclusive. */
  since: string;
  until: string;
}

export interface AdapterSyncInput {
  accountId: string;
  window: SyncWindow;
  /** Re-read the metadata of every ad delivered in the window (weekly refresh) instead of only the unknown + recently updated ones. */
  fullMetadata: boolean;
  /** Only ads updated after this instant need their metadata re-read (ignored when fullMetadata). */
  metadataSince: Date | null;
  /** Ads already in the catalogue for this account (their metadata is only re-read when fullMetadata). */
  knownAdIds: Set<string>;
  deadline: number;
}

export interface AdapterSyncOutput {
  daily: DailyRow[];
  catalog: CatalogRow[];
  /** The platform list was capped: the window must be split further next time. */
  truncated: boolean;
  currency: string | null;
}

export interface WarehouseAdapter {
  platform: WarehousePlatform;
  /** Every account id of this platform the agency manages (dashboards + sources). */
  listAccounts(): Promise<string[]>;
  sync(input: AdapterSyncInput): Promise<AdapterSyncOutput>;
}

export const catalogId = (platform: string, adId: string) => `${platform}:${adId}`;
export const dailyId = (platform: string, adId: string, date: string) => `${platform}:${adId}:${date}`;
export const stateId = (platform: string, accountId: string) => `${platform}:${accountId}`;
