/**
 * Lecture des jeux de données d'un dashboard du staff : chaque source est UN
 * appel d'outil du relay (/api/tool, sans IA), dans le périmètre de comptes
 * de la personne (lib/scope.ts), avec les paramètres du dashboard remplacés.
 * Les réponses sont gardées quelques minutes par (dashboard, jeu, arguments)
 * pour que rouvrir la page ne rappelle pas Google ou Meta.
 */

import { createHash } from "node:crypto";
import { relayDirectTool } from "@/lib/relay-tool";
import { googleInScope, metaInScope, tiktokInScope, type AccountScope } from "@/lib/scope";
import { accountsOfCall, connectorServer, substituteParams, type Dataset, type ParamValue } from "./model";

export type DatasetResult =
  | { status: "ok"; answer: unknown; args: Record<string, unknown>; at: string; cached?: boolean }
  | { status: "error" | "declined"; message: string; args?: Record<string, unknown>; at: string };

const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 60_000;
const CONCURRENCY = 4;
const cache = new Map<string, { at: number; value: DatasetResult }>();

function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
}

/** Périmètre : chaque compte nommé par l'appel doit être attribué à la personne. */
export function scopeRefusal(server: string, args: Record<string, unknown>, scope: AccountScope): string | null {
  for (const a of accountsOfCall(server, args)) {
    const ok = a.platform === "google" ? googleInScope(scope, a.id) : a.platform === "meta" ? metaInScope(scope, a.id) : tiktokInScope(scope, a.id);
    if (!ok) return `Compte ${a.platform} ${a.id} hors de votre périmètre.`;
  }
  return null;
}

export async function runDataset(
  dashboardId: string,
  id: string,
  ds: Dataset,
  params: Record<string, ParamValue>,
  scope: AccountScope,
  opts: { refresh?: boolean } = {},
): Promise<DatasetResult> {
  const server = connectorServer(ds.source.connector);
  const at = new Date().toISOString();
  if (!server) return { status: "error", message: `Connecteur inconnu : ${ds.source.connector}`, at };
  const args = substituteParams(ds.source.args, params);
  const refusal = scopeRefusal(server, args, scope);
  if (refusal) return { status: "declined", message: refusal, args, at };

  const key = `${dashboardId}:${id}:${hash([server, ds.source.tool, args])}`;
  const hit = cache.get(key);
  if (!opts.refresh && hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true } as DatasetResult;

  try {
    const answer = await relayDirectTool(`${server}.${ds.source.tool}`, args, TIMEOUT_MS);
    const value: DatasetResult = { status: "ok", answer, args, at };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[staff-dashboards] ${dashboardId}/${id} ${server}.${ds.source.tool}:`, message);
    return { status: "error", message: message.replace(/[A-Za-z0-9_-]{40,}/g, "[…]").slice(0, 500), args, at };
  }
}

/** Lit plusieurs jeux en parallèle (4 à la fois). */
export async function runDatasets(
  dashboardId: string,
  datasets: Record<string, Dataset>,
  ids: string[],
  params: Record<string, ParamValue>,
  scope: AccountScope,
  opts: { refresh?: boolean } = {},
): Promise<Record<string, DatasetResult>> {
  const out: Record<string, DatasetResult> = {};
  const queue = ids.filter((id) => datasets[id]);
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift()!;
      out[id] = await runDataset(dashboardId, id, datasets[id], params, scope, opts);
    }
  });
  await Promise.all(workers);
  for (const id of ids) if (!out[id]) out[id] = { status: "error", message: "Jeu de données inconnu", at: new Date().toISOString() };
  return out;
}

export function forgetDashboardCache(dashboardId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${dashboardId}:`)) cache.delete(k);
}
