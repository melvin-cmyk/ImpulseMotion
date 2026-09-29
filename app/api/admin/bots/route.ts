import { NextResponse } from "next/server";
import { requireRealAdmin } from "@/lib/auth-helpers";
import { buildBotClients, countBotClients, loadBotClientInputs, planBotDashboard } from "@/lib/bot-clients";
import { createDashboardForUser } from "@/lib/dashboard-widgets";

/**
 * Liste tous les clients de l'agence (AlertClient) avec leurs comptes, leurs
 * dashboards et l'état de leur bot privé. Admin only.
 *
 * `dashboards` garde la forme d'avant (une ligne par dashboard) pour un écran
 * qui la lirait encore.
 */
export async function GET() {
  const guard = await requireRealAdmin();
  if ("error" in guard) return guard.error;

  const inputs = await loadBotClientInputs();
  const list = buildBotClients(inputs);

  return NextResponse.json({
    clients: list.clients,
    orphans: list.orphans,
    counts: countBotClients(list),
    dashboards: inputs.dashboards.map((d) => ({
      id: d.id,
      name: d.name,
      metaAccountId: d.metaAccountId,
      googleCustomerId: d.googleCustomerId,
      ownerEmail: d.ownerEmail,
      bot: d.bot
        ? {
            id: d.bot.id,
            enabled: d.bot.enabled,
            name: d.bot.name,
            clientKey: d.bot.clientKey,
            accessCount: d.bot.accessCount,
            lastIngestAt: d.bot.lastIngestAt,
          }
        : null,
    })),
  });
}

/**
 * Ouvre un bot à un client : { clientId, metaAccountId?, googleCustomerId? }.
 * Crée le dashboard du client s'il n'en a pas sur ces comptes et renvoie son
 * identifiant ; le bot lui-même se règle ensuite sur /admin/bots/[dashboardId].
 *
 * Les comptes sont ceux que l'admin a choisis. La liste est relue ici : un
 * compte qui n'est pas celui du client désigné est refusé.
 */
export async function POST(req: Request) {
  const guard = await requireRealAdmin();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) return NextResponse.json({ error: "clientId requis" }, { status: 400 });
  for (const field of ["metaAccountId", "googleCustomerId"] as const) {
    if (body[field] != null && typeof body[field] !== "string") {
      return NextResponse.json({ error: `${field} invalide` }, { status: 400 });
    }
  }

  const client = buildBotClients(await loadBotClientInputs()).clients.find((c) => c.id === clientId);
  if (!client) return NextResponse.json({ error: "client introuvable" }, { status: 404 });

  const plan = planBotDashboard(client, { metaAccountId: body.metaAccountId, googleCustomerId: body.googleCustomerId });
  if (plan.kind === "refuse") return NextResponse.json({ error: plan.error }, { status: plan.status });
  if (plan.kind === "reuse") return NextResponse.json({ dashboardId: plan.dashboardId, created: false });

  // Propriétaire : l'admin qui clique. Aucun membre client n'est ajouté.
  const dashboard = await createDashboardForUser({
    userId: guard.session.userId,
    name: client.name,
    metaAccountId: plan.metaAccountId,
    googleCustomerId: plan.googleCustomerId,
  });
  return NextResponse.json({ dashboardId: dashboard.id, created: true }, { status: 201 });
}
