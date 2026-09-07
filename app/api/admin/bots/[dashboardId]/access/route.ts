import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { generateTempPassword } from "@/lib/temp-password";

type Ctx = { params: Promise<{ dashboardId: string }> };

/**
 * Donne accès au bot par email. Utilisateur inconnu → créé en role "client"
 * avec un mot de passe temporaire renvoyé UNE fois (même mécanique que POST /api/admin/users).
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

  let user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true },
  });
  let tempPassword: string | undefined;
  let created = false;

  if (!user) {
    tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    user = await prisma.user.create({
      data: { email, name, role: "client", passwordHash },
      select: { id: true, email: true, name: true, role: true },
    });
    created = true;
  }

  const access = await prisma.clientBotAccess.upsert({
    where: { botId_userId: { botId: bot.id, userId: user.id } },
    update: {},
    create: { botId: bot.id, userId: user.id, grantedById: guard.session.userId },
    select: { id: true, botId: true, userId: true, createdAt: true },
  });

  return NextResponse.json({ access, user, created, ...(tempPassword ? { tempPassword } : {}) });
}
