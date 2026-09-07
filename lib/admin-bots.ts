import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

/** Helpers admin pour les bots privés clients (ClientBot). */
import type { BotSources } from "@/lib/bot-types";
export type { BotSources };

/** clientKey = `client_key` de l'entrepôt client_data : slug court, unique. */
export const CLIENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

export function slugifyClientKey(input: string): string {
  const s = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s.length >= 2 ? s : `client-${s}`.slice(0, 40);
}

export function parseBotSources(json: string | null | undefined): BotSources {
  if (!json) return {};
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== "object") return {};
    return sanitizeBotSources(raw as Record<string, unknown>);
  } catch {
    return {};
  }
}

export function sanitizeBotSources(raw: Record<string, unknown>): BotSources {
  const out: BotSources = {};
  if (typeof raw.meta === "boolean") out.meta = raw.meta;
  if (typeof raw.google === "boolean") out.google = raw.google;
  if (typeof raw.data === "boolean") out.data = raw.data;
  if (typeof raw.ga4PropertyId === "string") {
    const id = raw.ga4PropertyId.trim().replace(/^properties\//, "");
    if (id) out.ga4PropertyId = id;
  }
  return out;
}

/** Propose un clientKey libre à partir du nom du dashboard (suffixe -2, -3… si pris). */
export async function suggestClientKey(name: string, excludeBotId?: string): Promise<string> {
  const base = slugifyClientKey(name);
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const taken = await prisma.clientBot.findUnique({ where: { clientKey: candidate }, select: { id: true } });
    if (!taken || taken.id === excludeBotId) return candidate;
    const suffix = `-${i}`;
    candidate = base.slice(0, 40 - suffix.length) + suffix;
  }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`;
}

/** Token d'ingestion : 32 octets aléatoires en base64url ; seul le sha256 hex est stocké. */
export function generateIngestToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashIngestToken(token) };
}

export function hashIngestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Origine publique de la requête (Vercel : x-forwarded-*), pour construire l'URL d'ingest. */
export function requestOrigin(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return new URL(req.url).origin;
}
