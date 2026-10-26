/** POST /api/me/password { current, next } → change the caller's password. */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { BCRYPT_COST, MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  if (next.length < MIN_PASSWORD_LENGTH) return NextResponse.json({ error: `Le nouveau mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.` }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { passwordHash: true } });
  if (!user?.passwordHash) return NextResponse.json({ error: "Compte sans mot de passe." }, { status: 400 });
  const ok = await bcrypt.compare(current, user.passwordHash);
  if (!ok) return NextResponse.json({ error: "Mot de passe actuel incorrect." }, { status: 403 });

  // The change signs the other sessions of the account out (auth.ts compares passwordChangedAt to the token).
  await prisma.user.update({ where: { id: guard.session.userId }, data: { passwordHash: await bcrypt.hash(next, BCRYPT_COST), passwordChangedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
