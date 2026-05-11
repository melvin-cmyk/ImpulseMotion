import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const rows = await prisma.userAdAccount.findMany({
    where: { userId: guard.session.userId },
    select: { platform: true, accountId: true, label: true },
    orderBy: { label: "asc" },
  });
  return NextResponse.json({ accounts: rows });
}
