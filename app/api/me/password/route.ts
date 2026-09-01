/** POST /api/me/password { current, next } → change the caller's password. */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  if (next.length < 10) return NextResponse.json({ error: "Le nouveau mot de passe doit faire au moins 10 caractères." }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { passwordHash: true } });
  if (!user?.passwordHash) return NextResponse.json({ error: "Compte sans mot de passe." }, { status: 400 });
  const ok = await bcrypt.compare(current, user.passwordHash);
  if (!ok) return NextResponse.json({ error: "Mot de passe actuel incorrect." }, { status: 403 });

  await prisma.user.update({ where: { id: guard.session.userId }, data: { passwordHash: await bcrypt.hash(next, 10) } });
  return NextResponse.json({ ok: true });
}
