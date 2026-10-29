/**
 * Playbook d'une marque (staff) — study a brand's ads in the Meta Ad Library (lib/creas/playbook.ts).
 *   GET  ?brand=&country=        → { playbook | null } : the cached study (7 days)
 *   POST { brand, country?, limit? (18, ≤ 30), fresh? } → { playbook } : search (15-20 s) + one AI reading per ad
 *        (Sonnet low, 3 at a time: 1 to 2 minutes for 18 ads) → formats, verdict polyvalent / spécifique, Markdown.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { PlaybookError, cachedPlaybook, studyBrand } from "@/lib/creas/playbook";

export const maxDuration = 300;
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const brand = (req.nextUrl.searchParams.get("brand") ?? "").trim();
  if (brand.length < 2) return NextResponse.json({ error: "Marque manquante." }, { status: 400 });
  return NextResponse.json({ playbook: await cachedPlaybook(brand, req.nextUrl.searchParams.get("country") ?? "FR") }, NO_STORE);
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const playbook = await studyBrand({
      brand: typeof body.brand === "string" ? body.brand : "", country: typeof body.country === "string" ? body.country : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined, fresh: body.fresh === true,
      user: { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "" },
    });
    return NextResponse.json({ playbook }, NO_STORE);
  } catch (e) {
    if (e instanceof PlaybookError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
