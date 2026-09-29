/**
 * Items of a routine that a person has to look at — staff only.
 *
 * GET → { items } : the items whose outcome is unknown (« à vérifier ») and
 *       those given up after their attempts, most recent first. What the
 *       list « Lignes à vérifier » of the routine shows.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { itemsToCheck, routineForSession } from "@/lib/routines/store";
import { splitItemKey } from "@/lib/routines/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const found = await routineForSession(guard.session, (await params).id);
  if (found.status !== 200) return NextResponse.json({ error: found.status === 403 ? "forbidden" : "not found" }, { status: found.status });
  const items = (await itemsToCheck(found.routine.id)).map((item) => ({ ...item, ...splitItemKey(item.itemKey) }));
  return NextResponse.json({ items }, { headers: NO_STORE });
}
