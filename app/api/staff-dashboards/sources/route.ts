/**
 * GET /api/staff-dashboards/sources — ce que le sélecteur de sources d'un
 * dashboard du staff propose : les clients et leurs comptes Meta / Google /
 * TikTok du périmètre de la personne (même liste que Pilotage), et les clients
 * dont l'entrepôt e-commerce est alimenté (outils data_*).
 *   → { clients: [{ id, name, accounts: [{ platform, accountId, name, currency }] }], warehouses: [{ clientKey, name, tools }] }
 */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";
import { loadAlertClients } from "@/lib/auto-alerts/clients";
import { listStaffDataClients } from "@/lib/staff-data-scope";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const scope = await getAccountScope(guard.session);
  const [clients, warehouses] = await Promise.all([
    loadAlertClients(scope).catch((e) => { console.error("[staff-dashboards/sources] clients unreadable", e); return []; }),
    listStaffDataClients().catch((e) => { console.error("[staff-dashboards/sources] warehouses unreadable", e); return []; }),
  ]);
  return NextResponse.json({
    clients: clients
      .map((c) => ({
        id: c.id,
        name: c.name,
        accounts: c.accounts
          .filter((a) => platformAccountInScope(scope, a.platform, a.accountId))
          .map((a) => ({ platform: a.platform, accountId: a.accountId, name: a.name, currency: a.currency })),
      }))
      .filter((c) => c.accounts.length),
    warehouses: warehouses.map((w) => ({ clientKey: w.clientKey, name: w.name, tools: w.tools })),
  }, { headers: { "Cache-Control": "no-store" } });
}
