import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

type Ctx = { params: Promise<{ id: string }> };
const PLATFORMS = new Set(["meta", "google", "tiktok"]);

export async function POST(req: Request, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { id: userId } = await params;
  const body = await req.json().catch(() => ({}));
  const platform = String(body.platform ?? "");
  const accountId = String(body.accountId ?? "").trim();
  const label = body.label ? String(body.label).trim() : null;

  if (!PLATFORMS.has(platform)) {
    return NextResponse.json({ error: "invalid platform" }, { status: 400 });
  }
  if (!accountId) {
    return NextResponse.json({ error: "accountId required" }, { status: 400 });
  }

  const row = await prisma.userAdAccount.upsert({
    where: { userId_platform_accountId: { userId, platform, accountId } },
    update: { label },
    create: { userId, platform, accountId, label },
  });
  return NextResponse.json({ adAccount: row });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { id: userId } = await params;
  const url = new URL(req.url);
  const rowId = url.searchParams.get("rowId");
  if (!rowId) return NextResponse.json({ error: "rowId required" }, { status: 400 });

  await prisma.userAdAccount.delete({ where: { id: rowId, userId } as never });
  return NextResponse.json({ ok: true });
}
