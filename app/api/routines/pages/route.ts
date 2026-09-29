/**
 * Pages a Meta ad account can promote — staff only, read only.
 *
 * GET ?metaAccountId=act_… → { pages: [{ id, name }], complete }
 *
 * For the form that creates a routine: the consultant picks the Facebook Page
 * in a list instead of giving its id to the AI. The account is checked
 * against the person's scope, as everywhere else.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { cleanMetaMessage, isMetaWriteError, listPromotablePages } from "@/lib/meta-write";
import { META_ACCOUNT_INVALID, isMetaAccountId } from "@/lib/routines/accounts";
import { bindingOutOfScope, getAccountScope } from "@/lib/scope";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const metaAccountId = new URL(req.url).searchParams.get("metaAccountId")?.trim() ?? "";
  if (!isMetaAccountId(metaAccountId)) return NextResponse.json({ error: META_ACCOUNT_INVALID }, { status: 400 });
  const scope = await getAccountScope(guard.session);
  if (bindingOutOfScope(scope, { metaAccountId, googleCustomerId: null })) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const { pages, complete } = await listPromotablePages(metaAccountId);
    return NextResponse.json({ pages, complete }, { headers: NO_STORE });
  } catch (e) {
    // Meta said no (400) or could not be reached (502); the message is already cleaned of any token.
    const refused = isMetaWriteError(e) && e.kind === "refused";
    return NextResponse.json({ error: cleanMetaMessage(e), pages: [] }, { status: refused ? 400 : 502, headers: NO_STORE });
  }
}
