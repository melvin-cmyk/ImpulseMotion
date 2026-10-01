/**
 * GET   /api/admin/auto-alerts            → clients, their accounts, Slack link, settings, open incidents
 * PATCH /api/admin/auto-alerts            → { clientId, slackChannel?, slackChannelId?, autoAlerts?, config? }
 * POST  /api/admin/auto-alerts            → { action: "suggest" | "connect" | "test" | "scan" | "sync", clientId?, dryRun? }
 *
 * Staff only. A consultant sees and edits the clients that have an account assigned to them.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { FREQUENCIES, TOPICS, normalizeConfig, parseConfig } from "@/lib/auto-alerts/config";
import { autoAlertWebhook, cleanChannel, joinChannel, linkStatus, listClientChannels, matchChannels, postDigest, type SlackChannel } from "@/lib/auto-alerts/slack";
import { matchWithAi } from "@/lib/auto-alerts/match-ai";
import { runAutoAlerts } from "@/lib/auto-alerts/run";
import { loadAlertClients, syncAlertClients, type StoredClient } from "@/lib/auto-alerts/clients";

export const maxDuration = 300;

const CHANNEL_ID_RE = /^[CG][A-Z0-9]{8,}$/;

const isLinked = (c: StoredClient) => !!(c.slackChannelId || c.slackChannel);
const linkOf = (c: StoredClient, channels: SlackChannel[]) => linkStatus({ slackChannel: c.slackChannel, slackChannelId: c.slackChannelId }, channels);

/** Slack explains a refusal with a code; the page needs a sentence. */
function slackHint(error: string): string {
  if (/missing_scope/.test(error)) return "Il manque un droit à l'application Slack (channels:read, groups:read ou channels:join) : ajoutez-le puis réinstallez l'application.";
  if (/not_in_channel|channel_not_found/.test(error)) return "Le bot ne voit pas ce canal. S'il est privé, tapez /invite @BotAds dans le canal, puis « Vérifier ».";
  if (/method_not_supported_for_channel_type|is_private/.test(error)) return "Canal privé : Slack n'autorise pas un bot à y entrer seul. Tapez /invite @BotAds dans le canal, puis « Vérifier ».";
  if (/is_archived/.test(error)) return "Ce canal est archivé.";
  return error;
}

