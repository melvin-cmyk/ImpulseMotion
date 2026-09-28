/**
 * GET   /api/admin/auto-alerts            → clients, their Slack link, settings, open incidents
 * PATCH /api/admin/auto-alerts            → { dashboardId, slackChannel?, slackChannelId?, autoAlerts?, config? }
 * POST  /api/admin/auto-alerts            → { action: "suggest" | "connect" | "test" | "scan", dashboardId?, dryRun? }
 *
 * Staff only. A consultant sees and edits the clients assigned to them.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, googleInScope, metaInScope, type AccountScope } from "@/lib/scope";
import { groupDashboardsByAccount } from "@/lib/portfolio";
import { FREQUENCIES, TOPICS, normalizeConfig, parseConfig } from "@/lib/auto-alerts/config";
import { autoAlertWebhook, cleanChannel, joinChannel, linkStatus, listClientChannels, matchChannels, postDigest, type SlackChannel } from "@/lib/auto-alerts/slack";
import { matchWithAi } from "@/lib/auto-alerts/match-ai";
import { runAutoAlerts } from "@/lib/auto-alerts/run";

export const maxDuration = 300;

const SELECT = {
  id: true, name: true, metaAccountId: true, googleCustomerId: true, createdAt: true,
  slackChannel: true, slackChannelId: true, autoAlerts: true, autoAlertConfig: true,
} as const;

const CHANNEL_ID_RE = /^[CG][A-Z0-9]{8,}$/;

async function loadGroups(scope: AccountScope) {
  const rows = await prisma.dashboard.findMany({ select: SELECT });
  const { groups } = groupDashboardsByAccount(rows);
  return groups.filter((g) => scope.all || metaInScope(scope, g.metaAccountId) || googleInScope(scope, g.googleCustomerId));
}

type Group = Awaited<ReturnType<typeof loadGroups>>[number];
const linkedOf = (g: Group) => g.members.find((m) => m.slackChannelId || m.slackChannel) ?? null;
const linkOf = (g: Group, channels: SlackChannel[]) => {
  const linked = linkedOf(g);
  return linkStatus({ slackChannel: linked?.slackChannel ?? null, slackChannelId: linked?.slackChannelId ?? null }, channels);
};

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
  const groups = await loadGroups(await getAccountScope(guard.session));
  const [slack, incidents] = await Promise.all([
    channelsOrError(),
    prisma.autoIncident.findMany({
      where: { dashboardId: { in: groups.map((g) => g.primary.id) }, status: "open" },
      orderBy: { firstSeenAt: "desc" },
      select: { id: true, dashboardId: true, kind: true, platform: true, severity: true, title: true, detail: true, firstSeenAt: true, lastSeenAt: true, notifiedAt: true, notifyError: true },
    }),
  ]);
  const taken = new Set<string>();
  const clients = groups.map((g) => {
    const linked = linkedOf(g);
    const link = slack.error
      ? { status: linked ? ("unknown" as const) : ("none" as const), channel: null }
      : linkOf(g, slack.channels);
    if (link.channel) taken.add(link.channel.id);
    return {
      dashboardId: g.primary.id,
      name: g.primary.name,
      meta: !!g.metaAccountId,
      google: !!g.googleCustomerId,
      enabled: g.members.every((m) => m.autoAlerts),
      slackChannel: linked?.slackChannel ?? null,
      slackChannelId: linked?.slackChannelId ?? null,
      slackStatus: link.status,
      slackPrivate: link.channel?.isPrivate ?? null,
      config: parseConfig(g.primary.autoAlertConfig),
      incidents: incidents.filter((i) => i.dashboardId === g.primary.id),
    };
  });
  return NextResponse.json({
    clients,
    slack: { ok: !slack.error, error: slack.error, total: slack.channels.length, free: slack.channels.filter((c) => !taken.has(c.id)) },
    topics: TOPICS.map(({ id, label, hint }) => ({ id, label, hint })),
    frequencies: FREQUENCIES,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const groups = await loadGroups(await getAccountScope(guard.session));
  const g = groups.find((x) => x.dashboardIds.includes(String(body.dashboardId ?? "")));
  if (!g) return NextResponse.json({ error: "client introuvable" }, { status: 404 });

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

  // One client = every dashboard of the group: they must not disagree.
  await prisma.dashboard.updateMany({ where: { id: { in: g.dashboardIds } }, data });
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const groups = await loadGroups(await getAccountScope(guard.session));
  const one = () => groups.find((x) => x.dashboardIds.includes(String(body.dashboardId ?? "")));

  if (action === "suggest") {
    const slack = await channelsOrError();
    if (slack.error) return NextResponse.json({ error: slack.error }, { status: 502 });
    const todo = groups.filter((g) => !linkedOf(g)).map((g) => ({ id: g.primary.id, name: g.primary.name }));
    const used = new Set(groups.map((g) => linkOf(g, slack.channels).channel?.id).filter(Boolean));
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
        ...matches.map((m) => ({ dashboardId: m.clientId, client: name(m.clientId), channel: m.channel, by: m.confidence === "exact" ? "nom identique" : "nom proche" })),
        ...ai.map((m) => ({ dashboardId: m.clientId, client: name(m.clientId), channel: m.channel, by: "proposé par l'IA" })),
      ],
      aiError,
    });
  }

  if (action === "connect" || action === "test") {
    const g = one();
    if (!g) return NextResponse.json({ error: "client introuvable" }, { status: 404 });
    const linked = linkedOf(g);
    if (!linked) return NextResponse.json({ error: "aucun canal Slack choisi pour ce client" }, { status: 400 });
    const slack = await channelsOrError();
    if (slack.error) return NextResponse.json({ error: slack.error }, { status: 502 });
    const link = linkOf(g, slack.channels);
    if (!link.channel) return NextResponse.json({ error: slackHint("channel_not_found") }, { status: 409 });
    try {
      if (action === "connect") {
        if (link.channel.isPrivate && !link.channel.isMember) return NextResponse.json({ error: slackHint("is_private") }, { status: 409 });
        if (!link.channel.isMember) await joinChannel(link.channel.id);
      } else {
        await postDigest(link.channel.id, `:white_check_mark: *${g.primary.name}* — test des alertes automatiques ImpulseMotion. Les prochaines alertes de ce client arriveront ici.`, { id: g.primary.id, name: g.primary.name });
      }
    } catch (e) {
      return NextResponse.json({ error: slackHint(e instanceof Error ? e.message : String(e)) }, { status: 502 });
    }
    if (linked.slackChannelId !== link.channel.id) {
      await prisma.dashboard.updateMany({ where: { id: { in: g.dashboardIds } }, data: { slackChannelId: link.channel.id, slackChannel: `#${link.channel.name}` } });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "scan") {
    const g = body.dashboardId ? one() : null;
    if (body.dashboardId && !g) return NextResponse.json({ error: "client introuvable" }, { status: 404 });
    const result = await runAutoAlerts({
      dryRun: body.dryRun === true,
      dashboardIds: g ? [g.primary.id] : groups.map((x) => x.primary.id),
      deadlineAt: Date.now() + 270_000,
    });
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "action inconnue" }, { status: 400 });
}
