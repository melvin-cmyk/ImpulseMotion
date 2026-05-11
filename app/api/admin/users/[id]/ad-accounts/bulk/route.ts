import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

type Ctx = { params: Promise<{ id: string }> };
const PLATFORMS = new Set(["meta", "google", "tiktok"]);

interface BulkAccount {
  accountId: string;
  label?: string | null;
}

export async function POST(req: Request, { params }: Ctx) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const { id: userId } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    platform?: string;
    accounts?: BulkAccount[];
  };

  const platform = String(body.platform ?? "");
  if (!PLATFORMS.has(platform)) {
    return NextResponse.json({ error: "invalid platform" }, { status: 400 });
  }
  if (!Array.isArray(body.accounts) || body.accounts.length === 0) {
    return NextResponse.json({ error: "accounts[] required" }, { status: 400 });
  }

  const seen = new Set<string>();
  const data = body.accounts
    .map((a) => ({
      accountId: String(a?.accountId ?? "").trim(),
      label: a?.label ? String(a.label).trim() : null,
    }))
    .filter((a) => {
      if (!a.accountId) return false;
      if (seen.has(a.accountId)) return false;
      seen.add(a.accountId);
      return true;
    })
    .map((a) => ({
      userId,
      platform,
      accountId: a.accountId,
      label: a.label,
    }));

  if (data.length === 0) {
    return NextResponse.json({ created: 0, skipped: 0 });
  }

  const result = await prisma.userAdAccount.createMany({
    data,
    skipDuplicates: true,
  });

  return NextResponse.json({
    created: result.count,
    skipped: data.length - result.count,
  });
}
