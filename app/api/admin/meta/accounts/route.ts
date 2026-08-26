import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAdAccounts, getMetaSystemToken } from "@/lib/meta-api";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  try {
    const token = getMetaSystemToken();
    const accounts = await getAdAccounts(token);
    const list = accounts
      .map((a) => ({
        accountId: a.id,
        name: a.name,
        currency: a.currency,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ accounts: list });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Meta API error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
