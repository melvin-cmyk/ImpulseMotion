/**
 * Entrepôt client_data vu par le STAFF (console /ai, copilotes) : la liste
 * fermée des clients dont l'entrepôt est alimenté (bots avec la source
 * « Données e-commerce » ou « Fichiers de données »), passée au relay comme
 * `dataScope.staff`. Le relay monte alors le serveur MCP client-data épinglé
 * sur ces clés (le modèle choisit un client dans la liste, jamais en dehors)
 * sans rien retirer au consultant (HQ, Notion, Magento, web restent ouverts).
 *
 * Un bot client, lui, reste épinglé sur sa seule clé (app/api/bot/[botId]/chat).
 */

import { prisma } from "@/lib/prisma";
import { parseSources } from "@/lib/bot-types";

export type StaffDataTool = "orders" | "datasets";

export interface StaffDataScope {
  staff: true;
  clientKeys: string[];
  tools: StaffDataTool[];
}

export interface StaffDataClient {
  clientKey: string;
  dashboardId: string;
  name: string;
  tools: StaffDataTool[];
}

const MEMO_MS = 60_000;
let memo: { at: number; clients: StaffDataClient[] } | null = null;

/** Pour les tests : oublie la liste mémorisée. */
export function resetStaffDataScopeMemo(): void {
  memo = null;
}

/** Clients dont l'entrepôt est alimenté (toute fiche bot avec une source de données cochée, activée ou non). */
export async function listStaffDataClients(): Promise<StaffDataClient[]> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.clients;
  const bots = await prisma.clientBot.findMany({
    select: { clientKey: true, dashboardId: true, sourcesJson: true, dashboard: { select: { name: true } } },
    orderBy: { clientKey: "asc" },
  });
  const clients: StaffDataClient[] = [];
  for (const b of bots) {
    const sources = parseSources(b.sourcesJson);
    const tools: StaffDataTool[] = [];
    if (sources.data) tools.push("orders");
    if (sources.files) tools.push("datasets");
    if (!tools.length) continue;
    clients.push({ clientKey: b.clientKey, dashboardId: b.dashboardId, name: b.dashboard.name, tools });
  }
  memo = { at: Date.now(), clients };
  return clients;
}

function scopeOf(clients: StaffDataClient[]): StaffDataScope | undefined {
  if (!clients.length) return undefined;
  const tools = new Set<StaffDataTool>();
  for (const c of clients) for (const t of c.tools) tools.add(t);
  return { staff: true, clientKeys: clients.map((c) => c.clientKey), tools: [...tools] };
}

/** Console /ai et dashboards du staff : tous les clients alimentés. */
export async function staffDataScopeForAll(): Promise<StaffDataScope | undefined> {
  return scopeOf(await listStaffDataClients());
}

/** Copilote d'un dashboard client : seulement l'entrepôt de ce client. */
export async function staffDataScopeForDashboard(dashboardId: string): Promise<StaffDataScope | undefined> {
  return scopeOf((await listStaffDataClients()).filter((c) => c.dashboardId === dashboardId));
}

/** Ligne de contexte (partie dynamique du prompt) : quels clients, sous quelle clé. */
export function staffDataClientsLine(clients: StaffDataClient[]): string {
  if (!clients.length) return "";
  const parts = clients.map((c) => `${c.name} (client = « ${c.clientKey} »${c.tools.includes("datasets") ? ", avec fichiers déposés" : ""})`);
  return `ENTREPÔT E-COMMERCE DISPONIBLE (outils data_*) pour : ${parts.join(" ; ")}.`;
}
