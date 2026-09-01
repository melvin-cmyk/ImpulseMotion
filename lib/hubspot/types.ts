/**
 * HubSpot CRM connector — shared types (contract from the "Sources de données
 * backend" brief, 2026-09-01). Keep in sync with lib/sources.ts (Agent A).
 */

// Type-only re-export (erased at compile time → no runtime dependency on prisma).
import type { HubspotSourceConfig } from "@/lib/sources";
export type { HubspotSourceConfig };

export type CrmSource =
  | "PAID_SOCIAL"
  | "PAID_SEARCH"
  | "ORGANIC_SEARCH"
  | "SOCIAL_MEDIA"
  | "EMAIL_MARKETING"
  | "REFERRALS"
  | "DIRECT_TRAFFIC"
  | "OTHER_CAMPAIGNS"
  | "OFFLINE"
  | "UNKNOWN";

export interface CrmBucket {
  contacts: number;
  qualified: number;
  dealsCreated: number;
  dealsWon: number;
  wonAmount: number;
  openAmount: number;
}

export interface CrmCampaignRow extends CrmBucket {
  campaign: string;
  source: CrmSource;
  matched: { platform: "meta" | "google"; campaignName: string } | null;
}

export interface CrmAttributionDiagnostic {
  level: 0 | 1 | 2;
  contactsTotal: number;
  withSource: number;
  paidSource: number;
  withUtmCampaign: number;
  matchedToCampaign: number;
  utmProperty: string | null;
  recommendations: string[];
}

export interface CrmPipelineStage {
  id: string;
  label: string;
  isWon: boolean;
  isClosed: boolean;
  count: number;
  amount: number;
}

export interface CrmPipeline {
  id: string;
  label: string;
  stages: CrmPipelineStage[];
}

export interface CrmSnapshot {
  fetchedAt: string;
  range: { since: string; until: string };
  currency: string | null;
  portalId: string;
  totals: CrmBucket;
  bySource: Partial<Record<CrmSource, CrmBucket>>;
  byCampaign: CrmCampaignRow[];
  pipelines: CrmPipeline[];
  diagnostic: CrmAttributionDiagnostic;
  partial: boolean;
  warnings: string[];
}

export interface KnownCampaign {
  platform: "meta" | "google";
  name: string;
  id: string;
}

// ── Raw HubSpot shapes (subset actually read) ────────────────────────────────

/** A CRM object as returned by the v3 objects/search APIs. */
export interface HsObject {
  id: string;
  properties: Record<string, string | null | undefined>;
}

export interface HsSearchResponse {
  total?: number;
  results?: HsObject[];
  paging?: { next?: { after?: string } };
}

export interface HsProperty {
  name: string;
  label?: string;
  type?: string;
  fieldType?: string;
}

export interface HsPipelineStageRaw {
  id: string;
  label: string;
  displayOrder?: number;
  metadata?: { isClosed?: string | boolean; probability?: string | number };
}

export interface HsPipelineRaw {
  id: string;
  label: string;
  displayOrder?: number;
  stages?: HsPipelineStageRaw[];
}

export interface HsAssociationBatchResponse {
  results?: Array<{
    from: { id: string };
    to?: Array<{ toObjectId: string | number; associationTypes?: Array<{ typeId?: number; category?: string; label?: string | null }> }>;
  }>;
}
