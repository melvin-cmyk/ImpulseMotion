/**
 * History of a routine — whoever has access to the routines (lib/routines/access.ts).
 *
 * GET ?page=1&pageSize=20 → { runs, total, page, pageSize, pages }, most recent
 * first, dry runs and missed runs included.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRoutinesAccess } from "@/lib/routines/access";
import { listRuns, routineForSession, runView } from "@/lib/routines/store";

const NO_STORE = { "Cache-Control": "no-store" };
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function whole(value: string | null, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRoutinesAccess();
  if ("error" in guard) return guard.error;
  const found = await routineForSession(guard.session, (await params).id);
  if (found.status !== 200) return NextResponse.json({ error: found.status === 403 ? "forbidden" : "not found" }, { status: found.status });

  const query = new URL(req.url).searchParams;
  const page = whole(query.get("page"), 1, 10_000);
  const pageSize = whole(query.get("pageSize"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const { runs, total } = await listRuns(found.routine.id, { page, pageSize });
  return NextResponse.json(
    { runs: runs.map(runView), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) },
    { headers: NO_STORE },
  );
}
