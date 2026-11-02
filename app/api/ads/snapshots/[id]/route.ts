/** DELETE /api/ads/snapshots/:id — revokes a public share link (the page answers « lien révoqué »). Staff only. */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { revokeSnapshot } from "@/lib/ads-warehouse/snapshots";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  try {
    return NextResponse.json(await revokeSnapshot(id));
  } catch {
    return NextResponse.json({ error: "lien inconnu" }, { status: 404 });
  }
}
