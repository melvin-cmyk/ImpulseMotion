import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed, getAllowedAccountIds } from "@/lib/acl";
import { prisma } from "@/lib/prisma";
import { detectAccountChanges, type ChangeEvent } from "@/lib/changes";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");

  // Single-account mode: enforce ACL then return events for that account
  if (accountId) {
    if (guard.session.role !== "admin") {
      const allowed = await assertAccountAllowed(guard.session.userId, "meta", accountId);
      if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const events = await detectAccountChanges(accountId);
    return NextResponse.json({ events });
  }

  // Multi-account mode: aggregate across user's accounts (or all clients' for admin)
  let accounts: Array<{ accountId: string; label: string | null }>;
  if (guard.session.role === "admin") {
    const rows = await prisma.userAdAccount.findMany({
      where: { platform: "meta" },
      select: { accountId: true, label: true },
    });
    // De-dup by accountId (multiple admins / shared accounts)
    const seen = new Set<string>();
    accounts = rows.filter((r) => {
      if (seen.has(r.accountId)) return false;
      seen.add(r.accountId);
      return true;
    });
  } else {
    const allowedIds = await getAllowedAccountIds(guard.session.userId, "meta");
    const rows = await prisma.userAdAccount.findMany({
      where: { userId: guard.session.userId, platform: "meta" },
      select: { accountId: true, label: true },
    });
    accounts = rows.filter((r) => allowedIds.includes(r.accountId));
  }

  // Cap to 20 accounts to keep the API call bounded
  accounts = accounts.slice(0, 20);

  const results = await Promise.all(
    accounts.map(async (a) => {
      try {
        return await detectAccountChanges(a.accountId, a.label);
      } catch {
        return [] as ChangeEvent[];
      }
    }),
  );
  const events = results.flat();

  return NextResponse.json({ events, accountCount: accounts.length });
}
