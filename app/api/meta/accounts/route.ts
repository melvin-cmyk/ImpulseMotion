import { NextResponse } from "next/server";
import { getAdAccounts, getAccountProfile, getMetaSystemToken } from "@/lib/meta-api";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

async function fetchAccountMeta(
  accountId: string,
  token: string,
): Promise<{ name: string; currency?: string } | null> {
  // Goes through the Graph limiter/retry (lib/meta-api). Unreachable accounts
  // (permission/auth errors) are flagged outOfScope by the caller.
  try {
    const p = await getAccountProfile(token, accountId);
    return { name: p.name, currency: p.currency || undefined };
  } catch (err) {
    console.warn(`[meta/accounts] profile unavailable for ${accountId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  try {
    const token = getMetaSystemToken();

    if (guard.session.role === "admin") {
      const accounts = await getAdAccounts(token);
      return NextResponse.json(accounts);
    }

    // Non-admin: UserAdAccount is the source of truth, not /me/adaccounts.
    // Enrich each row with live Meta metadata in parallel; rows whose
    // metadata can't be fetched are still returned (outOfScope: true) so the
    // user sees the full ACL list and the UI can flag unreachable ones.
    const rows = await prisma.userAdAccount.findMany({
      where: { userId: guard.session.userId, platform: "meta" },
      select: { accountId: true, label: true },
    });

    if (rows.length === 0) return NextResponse.json([]);

    const enriched = await Promise.all(
      rows.map(async (row) => {
        const meta = await fetchAccountMeta(row.accountId, token);
        const id = row.accountId.startsWith("act_") ? row.accountId : `act_${row.accountId}`;
        return {
          id,
          name: meta?.name ?? row.label ?? id,
          currency: meta?.currency,
          outOfScope: !meta,
        };
      }),
    );

    return NextResponse.json(enriched);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
