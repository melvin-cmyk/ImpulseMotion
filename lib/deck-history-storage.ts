/**
 * Deck history storage layer.
 * Tries Prisma (PostgreSQL) first; falls back to an in-memory Map if DB is unavailable.
 */

import type { Slide } from "@/app/api/deck/generate/route";

export interface DeckHistoryEntry {
  id: string;
  clientId: string;
  clientName: string;
  platform: string;
  period: string;
  startDate: string; // ISO string
  endDate: string;   // ISO string
  slides: Slide[];
  metrics: Record<string, unknown>;
  createdAt: string; // ISO string
  userId?: string;
}

// ── In-memory fallback ────────────────────────────────────────────────────────

type MemStore = Map<string, DeckHistoryEntry[]>; // key = clientId

const globalMem = globalThis as unknown as { _deckHistoryMem?: MemStore };
if (!globalMem._deckHistoryMem) globalMem._deckHistoryMem = new Map();
const memStore: MemStore = globalMem._deckHistoryMem;

function memSave(entry: DeckHistoryEntry): void {
  const list = memStore.get(entry.clientId) ?? [];
  list.unshift(entry); // newest first
  memStore.set(entry.clientId, list.slice(0, 50)); // keep max 50 per client
}

function memGet(clientId: string, limit = 12): DeckHistoryEntry[] {
  return (memStore.get(clientId) ?? []).slice(0, limit);
}

// ── Prisma helpers ────────────────────────────────────────────────────────────

async function prismaSave(entry: DeckHistoryEntry): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  await (prisma as any).deckHistory.create({
    data: {
      id: entry.id,
      clientId: entry.clientId,
      clientName: entry.clientName,
      platform: entry.platform,
      period: entry.period,
      startDate: new Date(entry.startDate),
      endDate: new Date(entry.endDate),
      slidesJson: JSON.stringify(entry.slides),
      metricsJson: JSON.stringify(entry.metrics),
      createdAt: new Date(entry.createdAt),
      userId: entry.userId ?? null,
    },
  });
}

async function prismaGet(clientId: string, limit = 12, forUserId?: string): Promise<DeckHistoryEntry[]> {
  const { prisma } = await import("@/lib/prisma");
  const rows = await (prisma as any).deckHistory.findMany({
    where: { clientId, ...(forUserId ? { userId: forUserId } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r: any) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    platform: r.platform,
    period: r.period,
    startDate: r.startDate instanceof Date ? r.startDate.toISOString() : String(r.startDate),
    endDate: r.endDate instanceof Date ? r.endDate.toISOString() : String(r.endDate),
    slides: JSON.parse(r.slidesJson || "[]"),
    metrics: JSON.parse(r.metricsJson || "{}"),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    userId: r.userId ?? undefined,
  }));
}

async function prismaGetById(id: string): Promise<DeckHistoryEntry | null> {
  const { prisma } = await import("@/lib/prisma");
  const r = await (prisma as any).deckHistory.findUnique({ where: { id } });
  if (!r) return null;
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    platform: r.platform,
    period: r.period,
    startDate: r.startDate instanceof Date ? r.startDate.toISOString() : String(r.startDate),
    endDate: r.endDate instanceof Date ? r.endDate.toISOString() : String(r.endDate),
    slides: JSON.parse(r.slidesJson || "[]"),
    metrics: JSON.parse(r.metricsJson || "{}"),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    userId: r.userId ?? undefined,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveDeckHistory(entry: DeckHistoryEntry): Promise<void> {
  try {
    await prismaSave(entry);
  } catch (err) {
    console.warn("[deck-history] Prisma save failed, falling back to memory:", err);
    memSave(entry);
  }
}

export async function getDeckHistory(clientId: string, limit = 12, forUserId?: string): Promise<DeckHistoryEntry[]> {
  try {
    return await prismaGet(clientId, limit, forUserId);
  } catch (err) {
    console.warn("[deck-history] Prisma get failed, falling back to memory:", err);
    const entries = memGet(clientId, limit);
    return forUserId ? entries.filter((e) => e.userId === forUserId) : entries;
  }
}

export async function getDeckHistoryById(id: string): Promise<DeckHistoryEntry | null> {
  // Try Prisma first
  try {
    return await prismaGetById(id);
  } catch {
    // fallback: search in memory across all clients
    for (const entries of memStore.values()) {
      const found = entries.find((e) => e.id === id);
      if (found) return found;
    }
    return null;
  }
}
