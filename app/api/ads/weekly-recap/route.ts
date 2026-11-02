/**
 * POST /api/ads/weekly-recap { clientId, send? } — the weekly creative recap of
 * one client: preview (text + Slack channel), or posted in its channel when a
 * consultant asks for it (send: true). Staff only, client in scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { clientInScope, parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { buildRecap } from "@/lib/weekly-recap";
import { postDigest } from "@/lib/auto-alerts/slack";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const b = (await req.json().catch(() => ({}))) as { clientId?: string; send?: boolean };
  const client = b.clientId ? await prisma.alertClient.findUnique({ where: { id: String(b.clientId) }, select: { id: true, name: true, accountsJson: true, slackChannel: true, slackChannelId: true } }) : null;
  if (!client) return NextResponse.json({ error: "client sans fiche d'alertes" }, { status: 404 });
  const scope = await getAccountScope(guard.session);
  if (!clientInScope(scope, parseAlertAccounts(client.accountsJson))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { text, reason } = await buildRecap(client);
  if (!b.send) return NextResponse.json({ text, reason: reason ?? null, channel: client.slackChannel, canSend: !!client.slackChannelId && !!text });
  if (!text) return NextResponse.json({ error: reason ?? "rien à envoyer" }, { status: 400 });
  if (!client.slackChannelId) return NextResponse.json({ error: "aucun salon Slack rattaché à ce client (Admin › Alertes)" }, { status: 400 });
  try {
    await postDigest(client.slackChannelId, text, { id: client.id, name: client.name });
    return NextResponse.json({ sent: true, channel: client.slackChannel });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Envoi impossible" }, { status: 502 });
  }
}
