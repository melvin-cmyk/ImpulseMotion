import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  CLIENT_KEY_RE,
  parseBotSources,
  sanitizeBotSources,
  suggestClientKey,
} from "@/lib/admin-bots";

type Ctx = { params: Promise<{ dashboardId: string }> };

const dashboardSelect = {
  id: true,
  name: true,
  metaAccountId: true,
  googleCustomerId: true,
  user: { select: { email: true } },
} as const;

const botSelect = {
  id: true,
  dashboardId: true,
  enabled: true,
  name: true,
  clientKey: true,
  businessContext: true,
  sourcesJson: true,
  ingestTokenHash: true,
  lastIngestAt: true,
  lastIngestRows: true,
  createdAt: true,
  updatedAt: true,
  accesses: {
    orderBy: { createdAt: "asc" },
    select: {
      userId: true,
      createdAt: true,
      user: { select: { email: true, name: true, role: true } },
    },
  },
} satisfies Prisma.ClientBotSelect;

type BotRow = Prisma.ClientBotGetPayload<{ select: typeof botSelect }>;

function serializeBot(bot: BotRow) {
  const { ingestTokenHash, accesses, sourcesJson, ...rest } = bot;
  return {
    bot: { ...rest, sources: parseBotSources(sourcesJson) },
    accesses: accesses.map((a) => ({
      userId: a.userId,
      email: a.user.email,
      name: a.user.name,
      role: a.user.role,
      createdAt: a.createdAt,
    })),
    ingestConfigured: Boolean(ingestTokenHash),
  };
}

/** Dashboard + bot complet (sans le hash du token) + accès. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { dashboardId } = await params;
  const dashboard = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: { ...dashboardSelect, bot: { select: botSelect } },
  });
  if (!dashboard) return NextResponse.json({ error: "dashboard not found" }, { status: 404 });

  const { bot, user, ...d } = dashboard;
  return NextResponse.json({
    dashboard: { ...d, ownerEmail: user.email },
    ...(bot ? serializeBot(bot) : { bot: null, accesses: [], ingestConfigured: false }),
    suggestedClientKey: bot ? bot.clientKey : await suggestClientKey(dashboard.name),
  });
}

/** Upsert du bot : { enabled?, name?, clientKey?, businessContext?, sources? }. */
export async function PUT(req: Request, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { dashboardId } = await params;
  const dashboard = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: { id: true, name: true, bot: { select: { id: true, clientKey: true } } },
  });
  if (!dashboard) return NextResponse.json({ error: "dashboard not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: Prisma.ClientBotUpdateInput = {};

  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  if (typeof body.name === "string") {
    const name = body.name.trim().slice(0, 80);
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    data.name = name;
  }
  if (typeof body.businessContext === "string") {
    data.businessContext = body.businessContext.slice(0, 20000);
  }
  if (body.sources && typeof body.sources === "object") {
    data.sourcesJson = JSON.stringify(sanitizeBotSources(body.sources));
  }

  let clientKey: string | undefined;
  if (typeof body.clientKey === "string" && body.clientKey.trim()) {
    const key: string = body.clientKey.trim().toLowerCase();
    clientKey = key;
    if (!CLIENT_KEY_RE.test(key)) {
      return NextResponse.json(
        { error: "clientKey invalide : 2 à 40 caractères, minuscules, chiffres, - ou _" },
        { status: 400 },
      );
    }
    const taken = await prisma.clientBot.findUnique({ where: { clientKey: key }, select: { dashboardId: true } });
    if (taken && taken.dashboardId !== dashboardId) {
      return NextResponse.json({ error: "clientKey déjà utilisé par un autre client" }, { status: 409 });
    }
    data.clientKey = key;
  }

  try {
    const bot = await prisma.clientBot.upsert({
      where: { dashboardId },
      update: data,
      create: {
        dashboardId,
        enabled: typeof data.enabled === "boolean" ? data.enabled : false,
        name: typeof data.name === "string" ? data.name : "Assistant",
        clientKey: clientKey ?? (await suggestClientKey(dashboard.name)),
        businessContext: typeof data.businessContext === "string" ? data.businessContext : "",
        sourcesJson: typeof data.sourcesJson === "string" ? data.sourcesJson : "{}",
      },
      select: botSelect,
    });
    return NextResponse.json(serializeBot(bot));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "clientKey déjà utilisé par un autre client" }, { status: 409 });
    }
    throw e;
  }
}
