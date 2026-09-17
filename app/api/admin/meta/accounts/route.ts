import { NextResponse } from "next/server";
import { getAdAccountsCached } from "@/lib/insights";
import { requireStaff } from "@/lib/auth-helpers";
import { getMetaSystemToken } from "@/lib/meta-api";
import { getAccountScope, metaInScope } from "@/lib/scope";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  // This is the whole business manager behind a shared System User token —
  // a consultant gets the accounts an admin assigned them, not the catalogue.
  const scope = await getAccountScope(guard.session);

  try {
    const token = getMetaSystemToken();
    const accounts = await getAdAccountsCached(token);
    const list = accounts
      .filter((a) => metaInScope(scope, a.id))
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
