import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireRealAdmin } from "@/lib/auth-helpers";
import { BCRYPT_COST, MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await requireRealAdmin();
  if ("error" in guard) return guard.error;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};

  if (typeof body.name === "string") data.name = body.name.trim() || null;
  if (body.role === "admin" || body.role === "consultant" || body.role === "client") {
    if (body.role !== "admin" && id === guard.session.userId) {
      return NextResponse.json({ error: "cannot demote self" }, { status: 400 });
    }
    data.role = body.role;
  }
  if (typeof body.password === "string") {
    if (body.password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.` }, { status: 400 });
    }
    data.passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
    data.passwordChangedAt = new Date(); // the person's other sessions end
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, email: true, name: true, role: true },
  });
  return NextResponse.json({ user });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await requireRealAdmin();
  if ("error" in guard) return guard.error;

  const { id } = await params;
  if (id === guard.session.userId) {
    return NextResponse.json({ error: "cannot delete self" }, { status: 400 });
  }
  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
