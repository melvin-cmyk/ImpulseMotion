/**
 * Data sources attached to a client (Dashboard).
 *  - meta / google: legacy, read from the Dashboard columns (metaAccountId /
 *    googleCustomerId) and synthesised as read-only refs (legacy: true, id: null).
 *  - hubspot (and later shopify / csv…): rows in DashboardSource, secret encrypted
 *    with lib/secrets.ts. The encrypted secret is NEVER part of a DashboardSourceRef.
 */

import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/secrets";

export type SourceKind = "meta" | "google" | "hubspot";
export type SourceStatus = "active" | "error" | "disabled";

export interface DashboardSourceRef {
  id: string | null;
  kind: SourceKind;
  externalId: string;
  label: string | null;
  config: Record<string, unknown>;
  status: SourceStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  hasSecret: boolean;
  legacy: boolean;
}

export interface HubspotSourceConfig {
  pipelineIds?: string[];
  qualifiedStageIds?: string[];
  wonStageIds?: string[];
  currency?: string | null;
  utmCampaignProperty?: string | null;
}

export class SourceNotFoundError extends Error {
  constructor(message = "Source introuvable") { super(message); this.name = "SourceNotFoundError"; }
}

interface SourceRow {
  id: string;
  kind: string;
  externalId: string;
  label: string | null;
  config: string;
  secretEnc: string | null;
  status: string;
  lastSyncAt: Date | null;
  lastError: string | null;
}

const SOURCE_SELECT = {
  id: true, kind: true, externalId: true, label: true, config: true, secretEnc: true, status: true, lastSyncAt: true, lastError: true,
} as const;

function parseConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asStatus(s: string): SourceStatus {
  return s === "error" || s === "disabled" ? s : "active";
}

/** Public view of a stored row — strips the encrypted secret. */
export function toSourceRef(row: SourceRow): DashboardSourceRef {
  return {
    id: row.id,
    kind: row.kind as SourceKind,
    externalId: row.externalId,
    label: row.label,
    config: parseConfig(row.config),
    status: asStatus(row.status),
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastError: row.lastError,
    hasSecret: !!row.secretEnc,
    legacy: false,
  };
}

function legacyRef(kind: "meta" | "google", externalId: string): DashboardSourceRef {
  return { id: null, kind, externalId, label: null, config: {}, status: "active", lastSyncAt: null, lastError: null, hasSecret: false, legacy: true };
}

/** All sources of a dashboard: legacy Meta / Google first, then stored rows (oldest first). */
export async function listSources(dashboardId: string): Promise<DashboardSourceRef[]> {
  const dashboard = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: {
      metaAccountId: true,
      googleCustomerId: true,
      sources: { select: SOURCE_SELECT, orderBy: { createdAt: "asc" } },
    },
  });
  if (!dashboard) throw new SourceNotFoundError("Dashboard introuvable");
  const out: DashboardSourceRef[] = [];
  if (dashboard.metaAccountId) out.push(legacyRef("meta", dashboard.metaAccountId.replace(/^act_/, "")));
  if (dashboard.googleCustomerId) out.push(legacyRef("google", dashboard.googleCustomerId.replace(/-/g, "")));
  for (const row of dashboard.sources) out.push(toSourceRef(row));
  return out;
}

/** The HubSpot source of a dashboard with its decrypted token, or null when none / no token. */
export async function getHubspotSource(dashboardId: string): Promise<{ ref: DashboardSourceRef; token: string; config: HubspotSourceConfig } | null> {
  const row = await prisma.dashboardSource.findFirst({
    where: { dashboardId, kind: "hubspot" },
    orderBy: { createdAt: "asc" },
    select: SOURCE_SELECT,
  });
  if (!row || !row.secretEnc) return null;
  const token = decryptSecret(row.secretEnc);
  const ref = toSourceRef(row);
  return { ref, token, config: ref.config as HubspotSourceConfig };
}

const HUBSPOT_CONFIG_KEYS: Array<keyof HubspotSourceConfig> = ["pipelineIds", "qualifiedStageIds", "wonStageIds", "currency", "utmCampaignProperty"];

function sanitizeHubspotConfig(input: Partial<HubspotSourceConfig> | undefined): Partial<HubspotSourceConfig> {
  const out: Partial<HubspotSourceConfig> = {};
  if (!input) return out;
  const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : undefined);
  const strOrNull = (v: unknown) => (v === null ? null : typeof v === "string" ? (v.trim() || null) : undefined);
  for (const key of HUBSPOT_CONFIG_KEYS) {
    if (!(key in input)) continue;
    const v = (input as Record<string, unknown>)[key];
    if (key === "pipelineIds" || key === "qualifiedStageIds" || key === "wonStageIds") {
      const list = strList(v);
      if (list) out[key] = list;
    } else if (key === "currency") {
      const s = strOrNull(v);
      if (s !== undefined) out.currency = s ? s.toUpperCase() : null;
    } else {
      const s = strOrNull(v);
      if (s !== undefined) out.utmCampaignProperty = s;
    }
  }
  return out;
}

/**
 * Create or update the HubSpot source of a dashboard (unique per portal).
 * A new token resets status to "active"; config is merged with the stored one.
 * Encrypting requires SOURCE_SECRETS_KEY (throws otherwise — callers pre-check
 * with hasSecretsKey()).
 */
export async function upsertHubspotSource(input: { dashboardId: string; portalId: string; token?: string; label?: string; config?: Partial<HubspotSourceConfig> }): Promise<DashboardSourceRef> {
  const portalId = input.portalId.trim();
  if (!portalId) throw new Error("portalId requis");
  const token = input.token?.trim() || undefined;
  const secretEnc = token ? encryptSecret(token) : undefined;
  const label = input.label === undefined ? undefined : (input.label.trim() || null);
  const patch = sanitizeHubspotConfig(input.config);

  const where = { dashboardId_kind_externalId: { dashboardId: input.dashboardId, kind: "hubspot", externalId: portalId } };
  const existing = await prisma.dashboardSource.findUnique({ where, select: { config: true } });
  const mergedConfig = { ...(existing ? parseConfig(existing.config) : {}), ...patch };
  const configJson = JSON.stringify(mergedConfig);

  const row = await prisma.dashboardSource.upsert({
    where,
    create: {
      dashboardId: input.dashboardId,
      kind: "hubspot",
      externalId: portalId,
      label: label ?? null,
      config: configJson,
      secretEnc: secretEnc ?? null,
      status: "active",
    },
    update: {
      config: configJson,
      ...(label !== undefined ? { label } : {}),
      ...(secretEnc ? { secretEnc, status: "active", lastError: null } : {}),
    },
    select: SOURCE_SELECT,
  });
  return toSourceRef(row);
}

/** Delete a stored source; throws SourceNotFoundError when it does not belong to the dashboard. */
export async function removeSource(dashboardId: string, sourceId: string): Promise<void> {
  const { count } = await prisma.dashboardSource.deleteMany({ where: { id: sourceId, dashboardId } });
  if (count === 0) throw new SourceNotFoundError();
}

/** Record the outcome of a sync / fetch on a stored source. */
export async function markSourceSync(sourceId: string, r: { ok: true } | { ok: false; error: string }): Promise<void> {
  await prisma.dashboardSource.update({
    where: { id: sourceId },
    data: r.ok
      ? { status: "active", lastSyncAt: new Date(), lastError: null }
      : { status: "error", lastError: r.error.slice(0, 1000) },
  }).catch(() => null);
}
