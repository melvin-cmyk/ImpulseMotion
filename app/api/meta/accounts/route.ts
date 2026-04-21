import { NextResponse } from "next/server";
import { getAdAccounts, getMetaSystemToken } from "@/lib/meta-api";
import { requireSession } from "@/lib/auth-helpers";
import { getAllowedAccountIds } from "@/lib/acl";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  try {
    const token = getMetaSystemToken();
    const allowedIds = new Set(
      (await getAllowedAccountIds(guard.session.userId, "meta")).flatMap((id) => {
        const n = id.replace(/^act_/, "");
        return [n, `act_${n}`];
      }),
    );

    if (guard.session.role === "admin") {
      const accounts = await getAdAccounts(token);
      return NextResponse.json(accounts);
    }

    if (allowedIds.size === 0) return NextResponse.json([]);

    const all = await getAdAccounts(token);
    const filtered = all.filter((a) => allowedIds.has(a.id));
    return NextResponse.json(filtered);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
