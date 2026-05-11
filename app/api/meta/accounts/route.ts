import { NextResponse } from "next/server";
import { getAdAccounts, getMetaSystemToken } from "@/lib/meta-api";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

const META_API_BASE = "https://graph.facebook.com/v22.0";

async function fetchAccountMeta(
  accountId: string,
  token: string,
): Promise<{ name: string; currency?: string } | null> {
  const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
  try {
    const url = new URL(`${META_API_BASE}/${id}`);
    url.searchParams.set("fields", "name,currency");
    url.searchParams.set("access_token", token);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string; currency?: string };
    if (!data.name) return null;
    return { name: data.name, currency: data.currency };
  } catch {
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
