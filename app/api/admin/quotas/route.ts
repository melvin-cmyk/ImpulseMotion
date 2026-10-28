/**
 * Admin quotas (lib/quotas.ts).
 *   GET → { quotas, today: { team, user } }
 *   PUT { teamDailyUsd?, userDailyUsd?, teamDailyImages?, botDailyMessages?, warnAtPct? } → { quotas }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { readQuotas, spentToday, writeQuotas, type Quotas } from "@/lib/quotas";

const FIELDS: Array<keyof Quotas> = ["teamDailyUsd", "userDailyUsd", "teamDailyImages", "botDailyMessages", "warnAtPct"];

export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const [quotas, today] = await Promise.all([readQuotas(), spentToday(guard.session.userId)]);
  return NextResponse.json({ quotas, today }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Partial<Quotas> = {};
  for (const f of FIELDS) {
    const v = body[f];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) patch[f] = v;
    else if (typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(",", ".")))) patch[f] = Math.max(0, Number(v.replace(",", ".")));
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: "Rien à enregistrer." }, { status: 400 });
  const quotas = await writeQuotas(patch, guard.session.user?.email ?? guard.session.userId);
  return NextResponse.json({ quotas });
}
