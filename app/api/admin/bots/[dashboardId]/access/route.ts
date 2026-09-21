import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { addDashboardMember, MemberError } from "@/lib/dashboard-members";

type Ctx = { params: Promise<{ dashboardId: string }> };

/**
 * Donne accès au bot par email, à un CLIENT du dashboard uniquement (il y est
 * rattaché au passage). Email inconnu → login "client" créé, mot de passe
 * temporaire renvoyé UNE fois.
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { dashboardId } = await params;
  const bot = await prisma.clientBot.findUnique({ where: { dashboardId }, select: { id: true } });
  if (!bot) {
    return NextResponse.json({ error: "bot non configuré : enregistrez d'abord le bot" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = body.name ? String(body.name).trim().slice(0, 120) : null;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  // Same silo as the dashboard: the bot is only ever granted to a CLIENT
  // attached to this dashboard — granting it attaches them (and creates the
  // login with a temp password when the email is unknown).
  let added;
  try {
    added = await addDashboardMember({ dashboardId, email, role: "client", name });
  } catch (e) {
    if (e instanceof MemberError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const user = added.member.user;
  const { created, tempPassword } = added;

  const access = await prisma.clientBotAccess.upsert({
    where: { botId_userId: { botId: bot.id, userId: user.id } },
    update: {},
    create: { botId: bot.id, userId: user.id, grantedById: guard.session.userId },
    select: { id: true, botId: true, userId: true, createdAt: true },
  });

  return NextResponse.json({ access, user, created, ...(tempPassword ? { tempPassword } : {}) });
}