async function channelsOrError(): Promise<{ channels: SlackChannel[]; error: string | null }> {
  if (!autoAlertWebhook()) return { channels: [], error: "Webhook n8n non configuré (N8N_ALERT_WEBHOOK_URL)." };
  try {
    return { channels: await listClientChannels("c_"), error: null };
  } catch (e) {
    return { channels: [], error: slackHint(e instanceof Error ? e.message : String(e)) };
  }
}

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const clients = await loadAlertClients(await getAccountScope(guard.session));
  const [slack, incidents] = await Promise.all([
    channelsOrError(),
    prisma.autoIncident.findMany({
      where: { clientId: { in: clients.map((c) => c.id) }, status: "open" },
      orderBy: { firstSeenAt: "desc" },
      select: { id: true, clientId: true, kind: true, platform: true, severity: true, title: true, detail: true, firstSeenAt: true, lastSeenAt: true, notifiedAt: true, notifyError: true },
    }),
  ]);
  const taken = new Set<string>();
  const rows = clients.map((c) => {
    const link = slack.error
      ? { status: isLinked(c) ? ("unknown" as const) : ("none" as const), channel: null }
      : linkOf(c, slack.channels);
    if (link.channel) taken.add(link.channel.id);
    return {
      clientId: c.id,
      name: c.name,
      accounts: c.accounts.map((a) => ({ platform: a.platform, accountId: a.accountId, name: a.name })),
      meta: c.accounts.some((a) => a.platform === "meta"),
      google: c.accounts.some((a) => a.platform === "google"),
      tiktok: c.accounts.some((a) => a.platform === "tiktok"),
      enabled: c.autoAlerts,
      dormant: c.dormant,
      lastScanAt: c.lastScanAt,
      slackChannel: c.slackChannel,
      slackChannelId: c.slackChannelId,
      slackStatus: link.status,
      slackPrivate: link.channel?.isPrivate ?? null,
      config: parseConfig(c.autoAlertConfig),
      incidents: incidents.filter((i) => i.clientId === c.id),
    };
  });
  return NextResponse.json({
    clients: rows,
    slack: { ok: !slack.error, error: slack.error, total: slack.channels.length, free: slack.channels.filter((c) => !taken.has(c.id)) },
    topics: TOPICS.map(({ id, label, hint }) => ({ id, label, hint })),
    frequencies: FREQUENCIES,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const clients = await loadAlertClients(await getAccountScope(guard.session));
  const c = clients.find((x) => x.id === String(body.clientId ?? ""));
  if (!c) return NextResponse.json({ error: "client introuvable" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if ("slackChannel" in body) {
    if (body.slackChannel === null || body.slackChannel === "") {
      data.slackChannel = null;
      data.slackChannelId = null;
    } else {
      const ch = cleanChannel(body.slackChannel);
      if (!ch) return NextResponse.json({ error: "canal Slack invalide (ex. c_client)" }, { status: 400 });
      const id = typeof body.slackChannelId === "string" && CHANNEL_ID_RE.test(body.slackChannelId) ? body.slackChannelId : null;
      data.slackChannel = ch;
      data.slackChannelId = id ?? (CHANNEL_ID_RE.test(ch) ? ch : null);
    }
  }
  if (typeof body.autoAlerts === "boolean") data.autoAlerts = body.autoAlerts;
  if (body.config !== undefined) data.autoAlertConfig = JSON.stringify(normalizeConfig(body.config));
  if (!Object.keys(data).length) return NextResponse.json({ error: "rien à modifier" }, { status: 400 });

  await prisma.alertClient.update({ where: { id: c.id }, data });
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "sync") {
    // Reads the platforms again: new accounts, renamed accounts, new clients of the sheet.
    try {
      return NextResponse.json(await syncAlertClients());
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  const clients = await loadAlertClients(await getAccountScope(guard.session));
  const one = () => clients.find((x) => x.id === String(body.clientId ?? ""));

  if (action === "suggest") {
    const slack = await channelsOrError();
    if (slack.error) return NextResponse.json({ error: slack.error }, { status: 502 });
    const todo = clients.filter((c) => !isLinked(c)).map((c) => ({ id: c.id, name: c.name }));
    const used = new Set(clients.map((c) => linkOf(c, slack.channels).channel?.id).filter(Boolean));
    const free = slack.channels.filter((c) => !used.has(c.id));
    const { matches, unmatched } = matchChannels(todo, free);
    let ai: typeof matches = [];
    let aiError: string | null = null;
    const left = free.filter((c) => !matches.some((m) => m.channel.id === c.id));
    if (unmatched.length && left.length && body.ai !== false) {
      try {
        ai = await matchWithAi(unmatched, left, { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "consultant" });
      } catch (e) {
        aiError = e instanceof Error ? e.message : String(e);
      }
    }
    const name = (id: string) => todo.find((t) => t.id === id)?.name ?? id;
    return NextResponse.json({
      suggestions: [
        ...matches.map((m) => ({ clientId: m.clientId, client: name(m.clientId), channel: m.channel, by: m.confidence === "exact" ? "nom identique" : "nom proche" })),
        ...ai.map((m) => ({ clientId: m.clientId, client: name(m.clientId), channel: m.channel, by: "proposé par l'IA" })),
      ],
      aiError,
    });
  }

  if (action === "connect" || action === "test") {
    const c = one();
    if (!c) return NextResponse.json({ error: "client introuvable" }, { status: 404 });
    if (!isLinked(c)) return NextResponse.json({ error: "aucun canal Slack choisi pour ce client" }, { status: 400 });
    const slack = await channelsOrError();
    if (slack.error) return NextResponse.json({ error: slack.error }, { status: 502 });
    const link = linkOf(c, slack.channels);
    if (!link.channel) return NextResponse.json({ error: slackHint("channel_not_found") }, { status: 409 });
    try {
      if (action === "connect") {
        if (link.channel.isPrivate && !link.channel.isMember) return NextResponse.json({ error: slackHint("is_private") }, { status: 409 });
        if (!link.channel.isMember) await joinChannel(link.channel.id);
      } else {
        await postDigest(link.channel.id, `:white_check_mark: *${c.name}* — test des alertes automatiques ImpulseMotion. Les prochaines alertes de ce client arriveront ici.`, { id: c.id, name: c.name });
      }
    } catch (e) {
      return NextResponse.json({ error: slackHint(e instanceof Error ? e.message : String(e)) }, { status: 502 });
    }
    if (c.slackChannelId !== link.channel.id) {
      await prisma.alertClient.update({ where: { id: c.id }, data: { slackChannelId: link.channel.id, slackChannel: `#${link.channel.name}` } });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "scan") {
    const c = body.clientId ? one() : null;
    if (body.clientId && !c) return NextResponse.json({ error: "client introuvable" }, { status: 404 });
    if (!c && !clients.length) return NextResponse.json({ error: "aucun client à vérifier" }, { status: 404 });
    const result = await runAutoAlerts({
      dryRun: body.dryRun === true,
      clientIds: c ? [c.id] : clients.map((x) => x.id),
      deadlineAt: Date.now() + 270_000,
    });
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "action inconnue" }, { status: 400 });
}
