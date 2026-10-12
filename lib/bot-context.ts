/**
 * Warehouse facts injected in the client bot's system prompt: the e-commerce
 * coverage (orders) and the loaded datasets (files of the Drive folder).
 *
 * Both change only when n8n ingests, so they are memoised per client for a few
 * minutes: re-querying on every turn is wasted latency and busts the prompt
 * prefix. `lib/client-data*` may be absent or unconfigured (no
 * DATA_DATABASE_URL); either way the bot must still answer.
 */

import type { BotDataCoverage, BotDatasetInfo } from "@/lib/bot-prompt";

const TTL_MS = 10 * 60 * 1000;
const QUERY_TIMEOUT_MS = 5000;

const coverageMemo = new Map<string, { at: number; value: BotDataCoverage | null }>();
const datasetsMemo = new Map<string, { at: number; value: BotDatasetInfo[] }>();

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), QUERY_TIMEOUT_MS))]);
}

export async function loadBotCoverage(clientKey: string): Promise<BotDataCoverage | null> {
  const hit = coverageMemo.get(clientKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: BotDataCoverage | null = null;
  try {
    const mod = (await import("@/lib/client-data")) as { getCoverage?: (key: string) => Promise<BotDataCoverage | null> };
    if (typeof mod.getCoverage === "function") value = await withTimeout(mod.getCoverage(clientKey), null);
  } catch {
    value = null;
  }
  coverageMemo.set(clientKey, { at: Date.now(), value });
  return value;
}

/** Loaded datasets only (a file still being loaded, or in error, is not announced). */
export async function loadBotDatasets(clientKey: string): Promise<BotDatasetInfo[]> {
  const hit = datasetsMemo.get(clientKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: BotDatasetInfo[] = [];
  try {
    const mod = (await import("@/lib/client-datasets")) as { listDatasets?: (key: string) => Promise<BotDatasetInfo[]> };
    if (typeof mod.listDatasets === "function") {
      value = (await withTimeout(mod.listDatasets(clientKey), [])).filter((d) => d && d.rowCount > 0);
    }
  } catch {
    value = [];
  }
  datasetsMemo.set(clientKey, { at: Date.now(), value });
  return value;
}

/** Forgets what was memoised (after an ingest, or between tests). */
export function resetBotContextMemos(clientKey?: string): void {
  if (clientKey) {
    coverageMemo.delete(clientKey);
    datasetsMemo.delete(clientKey);
  } else {
    coverageMemo.clear();
    datasetsMemo.clear();
  }
}
