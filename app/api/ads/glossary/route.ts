/**
 * POST /api/ads/glossary — Motion's Glossary on the selected client's accounts.
 * Same body and scope rules as /api/ads/query, plus { action }:
 *   list                                   → { categories }
 *   rename { key, from, to }               → rename / merge a value everywhere
 *   remove { key, value }                  → remove a value (not « Type d'asset »)
 *   set    { key, adIds, value|null }      → one creative's category (all its ads)
 * Staff only (parseScopedQuery); edits touch only the accounts in scope.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { cleanMulti, cleanValue, isGlossaryKey, listGlossary, renameValue, setCreativeTag } from "@/lib/ads-warehouse/glossary";
import { GLOSSARY_REQUIRED } from "@/lib/ads-warehouse/glossary-labels";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const b = (await req.clone().json().catch(() => ({}))) as { action?: string; key?: string; from?: string; to?: string; value?: string | null; adIds?: unknown };
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  const q = parsed.q;
  const action = b.action ?? "list";
  if (action === "list") return NextResponse.json({ categories: await listGlossary(q) }, { headers: { "Cache-Control": "private, no-store" } });
  if (!isGlossaryKey(b.key)) return NextResponse.json({ error: "catégorie inconnue" }, { status: 400 });
  const key = b.key;
  if (action === "rename") {
    const from = cleanValue(b.from), to = cleanValue(b.to);
    if (!from || !to) return NextResponse.json({ error: "valeurs attendues" }, { status: 400 });
    return NextResponse.json({ changed: await renameValue(q, key, from, to) });
  }
  if (action === "remove") {
    if (GLOSSARY_REQUIRED.includes(key)) return NextResponse.json({ error: "« Type d'asset » ne peut pas être retiré : renomme-le plutôt." }, { status: 400 });
    const value = cleanValue(b.value);
    if (!value) return NextResponse.json({ error: "valeur attendue" }, { status: 400 });
    return NextResponse.json({ changed: await renameValue(q, key, value, null) });
  }
  if (action === "set") {
    const value = b.value === null || b.value === "" ? null : cleanMulti(b.value);
    if (!value && GLOSSARY_REQUIRED.includes(key)) return NextResponse.json({ error: "« Type d'asset » est obligatoire." }, { status: 400 });
    const adIds = Array.isArray(b.adIds) ? b.adIds.map(String) : [];
    return NextResponse.json({ changed: await setCreativeTag(q, adIds, key, value) });
  }
  return NextResponse.json({ error: "action inconnue" }, { status: 400 });
}
