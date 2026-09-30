/**
 * TikTok Ads advertisers attached to a client (Dashboard).
 *
 * One TikTok token reads every advertiser of the agency, and the n8n server
 * has no listing the application can use: an advertiser id is typed by a staff
 * member, checked against TikTok (`get_advertiser_info`, read by the relay's
 * direct call), shown with its name, then stored as a DashboardSource of kind
 * "tiktok" (externalId = advertiser id, label = name, config = currency and
 * timezone). Every surface scoped to a dashboard (copilot, report chat, client
 * bot) reads its ids here — never from a text written by a model.
 */

import { prisma } from "@/lib/prisma";
import { TIKTOK_SERVER } from "@/lib/mcp-whitelist";
import { relayDirectTool } from "@/lib/relay-tool";

export interface TikTokAdvertiser {
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  status: string | null;
}

export type AdvertiserCheck = { ok: true; advertiser: TikTokAdvertiser } | { ok: false; error: string };

/** A TikTok advertiser id: digits only (spaces around or inside are dropped). Anything else → null. */
export function normalizeAdvertiserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.replace(/\s+/g, "");
  return /^\d{5,25}$/.test(id) ? id : null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Reads the answer of `get_advertiser_info` for ONE advertiser.
 * TikTok answers { code, message, data: { list: [...] } }; code 0 is a success.
 */
export function parseAdvertiserInfo(result: unknown, id: string): AdvertiserCheck {
  const envelope = Array.isArray(result) && result.length === 1 ? result[0] : result;
  if (!envelope || typeof envelope !== "object") return { ok: false, error: "Réponse de TikTok illisible." };
  const { code, message, data } = envelope as { code?: unknown; message?: unknown; data?: unknown };
  if (code !== 0) {
    const detail = text(message);
    return { ok: false, error: `TikTok ne connaît pas ce compte, ou l'agence n'y a pas accès${detail ? ` (${detail})` : ""}.` };
  }
  const list = data && typeof data === "object" ? (data as { list?: unknown }).list : null;
  const row = Array.isArray(list) ? list.find((r) => r && typeof r === "object") as Record<string, unknown> | undefined : undefined;
  if (!row) return { ok: false, error: "TikTok ne renvoie aucun compte pour cet identifiant." };
  // The answer must be about the account asked for. A 19-digit id read as a
  // number has lost its last digits: it is compared within what a number can hold.
  const answered = row.advertiser_id;
  const same = typeof answered === "string" ? answered === id
    : typeof answered === "number" ? Math.abs(answered - Number(id)) <= 2048
    : false;
  if (!same) return { ok: false, error: "TikTok a répondu pour un autre compte que celui demandé." };
  const name = text(row.name);
  if (!name) return { ok: false, error: "TikTok ne donne pas de nom pour ce compte." };
  return {
    ok: true,
    advertiser: { id, name, currency: text(row.currency)?.toUpperCase() ?? null, timezone: text(row.display_timezone) ?? text(row.timezone), status: text(row.status) },
  };
}

/** Asks TikTok who this advertiser is. `id` must come from normalizeAdvertiserId. */
export async function checkAdvertiser(id: string): Promise<AdvertiserCheck> {
  if (normalizeAdvertiserId(id) !== id) return { ok: false, error: "Identifiant TikTok invalide : des chiffres seulement." };
  let result: unknown;
  try {
    result = await relayDirectTool(`${TIKTOK_SERVER}.get_advertiser_info`, { advertiser_ids: JSON.stringify([id]) }, 20000);
  } catch (e) {
    // The cause is for the logs; the message is read by a consultant.
    console.error("[tiktok] get_advertiser_info:", e instanceof Error ? e.message : String(e));
    return { ok: false, error: "TikTok n'a pas pu être interrogé pour le moment. Réessayez dans un instant ; si cela persiste, prévenez un administrateur." };
  }
  return parseAdvertiserInfo(result, id);
}

/** Advertiser ids attached to a dashboard and still in service (oldest first). */
export async function getDashboardTikTokIds(dashboardId: string): Promise<string[]> {
  const rows = await prisma.dashboardSource.findMany({
    where: { dashboardId, kind: "tiktok", status: { not: "disabled" } },
    orderBy: { createdAt: "asc" },
    select: { externalId: true },
  });
  return rows.map((r) => normalizeAdvertiserId(r.externalId)).filter((id): id is string => !!id);
}

/** Names of the OTHER dashboards this advertiser is already attached to. */
export async function dashboardsWithAdvertiser(id: string, exceptDashboardId: string): Promise<string[]> {
  const rows = await prisma.dashboardSource.findMany({
    where: { kind: "tiktok", externalId: id, dashboardId: { not: exceptDashboardId } },
    select: { dashboard: { select: { name: true } } },
  });
  return [...new Set(rows.map((r) => r.dashboard.name))];
}

/** Stores a checked advertiser on a dashboard (same advertiser again → its name and settings are refreshed). */
export async function attachTikTokAdvertiser(dashboardId: string, advertiser: TikTokAdvertiser): Promise<{ id: string }> {
  const config = JSON.stringify({ currency: advertiser.currency, timezone: advertiser.timezone });
  return prisma.dashboardSource.upsert({
    where: { dashboardId_kind_externalId: { dashboardId, kind: "tiktok", externalId: advertiser.id } },
    create: { dashboardId, kind: "tiktok", externalId: advertiser.id, label: advertiser.name, config, status: "active" },
    update: { label: advertiser.name, config, status: "active", lastError: null },
    select: { id: true },
  });
}
